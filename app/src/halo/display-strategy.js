// Halo display strategy — cyclic text window (M4.9.2 fix).
// Center layout only. Software ticker increments offset each tick.
// Same lyric heartbeat must NOT cancel an in-flight cycle.
'use strict';

const { buildLayoutPacket, buildTextPacket } = require('./packets');
const { TEXT_MAX_CHARS, TEXT_MAX_BYTES } = require('./constants');

const DEFAULT_SHORT_THRESHOLD = 15;
const DEFAULT_WINDOW_CHARS = 16;
const DEFAULT_WINDOW_HOLD_MS = 900;
const DEFAULT_RESET_DELAY_MS = 300;
const DEFAULT_CENTER_LAYOUT_DELAY_MS = 80;
const DEFAULT_PLACEHOLDER = '♪';
// Cycle connector: ONE half-width space at wrap seam (not stacked).
// Lyric-internal spaces are preserved; windows avoid leading-space padding.
const DEFAULT_CYCLE_SEP = ' ';
const DEFAULT_RGB = [0x66, 0xaf, 0xff];
const DEFAULT_MAX_FRAMES = 200;

function charLength(text) {
  return Array.from(String(text || '')).length;
}

function utf8Length(text) {
  return Buffer.from(String(text || ''), 'utf8').length;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fitWindow(slice, maxChars = TEXT_MAX_CHARS, maxBytes = TEXT_MAX_BYTES) {
  let chars = Array.from(String(slice));
  if (chars.length > maxChars) chars = chars.slice(0, maxChars);
  let working = chars.join('');
  while (utf8Length(working) > maxBytes && Array.from(working).length > 1) {
    working = Array.from(working).slice(0, -1).join('');
  }
  return working;
}

/**
 * Cyclic source for ticker.
 * - Preserve lyric text including internal semantic spaces (never rewrite lyric).
 * - Connector is one half-width space; do not append if lyric already ends with space.
 */
function buildCycleUnit(text, sep = DEFAULT_CYCLE_SEP) {
  const raw = String(text == null ? '' : text);
  const lyricChars = Array.from(raw.replace(/^\s+|\s+$/g, ''));
  if (!lyricChars.length) {
    return { cycle: [], unitText: '', lyricLength: 0, sepLength: 0, connector: '' };
  }

  // Normalize requested connector: at most one half-width space.
  let connector = '';
  if (sep != null && sep !== '') {
    connector = ' ';
    const lastChar = lyricChars[lyricChars.length - 1];
    const firstChar = lyricChars[0];
    // Do not stack connector onto lyric edge spaces.
    if (lastChar === ' ' || firstChar === ' ') {
      connector = '';
    }
  }

  const cycle = connector
    ? [...lyricChars, ...Array.from(connector)]
    : [...lyricChars];
  return {
    cycle,
    unitText: lyricChars.join('') + connector,
    lyricLength: lyricChars.length,
    sepLength: Array.from(connector).length,
    connector
  };
}

/**
 * 16-char cyclic window.
 * - Never start with a space (skip leading spaces at seam) — avoids center padding.
 * - Collapse stacked spaces to at most one; keep lyric-internal single spaces.
 * - Always try to fill windowChars by wrapping the cycle.
 */
function cyclicWindowAt(cycle, offset, windowChars = DEFAULT_WINDOW_CHARS) {
  if (!cycle || !cycle.length) return '';
  const size = Math.max(1, Math.min(windowChars, TEXT_MAX_CHARS));
  const n = cycle.length;
  let start = ((Number(offset) % n) + n) % n;

  // Avoid first char = space: advance start until non-space (or full cycle).
  let guard = 0;
  while (start < n + guard && cycle[start % n] === ' ' && guard < n) {
    start = (start + 1) % n;
    guard += 1;
  }

  const out = [];
  let steps = 0;
  const limit = n + size + 8;
  while (out.length < size && steps < limit) {
    const ch = cycle[(start + steps) % n];
    steps += 1;
    if (ch === ' ' && (out.length === 0 || out[out.length - 1] === ' ')) {
      // No leading space; no consecutive spaces in the window.
      continue;
    }
    out.push(ch);
  }
  while (out.length < size) out.push(' ');
  // Strip any accidental leading space after padding fallback.
  while (out.length && out[0] === ' ') out.shift();
  return fitWindow(out.join(''), size, TEXT_MAX_BYTES);
}

function previewCyclicFrames(text, count = 5, windowChars = DEFAULT_WINDOW_CHARS, sep = DEFAULT_CYCLE_SEP) {
  const { cycle } = buildCycleUnit(text, sep);
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    frames.push(cyclicWindowAt(cycle, i, windowChars));
  }
  return frames;
}

