// loopSeparator = single space; windows never start with space.
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildCycleUnit,
  cyclicWindowAt,
  previewCyclicFrames,
  DisplayStrategy,
  charLength,
  DEFAULT_CYCLE_SEP
} = require(path.join(__dirname, '..', 'src', 'halo', 'display-strategy'));

const LONG = '原来你把永远只当成一次兴起的慷慨';
const LONG_INNER = '原来你把永远 只当成一次兴起的慷慨';

function createHaloMock() {
  const packets = [];
  return {
    packets,
    sendPacket(buf) {
      const packet = Buffer.from(buf);
      if (packet[3] !== 0xe8) return { success: true };
      const len = packet[7];
      packets.push(packet.subarray(8, 8 + len).toString('utf8'));
      return { success: true };
    }
  };
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
  await test('DEFAULT_CYCLE_SEP is single half-width space', () => {
    assert.equal(DEFAULT_CYCLE_SEP, ' ');
  });

  await test('buildCycleUnit adds one connector space; keeps lyric spaces', () => {
    const u = buildCycleUnit(LONG, ' ');
    assert.equal(u.connector, ' ');
    assert.equal(u.sepLength, 1);
    assert.equal(u.unitText, LONG + ' ');
    const u2 = buildCycleUnit(LONG_INNER, ' ');
    assert.ok(u2.unitText.includes('永远 只'));
    assert.equal(u2.unitText, LONG_INNER + ' ');
  });

  await test('windows: no leading space, no stacked spaces, still 16 chars', () => {
    const frames = previewCyclicFrames(LONG, 20, 16, ' ');
    for (const f of frames) {
      assert.ok(Array.from(f).length > 0);
      assert.ok(Array.from(f)[0] !== ' ', `leading space in ${JSON.stringify(f)}`);
      assert.ok(!/ {2,}/.test(f), `stacked spaces in ${JSON.stringify(f)}`);
      // Device-facing window should still be full width when cycle is long enough
      assert.ok(Array.from(f).length <= 16);
    }
    const { cycle } = buildCycleUnit(LONG, ' ');
    const seam = cyclicWindowAt(cycle, Array.from(LONG).length, 16);
    assert.ok(Array.from(seam)[0] !== ' ', JSON.stringify(seam));
  });

  await test('semantic single space kept inside window', () => {
    const { cycle } = buildCycleUnit(LONG_INNER, ' ');
    let found = false;
    for (let o = 0; o < cycle.length; o += 1) {
      const w = cyclicWindowAt(cycle, o, 16);
      if (w.includes('永远 只')) {
        found = true;
        assert.ok(Array.from(w)[0] !== ' ');
        assert.ok(!/ {2,}/.test(w), JSON.stringify(w));
      }
    }
    assert.ok(found);
  });

  await test('ticker uses cycleSep space; frames avoid leading space', async () => {
    const halo = createHaloMock();
    const logs = [];
    const display = new DisplayStrategy({
      haloClient: halo,
      windowHoldMs: 1,
      resetDelayMs: 0,
      centerLayoutDelayMs: 0,
      maxFrames: 6,
      cycleSep: ' ',
      onTicker: (p) => logs.push(p),
      onStatus: () => {},
      sleep: async () => {}
    });
    assert.equal(display.cycleSep, ' ');
    await display.sendText(LONG);
    const cyc = logs.filter((p) => p.mode === 'cyclic');
    assert.ok(cyc.length >= 3);
    for (const p of cyc) {
      assert.ok(Array.from(p.text)[0] !== ' ', JSON.stringify(p));
      assert.ok(!/ {2,}/.test(p.text), JSON.stringify(p.text));
      assert.ok(charLength(p.text) <= 16);
    }
  });

  console.log('');
  console.log(`Result: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
