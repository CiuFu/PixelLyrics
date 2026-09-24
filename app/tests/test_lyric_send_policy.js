// M4.5 lyric send-policy tests (pipeline dedupe/time-window).
// Usage: node tests/test_lyric_send_policy.js
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { LyricPipeline } = require(path.join(
  __dirname,
  '..',
  'src',
  'pipeline',
  'lyric-pipeline'
));

function createHaloMock() {
  const calls = [];
  return {
    calls,
    sendText(text, options = {}) {
      calls.push({
        kind: 'sendText',
        text,
        layout: options.layout || null,
        reason: options.reason || null
      });
      return Promise.resolve({
        success: true,
        written: [64],
        text,
        layout: options.layout || 'adaptive',
        mode: 'center'
      });
    },
    reset(reason) {
      calls.push({ kind: 'reset', reason });
    }
  };
}

function createPipeline(halo, startMs = 0) {
  let clock = startMs;
  const pipeline = new LyricPipeline({
    haloClient: halo,
    now: () => clock,
    dedupeWindowMs: 2000,
    onSent: () => {},
    onEvent: () => {},
    onStatus: () => {}
  });
  return {
    pipeline,
    advance(ms) {
      clock += ms;
      return clock;
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
  await test('case1: A A A in short window -> send once', async () => {
    const halo = createHaloMock();
    const { pipeline, advance } = createPipeline(halo, 1000);
    const r1 = await pipeline.handleLyric({ text: 'A' });
    advance(200);
    const r2 = await pipeline.handleLyric({ text: 'A' });
    advance(500);
    const r3 = await pipeline.handleLyric({ text: 'A' });
    assert.equal(r1.action, 'sent');
    assert.equal(r2.action, 'dedupe');
    assert.equal(r3.action, 'dedupe');
    assert.equal(halo.calls.filter((c) => c.kind === 'sendText').length, 1);
    assert.equal(pipeline.sentCount, 1);
  });

  await test('case2: same lyric heartbeat does not restart ticker windows', async () => {
    const halo = createHaloMock();
    const { pipeline, advance } = createPipeline(halo, 0);
    assert.equal((await pipeline.handleLyric({ text: 'A' })).action, 'sent');
    advance(10_000);
    // Soda re-posts the same current line — must NOT restart Halo windows.
    const again = await pipeline.handleLyric({ text: 'A' });
    assert.equal(again.action, 'dedupe');
    assert.equal(again.reason, 'same-displayed-text');
    assert.equal(halo.calls.filter((c) => c.kind === 'sendText').length, 1);
  });

  await test('case2b: chorus A-B-A still sends A again after other line', async () => {
    const halo = createHaloMock();
    const { pipeline, advance } = createPipeline(halo, 0);
    await pipeline.handleLyric({ text: 'A' });
    advance(3000);
    await pipeline.handleLyric({ text: 'B' });
    advance(3000);
    const againA = await pipeline.handleLyric({ text: 'A' });
    assert.equal(againA.action, 'sent');
    const texts = halo.calls.filter((c) => c.kind === 'sendText').map((c) => c.text);
    assert.deepEqual(texts, ['A', 'B', 'A']);
  });

  await test('case3: A -> B sends both lines', async () => {
    const halo = createHaloMock();
    const { pipeline, advance } = createPipeline(halo, 0);
    await pipeline.handleLyric({ text: 'A' });
    advance(300);
    const toB = await pipeline.handleLyric({ text: 'B' });
    assert.equal(toB.action, 'sent');
    assert.equal(toB.reason, 'lyric-change');
    const texts = halo.calls.filter((c) => c.kind === 'sendText').map((c) => c.text);
    assert.deepEqual(texts, ['A', 'B']);
    assert.equal(pipeline.currentDisplayedText, 'B');
  });

  await test('case4: long interlude does not resend A', async () => {
    const halo = createHaloMock();
    const { pipeline, advance } = createPipeline(halo, 0);
    await pipeline.handleLyric({ text: 'A' });
    const sentAfterA = halo.calls.length;
    advance(15_000);
    for (let i = 0; i < 8; i += 1) {
      const r = await pipeline.handleLyric({ text: '', hint: '正在加载歌词' });
      assert.equal(r.action, 'skip');
      advance(1000);
    }
    assert.equal(halo.calls.length, sentAfterA);
    assert.equal(pipeline.sentCount, 1);
    assert.equal(pipeline.currentDisplayedText, 'A');
  });

  await test('song switch clear then first line of new song still sends', async () => {
    const halo = createHaloMock();
    const { pipeline, advance } = createPipeline(halo, 0);
    await pipeline.handleLyric({ text: '旧歌最后一句' });
    pipeline.trackChanged({ reason: 'track-changed', track: { title: 'B', artist: 'X' } });
    assert.equal(pipeline.currentDisplayedText, '');
    assert.ok(halo.calls.some((c) => c.kind === 'reset'));
    advance(5000);
    const first = await pipeline.handleLyric({ text: '旧歌最后一句' });
    assert.equal(first.action, 'sent');
    assert.equal(halo.calls.filter((c) => c.kind === 'sendText').length, 2);
  });

  console.log('');
  console.log(`Result: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});