class DisplayStrategy {
  constructor({
    haloClient,
    shortThreshold = DEFAULT_SHORT_THRESHOLD,
    windowChars = DEFAULT_WINDOW_CHARS,
    windowHoldMs = DEFAULT_WINDOW_HOLD_MS,
    resetDelayMs = DEFAULT_RESET_DELAY_MS,
    centerLayoutDelayMs = DEFAULT_CENTER_LAYOUT_DELAY_MS,
    placeholder = DEFAULT_PLACEHOLDER,
    cycleSep = DEFAULT_CYCLE_SEP,
    maxFrames = DEFAULT_MAX_FRAMES,
    rgb = DEFAULT_RGB,
    sleep,
    onStatus,
    enableCyclicWindow = true,
    onTicker
  } = {}) {
    if (!haloClient || typeof haloClient.sendPacket !== 'function') {
      throw new Error('DisplayStrategy requires haloClient.sendPacket');
    }
    this.haloClient = haloClient;
    this.shortThreshold = shortThreshold;
    this.windowChars = windowChars;
    this.windowHoldMs = windowHoldMs;
    this.resetDelayMs = resetDelayMs;
    this.centerLayoutDelayMs = centerLayoutDelayMs;
    this.placeholder = placeholder;
    this.cycleSep = cycleSep;
    this.maxFrames = maxFrames;
    this.rgb = rgb;
    this.sleep = typeof sleep === 'function' ? sleep : defaultSleep;
    this.onStatus = onStatus || (() => {});
    this.onTicker = onTicker || ((payload) => {
      console.log('[ticker]', JSON.stringify(payload));
    });
    this.enableCyclicWindow = Boolean(enableCyclicWindow);

    this.currentMode = null;
    this.currentFullText = '';
    this.sequenceId = 0;
    this.tickerRunning = false;
    this.tickerOffset = 0;
  }

  pickMode(text) {
    if (!this.enableCyclicWindow) return 'center';
    return charLength(text) > this.shortThreshold ? 'cyclic' : 'center';
  }

  reset(reason = 'reset') {
    this.sequenceId += 1;
    this.tickerRunning = false;
    this.tickerOffset = 0;
    this.currentMode = null;
    this.currentFullText = '';
    this.onStatus(`显示已重置（${reason}）`);
  }

  getMode() {
    return this.currentMode;
  }

  _writeCenterLayout() {
    return this.haloClient.sendPacket(buildLayoutPacket('center', this.rgb));
  }

  _writeText(text) {
    return this.haloClient.sendPacket(buildTextPacket(text));
  }

  async _ensureCenterLayout() {
    this._writeCenterLayout();
    this.currentMode = 'center';
    if (this.centerLayoutDelayMs > 0) {
      await this.sleep(this.centerLayoutDelayMs);
    }
  }

  // Placeholder on lyric switch. Does NOT bump sequenceId (caller owns cancel).
  async _resetToPlaceholder() {
    this._writeCenterLayout();
    this.currentMode = 'center';
    if (this.centerLayoutDelayMs > 0) await this.sleep(this.centerLayoutDelayMs);
    this._writeText(this.placeholder);
    this.onStatus(`切换复位：center + ${JSON.stringify(this.placeholder)}`);
    if (this.resetDelayMs > 0) await this.sleep(this.resetDelayMs);
  }

  /**
   * getWindow(offset) — recomputed every tick (no first-frame cache).
   */
  getWindow(cycle, offset) {
    return cyclicWindowAt(cycle, offset, this.windowChars);
  }

