'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const {
  DISPLAY_WIDTH_UNITS,
  UTF8_BYTE_BUDGET,
  segmentGraphemes,
  normalizeLyricText,
  displayWidth,
  buildScrollWindows
} = require(path.join(__dirname, '..', 'src', 'halo', 'lyrics-layout'));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

function assertSafe(layout) {
  for (const window of layout.windows) {
    assert.ok(window.width <= DISPLAY_WIDTH_UNITS, `${window.text} width=${window.width}`);
    assert.ok(window.utf8Bytes <= UTF8_BYTE_BUDGET, `${window.text} bytes=${window.utf8Bytes}`);
    assert.ok(!window.text.includes('\n') && !window.text.includes('\r'));
    assert.ok(!window.text.includes('�'));
  }
}

test('normalizes newline, CRLF, tabs, and repeated whitespace', () => {
  assert.equal(normalizeLyricText(' Hello\n\r\nWorld\t  again '), 'Hello World again');
  const layout = buildScrollWindows('Hello\nWorld\r\nagain\tthere');
  assert.equal(layout.normalizedText, 'Hello World again there');
  assertSafe(layout);
});

test('CJK 15 characters stay centered; 16 activate the ticker', () => {
  assert.equal(buildScrollWindows('春'.repeat(15)).windowCount, 1);
  assert.equal(buildScrollWindows('春'.repeat(16)).windowCount, 16);
});

test('CJK 17 characters activate overlapping grapheme windows', () => {
  const text = '一二三四五六七八九十甲乙丙丁戊己庚';
  const layout = buildScrollWindows(text);
  assert.equal(layout.windows[0].text, Array.from(text).slice(0, 16).join(''));
  assert.equal(layout.windows[1].text, Array.from(text).slice(1, 17).join(''));
  assertSafe(layout);
});

test('Chinese phrases separated by spaces still advance one grapheme', () => {
  const text = '我站在冰冷的水中 等一个不会来的人回来';
  const layout = buildScrollWindows(text);
  assert.ok(layout.windowCount > 2);
  assert.ok(layout.windows[0].text.startsWith('我站'));
  assert.ok(layout.windows[1].text.startsWith('站在'));
  assertSafe(layout);
});

test('15 CJK plus a separator restores the old 16-code-point ticker boundary', () => {
  const layout = buildScrollWindows('曾经的拥抱 如今只剩下咸涩的空白');
  assert.ok(layout.windowCount > 1);
  assertSafe(layout);
});

test('long Chinese ticker advances by one grapheme', () => {
  const text = '春江花月夜'.repeat(10);
  const layout = buildScrollWindows(text);
  assert.equal(layout.windowCount, segmentGraphemes(text).length);
  assert.equal(
    segmentGraphemes(layout.windows[1].text)[0],
    segmentGraphemes(text)[1]
  );
  assertSafe(layout);
});

test('short ASCII stays centered; full-width 32 ASCII activates the ticker', () => {
  assert.equal(buildScrollWindows('Hello world').windowCount, 1);
  const exact = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
  const layout = buildScrollWindows(exact);
  assert.equal(layout.windowCount, 32);
  assert.equal(layout.windows[0].width, 32);
});

test('English ticker advances by complete words', () => {
  const layout = buildScrollWindows("I don't wanna say goodbye to you tonight");
  assert.equal(layout.windows[0].text, "I don't wanna say goodbye to you");
  assert.ok(layout.windows[1].text.startsWith("don't "));
  assert.ok(layout.windows.every((window) => !/^ | $/.test(window.text)));
  assertSafe(layout);
});

test('a single overlong token falls back to grapheme scrolling', () => {
  const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
  const layout = buildScrollWindows(text);
  assert.equal(layout.windows[0].text, text.slice(0, 32));
  assert.equal(layout.windows[1].text, text.slice(1, 33));
  assertSafe(layout);
});

test('Japanese Hiragana, Katakana, and Kanji use width two', () => {
  const text = 'あいうえおカキクケコ日本語春夏秋冬';
  const layout = buildScrollWindows(text);
  assert.ok(layout.windowCount > 1);
  assert.equal(displayWidth(layout.windows[0].text), 32);
  assertSafe(layout);
});

test('Korean Hangul uses grapheme-safe overlapping windows', () => {
  const layout = buildScrollWindows('안녕하세요반갑습니다오늘도좋은하루보내세요');
  assert.ok(layout.windowCount > 1);
  assert.equal(displayWidth(layout.windows[0].text), 32);
  assertSafe(layout);
});

test('mixed text uses token and grapheme boundaries without language branches', () => {
  const layout = buildScrollWindows('Baby 我真的好想你 tonight and forever');
  assert.ok(layout.windowCount > 1);
  assert.ok(layout.windows[0].text.startsWith('Baby '));
  assertSafe(layout);
});

test('combining marks stay attached to their base', () => {
  const text = `Cafe\u0301 ${'e\u0301'.repeat(24)}`;
  const layout = buildScrollWindows(text);
  for (const window of layout.windows) {
    assert.ok(!segmentGraphemes(window.text).some((grapheme) => /^\p{M}/u.test(grapheme)));
  }
  assertSafe(layout);
});

test('emoji and ZWJ sequences remain intact', () => {
  const family = '👨‍👩‍👧‍👦';
  const layout = buildScrollWindows(`${family.repeat(3)} hello world`);
  assert.equal(segmentGraphemes(family).length, 1);
  assert.ok(layout.windows.some((window) => window.text.includes(family)));
  assertSafe(layout);
});

test('UTF-8 byte budget can limit a window before visual width', () => {
  const family = '👨‍👩‍👧‍👦';
  const layout = buildScrollWindows(family.repeat(3));
  assert.ok(layout.windows.every((window) => window.utf8Bytes <= UTF8_BYTE_BUDGET));
  assertSafe(layout);
});

test('empty and whitespace-only input produces no window', () => {
  assert.deepEqual(buildScrollWindows(' \n\t\r ').windows, []);
});

console.log('');
console.log(`Result: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
