// M4.2 tests: song switch clears stale Halo lyric and accepts the new song.
// Usage:
//   node tests/test_song_state.js
//   npm run test:song-state
//   npm run test:song-state -- --live
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
const {
  SongStateManager,
  DEFAULT_PLACEHOLDER,
  formatTrackDisplay
} = require(path.join(__dirname, '..', 'src', 'media', 'song-state-manager'));
const {
  MediaSessionMonitor,
  buildTrackKey,
  normalizeSession
} = require(path.join(
  __dirname,
  '..',
  'src',
  'media',
  'media-session-monitor'
));

function createHaloMock() {
  const writes = [];
  return {
    writes,
    sendText(text) {
      writes.push(String(text));
      return { success: true, written: [64, 64], text };
    }
  };
}

function makeTrack(title, artist, id) {
  return normalizeSession({
    id: id || title,
    title,
    artist,
    albumTitle: 'Album',
    playbackStatus: 'playing',
    timeline: { positionMs: 0, durationMs: 200000 }
  });
}

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => {
          passed += 1;
          console.log(`ok  - ${name}`);
        },
        (error) => {
          failures.push({ name, error });
          console.error(`FAIL - ${name}`);
          console.error(`       ${error.message}`);
        }
      );
    }
    passed += 1;
    console.log(`ok  - ${name}`);
    return Promise.resolve();
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
    return Promise.resolve();
  }
}

async function runScenario() {
  const halo = createHaloMock();
  const pipeline = new LyricPipeline({ haloClient: halo });
  const managerEvents = [];
  const manager = new SongStateManager({
    pipeline,
    haloClient: halo,
    onTrackChanged: (info) => managerEvents.push(info)
  });

  const songA = makeTrack('歌曲A', '歌手A', 'track-a');
  const songB = makeTrack('歌曲B', '歌手B', 'track-b');

  // Song A playing
  await manager.handleMediaUpdate({ track: songA, changed: true });
  assert.equal(manager.currentTrackKey, songA.trackKey);

  await manager.handleLyric({ text: '歌词A1', translation: '', hint: '' });
  await manager.handleLyric({ text: '歌词A2', translation: '', hint: '' });
  assert.deepEqual(halo.writes.filter((w) => w.startsWith('歌词A')), [
    '歌词A1',
    '歌词A2'
  ]);
  assert.equal(pipeline.lastText, '歌词A2');

  // Switch to song B: Halo shows "title - artist" (center), never ♪.
  const switchResult = await manager.handleMediaUpdate({ track: songB, changed: true });
  assert.equal(switchResult.action, 'track-changed');
  assert.equal(manager.currentTrack.title, '歌曲B');
  assert.equal(pipeline.lastText, '');
  const expectedTrackText = formatTrackDisplay(songB);
  assert.equal(expectedTrackText, '歌曲B - 歌手B');
  assert.equal(switchResult.placeholderResult.action, 'track-info');
  assert.equal(switchResult.placeholderResult.text, expectedTrackText);
  assert.ok(!halo.writes.includes('♪'));
  assert.equal(halo.writes[halo.writes.length - 1], expectedTrackText);
  assert.ok(managerEvents.some((e) => e.action === 'track-changed'));
  const lastEvent = pipeline.getStatus().lastEvent;
  assert.ok(lastEvent);
  assert.equal(lastEvent.type, 'track-info');
  assert.equal(lastEvent.text, expectedTrackText);

  const firstB = await manager.handleLyric({ text: '歌词B1', translation: '', hint: '' });
  assert.equal(firstB.action, 'sent');
  assert.equal(halo.writes[halo.writes.length - 1], '歌词B1');

  // Dedupe still works within song B
  const dupB = await manager.handleLyric({ text: '歌词B1', translation: '', hint: '' });
  assert.equal(dupB.action, 'dedupe');

  await manager.handleLyric({ text: '歌词B2', translation: '', hint: '' });
  assert.deepEqual(halo.writes.slice(-2), ['歌词B1', '歌词B2']);
}

async function runLiveProbe() {
  console.log('');
  console.log('=== live media session probe ===');
  let backend;
  try {
    backend = require('windows-media-sessions');
  } catch (error) {
    console.log('windows-media-sessions not loadable:', error.message);
    return;
  }
  const monitor = new MediaSessionMonitor({
    backend,
    onTrack: ({ track, changed }) => {
      console.log(changed ? '[track-changed]' : '[track-same]', track || null);
    },
    onError: (error) => console.log('[media-error]', error.message)
  });
  try {
    const current = await monitor.pollOnce();
    console.log('current track:', current);
  } finally {
    await monitor.stop();
  }
}

async function main() {
  const live = process.argv.includes('--live');

  await test('normalizeSession + trackKey fields', () => {
    const t = makeTrack('成都', '赵雷', 'id-1');
    assert.equal(t.title, '成都');
    assert.equal(t.artist, '赵雷');
    assert.equal(t.album, 'Album');
    assert.equal(t.playbackStatus, 'playing');
    assert.equal(
      t.trackKey,
      buildTrackKey({ id: 'id-1', artist: '赵雷', title: '成都' })
    );
  });

  await test('media monitor mock emits track and change flags', async () => {
    const events = [];
    const backend = {
      getAllSessions: async () => [
        {
          id: 'A',
          title: '歌曲A',
          artist: '歌手A',
          albumTitle: '专辑A',
          playbackStatus: 'playing',
          timeline: { positionMs: 10, durationMs: 100 }
        }
      ],
      onSessionsChanged() {
        return () => {};
      },
      async shutdown() {}
    };
    const monitor = new MediaSessionMonitor({
      backend,
      onTrack: (payload) => events.push(payload)
    });
    const t = await monitor.pollOnce();
    assert.equal(t.title, '歌曲A');
    assert.equal(events.length, 1);
    assert.equal(events[0].changed, true);
  });

  await test(
    'song switch: A lyrics -> track title on Halo (no ♪) -> B lyrics',
    async () => {
      await runScenario();
    }
  );

  await test('same track update does not clear or re-placeholder', async () => {
    const halo = createHaloMock();
    const pipeline = new LyricPipeline({ haloClient: halo });
    const manager = new SongStateManager({ pipeline, haloClient: halo });
    const songA = makeTrack('歌曲A', '歌手A', 'track-a');
    await manager.handleMediaUpdate({ track: songA, changed: true });
    await manager.handleLyric({ text: '歌词A1', hint: '' });
    const writesBefore = halo.writes.length;
    const clearBefore = pipeline.clearCount;
    const same = await manager.handleMediaUpdate({
      track: { ...songA, positionMs: 5000 },
      changed: false
    });
    assert.equal(same.action, 'same-track');
    assert.equal(halo.writes.length, writesBefore);
    assert.equal(pipeline.clearCount, clearBefore);
    assert.equal(pipeline.lastText, '歌词A1');
  });

  await test('pipeline clear allows first lyric of new song', async () => {
    const halo = createHaloMock();
    const pipeline = new LyricPipeline({ haloClient: halo });
    await pipeline.handleLyric({ text: '重复句', hint: '' });
    assert.equal((await pipeline.handleLyric({ text: '重复句', hint: '' })).action, 'dedupe');
    pipeline.trackChanged({ reason: 'track-changed' });
    assert.equal((await pipeline.handleLyric({ text: '重复句', hint: '' })).action, 'sent');
  });

  console.log('');
  console.log(`Result: ${passed} passed, ${failures.length} failed`);
  if (live) await runLiveProbe();
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});