  async sendText(text, options = {}) {
    const fullText = String(text == null ? '' : text).trim();
    if (!fullText) {
      return { success: false, reason: 'empty', fullText: '' };
    }

    const forceCenter =
      options.layout === 'center' || options.layout === 'left';
    const mode = forceCenter ? 'center' : this.pickMode(fullText);

    // Same long lyric ticker already running: do not restart / do not cancel.
    if (
      mode === 'cyclic' &&
      this.tickerRunning &&
      this.currentFullText === fullText
    ) {
      this.onStatus('[ticker] same lyric in progress — skip restart');
      return {
        success: true,
        alreadyRunning: true,
        mode: 'cyclic',
        fullText,
        offset: this.tickerOffset,
        cyclic: true
      };
    }

    // Same short center line already on screen: skip.
    if (
      mode === 'center' &&
      this.currentMode === 'center' &&
      this.currentFullText === fullText
    ) {
      return {
        success: true,
        alreadyRunning: true,
        mode: 'center',
        fullText,
        cyclic: false,
        text: fitWindow(Array.from(fullText).slice(0, TEXT_MAX_CHARS).join(''))
      };
    }

    // New sequence — cancel previous ticker exactly once.
    this.sequenceId += 1;
    const activeSeq = this.sequenceId;

    if (mode === 'cyclic') {
      // Mark ticker as running BEFORE any await so a concurrent heartbeat
      // sendText(same) hits alreadyRunning instead of cancelling this cycle.
      this.tickerRunning = true;
      this.currentFullText = fullText;
      this.currentMode = 'cyclic';
    }

    // Track/lyric switch: do NOT flash ♪ — go straight to the new line.
    if (this.currentFullText && this.currentFullText !== fullText) {
      await this._ensureCenterLayout();
      this.onStatus('[display] 切换直接进入新句（无 ♪）');
    } else if (mode !== 'cyclic' || this.currentFullText !== fullText) {
      await this._ensureCenterLayout();
    }

    if (mode === 'center') {
      const slice = fitWindow(
        Array.from(fullText).slice(0, TEXT_MAX_CHARS).join('')
      );
      this._writeText(slice);
      this.onTicker({ offset: 0, text: slice, fullText, mode: 'center' });
      this.currentMode = 'center';
      this.currentFullText = fullText;
      this.tickerRunning = false;
      this.tickerOffset = 0;
      return {
        success: true,
        mode: 'center',
        fullText,
        frames: [slice],
        frameCount: 1,
        cyclic: false,
        text: slice
      };
    }

    // Cyclic ticker: getWindow(offset) every tick, offset++ until cancelled.
    const { cycle, unitText } = buildCycleUnit(fullText, this.cycleSep);
    const frames = [];
    let offset = 0;
    this.tickerRunning = true;
    this.tickerOffset = offset;
    this.currentMode = 'cyclic';
    this.currentFullText = fullText;

    // Ensure center layout once before first cyclic frame.
    if (this.centerLayoutDelayMs >= 0) {
      this._writeCenterLayout();
      if (this.centerLayoutDelayMs > 0) {
        await this.sleep(this.centerLayoutDelayMs);
      }
    }

    while (offset < this.maxFrames) {
      if (activeSeq !== this.sequenceId) {
        this.tickerRunning = false;
        this.onStatus(`[ticker] cancelled offset=${offset} seq=${activeSeq}!=${this.sequenceId}`);
        return {
          success: false,
          cancelled: true,
          mode: 'cyclic',
          fullText,
          frames,
          frameCount: frames.length,
          cyclic: true,
          offset
        };
      }

      // Always recompute a full-width window (wrap through lyric + short sep).
      const frame = this.getWindow(cycle, offset);
      if (!frame) break;

      this._writeText(frame);
      frames.push(frame);
      this.tickerOffset = offset;
      this.currentMode = 'cyclic';
      this.currentFullText = fullText;

      this.onTicker({
        offset,
        text: frame,
        frameChars: charLength(frame),
        fullText,
        mode: 'cyclic'
      });
      this.onStatus(`[ticker] offset=${offset} text=${frame}`);

      offset += 1;
      if (this.windowHoldMs > 0) {
        await this.sleep(this.windowHoldMs);
      }
    }

    this.tickerRunning = false;
    return {
      success: true,
      cancelled: false,
      mode: 'cyclic',
      fullText,
      unitText,
      frames,
      frameCount: frames.length,
      cyclic: true,
      text: frames[0] || fullText,
      windowChars: this.windowChars,
      windowHoldMs: this.windowHoldMs,
      lastOffset: this.tickerOffset
    };
  }

  async sendTrackInfo(text) {
    return this.sendText(text, { layout: 'center' });
  }

  /** Quit restore: forward to raw HaloClient clock scene (TempoHub-compatible). */
  async restoreDefaultMode(options = {}) {
    if (this.haloClient && typeof this.haloClient.restoreDefaultMode === 'function') {
      return this.haloClient.restoreDefaultMode(options);
    }
    throw new Error('DisplayStrategy.haloClient.restoreDefaultMode not available');
  }

  async restoreScene(scene, options = {}) {
    if (this.haloClient && typeof this.haloClient.restoreScene === 'function') {
      return this.haloClient.restoreScene(scene, options);
    }
    throw new Error('DisplayStrategy.haloClient.restoreScene not available');
  }

  /** Capture Halo mode before lyrics (0xEE query via underlying client). */
  captureDisplayMode(options = {}) {
    if (this.haloClient && typeof this.haloClient.captureDisplayMode === 'function') {
      return this.haloClient.captureDisplayMode(options);
    }
    return {
      ok: false,
      reason: 'captureDisplayMode-missing',
      scene: null,
      raw: []
    };
  }

  getStatus() {
    return {
      mode: this.currentMode,
      currentFullText: this.currentFullText,
      tickerRunning: this.tickerRunning,
      tickerOffset: this.tickerOffset,
      shortThreshold: this.shortThreshold,
      windowChars: this.windowChars,
      windowHoldMs: this.windowHoldMs,
      enableCyclicWindow: this.enableCyclicWindow,
      sequenceId: this.sequenceId
    };
  }
}

module.exports = {
  DisplayStrategy,
  buildCycleUnit,
  cyclicWindowAt,
  previewCyclicFrames,
  DEFAULT_SHORT_THRESHOLD,
  DEFAULT_WINDOW_CHARS,
  DEFAULT_WINDOW_HOLD_MS,
  DEFAULT_CYCLE_SEP,
  charLength
};