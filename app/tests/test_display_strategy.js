'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { DisplayStrategy } = require(path.join(__dirname, '..', 'src', 'halo', 'display-strategy'));
const { displayWidth } = require(path.join(__dirname, '..', 'src', 'halo', 'lyrics-layout'));

function createHaloMock() {
  const texts = [];
  return {
    texts,
    sendPacket(buf) {
      const packet = Buffer.from(buf);
      if (packet[3] !== 0xe8) return { success: true };
      const payloadLength = packet[7];
      texts.push(packet.subarray(8, 8 + payloadLength).toString('utf8'));
      return { success: true };
    }
  };
}

function makeDisplay(halo, options = {}) {
  return new DisplayStrategy({
    haloClient: halo,
    windowHoldMs: 1,
    centerLayoutDelayMs: 0,
    maxWindows: 4,
    onTicker: () => {},
    onStatus: () => {},
    sleep: async () => {},
    ...options
  });
}

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok  - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

async function main() {
  await test('15 CJK characters stay centered on one screen', async () => {
    const halo = createHaloMock();
    const display = makeDisplay(halo);
    const text = '春'.repeat(15);
    const result = await display.sendText(text);
    assert.equal(result.mode, 'center');
    assert.equal(result.windowCount, 1);
    assert.deepEqual(halo.texts, [text]);
  });

  await test('16 CJK characters restore the original ticker threshold', async () => {
    const halo = createHaloMock();
    const display = makeDisplay(halo);
    const result = await display.sendText('一二三四五六七八九十甲乙丙丁戊己');
    assert.equal(result.mode, 'cyclic');
    assert.equal(result.windowCount, 16);
    assert.equal(halo.texts.length, 4);
  });

  await test('long CJK restores one-grapheme overlapping software ticker', async () => {
    const halo = createHaloMock();
    const logs = [];
    const display = makeDisplay(halo, { onTicker: (payload) => logs.push(payload) });
    const text = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸';
    const result = await display.sendText(text);
    assert.equal(result.mode, 'cyclic');
    assert.equal(halo.texts.length, 4);
    assert.equal(halo.texts[0], Array.from(text).slice(0, 16).join(''));
    assert.equal(halo.texts[1], Array.from(text).slice(1, 17).join(''));
    assert.equal(logs[1].windowIndex, 1);
    assert.ok(halo.texts.every((window) => displayWidth(window) <= 32));
  });

  await test('spaces in Chinese lyrics do not turn scrolling into phrase paging', async () => {
    const halo = createHaloMock();
    const display = makeDisplay(halo);
    const result = await display.sendText('我站在冰冷的水中 等一个不会来的人回来');
    assert.equal(result.mode, 'cyclic');
    assert.ok(result.windowCount > 2);
    assert.ok(halo.texts[0].startsWith('我站'));
    assert.ok(halo.texts[1].startsWith('站在'));
  });

  await test('English ticker advances by complete words', async () => {
    const halo = createHaloMock();
    const display = makeDisplay(halo);
    const result = await display.sendText("I don't wanna say goodbye to you tonight");
    assert.equal(result.mode, 'cyclic');
    assert.equal(halo.texts[0], "I don't wanna say goodbye to you");
    assert.ok(halo.texts[1].startsWith("don't "));
    assert.ok(halo.texts.every((window) => displayWidth(window) <= 32));
    assert.ok(halo.texts.every((window) => !window.includes('\n') && !window.includes('\r')));
  });

  await test('same long lyric heartbeat does not restart ticker', async () => {
    const halo = createHaloMock();
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const display = makeDisplay(halo, {
      maxWindows: 1,
      sleep: async () => blocked
    });
    const pending = display.sendText('春'.repeat(20));
    const duplicate = await display.sendText('春'.repeat(20));
    assert.equal(duplicate.alreadyRunning, true);
    release();
    await pending;
  });

  await test('new lyric cancels the old ticker sequence', async () => {
    const halo = createHaloMock();
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const display = makeDisplay(halo, {
      maxWindows: 2,
      sleep: async () => blocked
    });
    const oldLyric = display.sendText('春'.repeat(20));
    const newLyric = display.sendText('新的歌词');
    release();
    const [oldResult, newResult] = await Promise.all([oldLyric, newLyric]);
    assert.equal(oldResult.cancelled, true);
    assert.equal(newResult.mode, 'center');
    assert.ok(halo.texts.includes('新的歌词'));
  });

  console.log('');
  console.log(`Result: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
