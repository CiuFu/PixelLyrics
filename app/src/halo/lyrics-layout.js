'use strict';

const { TEXT_MAX_BYTES } = require('./constants');

// Device-tested visual capacity. This is deliberately separate from the
// UTF-8 byte and 64-byte HID frame limits in packets.js.
const DISPLAY_WIDTH_UNITS = 32;
const UTF8_BYTE_BUDGET = TEXT_MAX_BYTES;

let cachedSegmenter = null;

function getGraphemeSegmenter() {
  if (cachedSegmenter) return cachedSegmenter;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      cachedSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
    } catch (_error) {
      cachedSegmenter = null;
    }
  }
  return cachedSegmenter;
}

function segmentGraphemes(value) {
  const text = String(value == null ? '' : value);
  const segmenter = getGraphemeSegmenter();
  if (segmenter) {
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  // Fallback: keep code points together with combining marks, variation
  // selectors, emoji modifiers, and ZWJ-linked sequences.
  const result = [];
  let current = '';
  let regionalIndicator = false;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    const joinCurrent =
      !current ||
      isMark(character) ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
      current.endsWith('\u200d') ||
      (regionalIndicator && codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff);
    if (!joinCurrent) {
      result.push(current);
      current = '';
    }
    current += character;
    regionalIndicator = codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff && !regionalIndicator;
  }
  if (current) result.push(current);
  return result;
}

function normalizeLyricText(value) {
  // Newlines, tabs, and all other whitespace become safe half-width spaces;
  // the device does not implement a real text newline.
  return String(value == null ? '' : value)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function codePointIsWide(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0x31a0 && codePoint <= 0x31bf) ||
    (codePoint >= 0x3200 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3ffff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff)
  );
}

function isMark(character) {
  try {
    return /\p{M}/u.test(character);
  } catch (_error) {
    return false;
  }
}

function isExtendedPictographic(character) {
  try {
    return /\p{Extended_Pictographic}/u.test(character);
  } catch (_error) {
    return false;
  }
}

function graphemeWidth(grapheme) {
  const text = String(grapheme == null ? '' : grapheme);
  if (!text) return 0;

  // Keep emoji sequences intact as one grapheme and use the conservative
  // device estimate requested for this version.
  if (
    text.includes('\uFE0F') ||
    text.includes('\u20E3') ||
    Array.from(text).some((character) => isExtendedPictographic(character))
  ) {
    return 2;
  }

  let hasBase = false;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x200d || isMark(character)) continue;
    hasBase = true;
    if (codePointIsWide(codePoint)) return 2;
  }
  return hasBase ? 1 : 0;
}

function displayWidth(value) {
  return segmentGraphemes(value).reduce((total, grapheme) => total + graphemeWidth(grapheme), 0);
}

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value == null ? '' : value), 'utf8');
}

function fitsDisplay(text, widthBudget, byteBudget) {
  return displayWidth(text) <= widthBudget && utf8ByteLength(text) <= byteBudget;
}

function fitsWithoutScroll(text, widthBudget, byteBudget) {
  const hasWideGrapheme = segmentGraphemes(text).some((grapheme) => graphemeWidth(grapheme) > 1);
  const scrollThreshold = widthBudget - (hasWideGrapheme ? 1 : 0);
  return displayWidth(text) < scrollThreshold && utf8ByteLength(text) <= byteBudget;
}

function createWindow(text) {
  return {
    text,
    width: displayWidth(text),
    utf8Bytes: utf8ByteLength(text),
    graphemeCount: segmentGraphemes(text).length
  };
}

function buildScrollUnits(normalizedText, widthBudget, byteBudget) {
  const units = [];
  const words = normalizedText.split(' ');
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    const word = words[wordIndex];
    const joinBefore = wordIndex > 0 ? ' ' : '';
    const graphemes = segmentGraphemes(word);
    const hasWideGrapheme = graphemes.some((grapheme) => graphemeWidth(grapheme) > 1);
    if (!hasWideGrapheme && fitsWithoutScroll(word, widthBudget, byteBudget)) {
      units.push({ text: word, joinBefore });
      continue;
    }

    for (let index = 0; index < graphemes.length; index += 1) {
      const grapheme = graphemes[index];
      if (!fitsDisplay(grapheme, widthBudget, byteBudget)) {
        throw new Error('A single grapheme cannot fit within the layout safety budget');
      }
      units.push({
        text: grapheme,
        joinBefore: index === 0 ? joinBefore : ''
      });
    }
  }
  return units;
}

/**
 * Build overlapping software-scroll windows.
 * Normal words advance as whole units; a token that cannot fit on one screen
 * falls back to grapheme units. This naturally gives CJK text the original
 * one-grapheme ticker while keeping space-delimited words intact.
 */
function buildScrollWindows(value, options = {}) {
  const normalizedText = normalizeLyricText(value);
  const widthBudget = Number.isFinite(options.displayWidthUnits)
    ? Math.max(1, Math.floor(options.displayWidthUnits))
    : DISPLAY_WIDTH_UNITS;
  const byteBudget = Number.isFinite(options.utf8ByteBudget)
    ? Math.max(1, Math.floor(options.utf8ByteBudget))
    : UTF8_BYTE_BUDGET;

  if (!normalizedText) {
    return {
      normalizedText: '',
      windows: [],
      windowCount: 0,
      displayWidthUnits: widthBudget,
      utf8ByteBudget: byteBudget
    };
  }

  if (fitsWithoutScroll(normalizedText, widthBudget, byteBudget)) {
    return {
      normalizedText,
      windows: [createWindow(normalizedText)],
      windowCount: 1,
      displayWidthUnits: widthBudget,
      utf8ByteBudget: byteBudget
    };
  }

  const units = buildScrollUnits(normalizedText, widthBudget, byteBudget);
  const windows = units.map((unit, startIndex) => {
    let text = unit.text;
    for (let step = 1; step < units.length; step += 1) {
      const unitIndex = (startIndex + step) % units.length;
      const next = units[unitIndex];
      const separator = unitIndex === 0 ? ' ' : next.joinBefore;
      const candidate = text + separator + next.text;
      if (!fitsDisplay(candidate, widthBudget, byteBudget)) break;
      text = candidate;
    }
    return createWindow(text);
  });

  return {
    normalizedText,
    windows,
    windowCount: windows.length,
    displayWidthUnits: widthBudget,
    utf8ByteBudget: byteBudget
  };
}

module.exports = {
  DISPLAY_WIDTH_UNITS,
  UTF8_BYTE_BUDGET,
  segmentGraphemes,
  normalizeLyricText,
  graphemeWidth,
  displayWidth,
  utf8ByteLength,
  fitsDisplay,
  buildScrollWindows
};
