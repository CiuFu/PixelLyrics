// Capture pre-lyrics Halo mode + restore on quit (not assumed clock).
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { HaloOwnership } = require(path.join(
  __dirname,
  '..',
  'src',
  'halo',
  'ownership'
));
const {
  buildScenePacket,
  buildPixelStateQueryPacket,
  parsePixelStateResponse,
  packetToHex
} = require(path.join(__dirname, '..', 'src', 'halo', 'packets'));

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

function createClientMock(options = {}) {
  const calls = [];
  const captureScene = options.captureScene; // e.g. 'cats' | null
  return {
    calls,
    sendText(text) {
      calls.push({ kind: 'sendText', text });
      return Promise.resolve({ success: true, text });
    },
    captureDisplayMode() {
      calls.push({ kind: 'captureDisplayMode' });
      return Promise.resolve(
        captureScene
          ? { ok: true, scene: captureScene, reason: 'captured', raw: [captureScene === 'cats' ? 4 : 0] }
          : { ok: false, scene: null, reason: 'response-unparsed-or-no-scene', raw: [] }
      );
    },
    restoreScene(scene) {
      calls.push({ kind: 'restoreScene', scene });
      return Promise.resolve({ success: true, scene });
    },
    restoreDefaultMode() {
      calls.push({ kind: 'restoreDefaultMode' });
      return Promise.resolve({ success: true, mode: 'clock' });
    },
    stopReconnect() {
      calls.push({ kind: 'stopReconnect' });
    },
    disconnect() {
      calls.push({ kind: 'disconnect' });
    }
  };
}

async function main() {
  await test('0xEE query packet is empty-payload ED frame', () => {
    const q = buildPixelStateQueryPacket();
    assert.equal(q[3], 0xee);
    assert.equal(q[4], 0x00);
    assert.equal(q[5], 0x00);
    assert.ok(packetToHex(q).startsWith('2EAAEDEE0000'));
    const clock = buildScenePacket('clock', [0x66, 0xaf, 0xff]);
    assert.equal(clock[12], 0x00);
  });

  await test('parsePixelStateResponse accepts device 2F BB EC frame', () => {
    const raw = [0x2f, 0xbb, 0xec, 0xee, 0x00, 0x01, 0x04, 0, 0, 0];
    const parsed = parsePixelStateResponse(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.scene, 'cats');
    assert.equal(parsed.sceneId, 4);
  });

  await test('release restores captured scene (cats), not forced clock', async () => {
    const halo = createClientMock({ captureScene: 'cats' });
    const own = new HaloOwnership({ haloClient: halo });
    const cap = await own.captureBeforeLyrics('startup');
    assert.equal(cap.ok, true);
    assert.equal(cap.scene, 'cats');
    own.noteDisplay('歌词在屏上');
    const result = await own.release({ reason: 'app-quit' });
    assert.equal(result.restored, true);
    assert.equal(result.method, 'pre-takeover-scene');
    assert.equal(result.restoredScene, 'cats');
    assert.equal(result.clockRestored, false);
    assert.ok(halo.calls.some((c) => c.kind === 'restoreScene' && c.scene === 'cats'));
    assert.ok(!halo.calls.some((c) => c.kind === 'restoreDefaultMode'));
  });

  await test('release when capture fails: clock fallback so device is not stuck', async () => {
    const halo = createClientMock({ captureScene: null });
    const own = new HaloOwnership({ haloClient: halo });
    const cap = await own.captureBeforeLyrics('startup');
    assert.equal(cap.ok, false);
    own.noteDisplay('歌词');
    const result = await own.release({ reason: 'quit' });
    // Capture unknown: restore clock instead of leaving last lyric on Halo.
    assert.equal(result.restored, true);
    assert.equal(result.method, 'clock-fallback');
    assert.ok(String(result.reason).includes('pre-takeover'));
    assert.ok(halo.calls.some((c) => c.kind === 'restoreDefaultMode'));
  });

  await test('forceClockIfUnknown fallback only when requested', async () => {
    const halo = createClientMock({ captureScene: null });
    const own = new HaloOwnership({ haloClient: halo });
    await own.captureBeforeLyrics('startup');
    own.noteDisplay('歌词');
    const result = await own.release({ reason: 'quit', forceClockIfUnknown: true });
    assert.equal(result.method, 'clock-fallback');
    assert.equal(result.clockRestored, true);
    assert.ok(halo.calls.some((c) => c.kind === 'restoreDefaultMode'));
  });

  await test('captured clock scene restores via restoreScene(clock)', async () => {
    const halo = createClientMock({ captureScene: 'clock' });
    // override capture to scene clock id 0
    halo.captureDisplayMode = () => {
      halo.calls.push({ kind: 'captureDisplayMode' });
      return Promise.resolve({ ok: true, scene: 'clock', reason: 'captured', raw: [0] });
    };
    const own = new HaloOwnership({ haloClient: halo });
    await own.captureBeforeLyrics('startup');
    own.noteDisplay('x');
    const result = await own.release({ reason: 'quit' });
    assert.equal(result.restoredScene, 'clock');
    assert.equal(result.clockRestored, true);
    assert.ok(halo.calls.some((c) => c.kind === 'restoreScene' && c.scene === 'clock'));
  });

  console.log('');
  console.log(`Result: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
