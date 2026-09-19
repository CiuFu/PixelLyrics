// End-to-end CLI: SodaMusic lyrics -> SongState/Pipeline -> Halo (M4.1 + M4.2).
// Usage:
//   node tests/test_lyric_pipeline.js
//   npm run test:lyrics
//   npm run test:lyrics -- --duration=90
//   npm run test:lyrics -- --dry-run
//   npm run test:lyrics -- --no-media
'use strict';

const path = require('node:path');

const { SodaLyricsDirectService } = require(path.join(
  __dirname,
  '..',
  'src',
  'lyrics',
  'soda-lyrics-service'
));
const { HaloClient } = require(path.join(__dirname, '..', 'src', 'halo', 'device'));
const { LyricPipeline } = require(path.join(
  __dirname,
  '..',
  'src',
  'pipeline',
  'lyric-pipeline'
));
const { SongStateManager } = require(path.join(
  __dirname,
  '..',
  'src',
  'media',
  'song-state-manager'
));
const { MediaSessionMonitor } = require(path.join(
  __dirname,
  '..',
  'src',
  'media',
  'media-session-monitor'
));
const { resolveUserDataPath, warnLegacyToken } = require(path.join(
  __dirname,
  '..',
  'src',
  'config'
));

function parseArgs(argv) {
  const options = { durationSec: 90, dryRun: false, useMedia: true };
  for (const arg of argv) {
    if (arg.startsWith('--duration=')) {
      const value = Number(arg.slice('--duration='.length));
      if (Number.isFinite(value) && value > 0) options.durationSec = value;
    }
    if (arg === '--dry-run') options.dryRun = true;
    if (arg === '--no-media') options.useMedia = false;
  }
  return options;
}

function createDryRunHalo() {
  const writes = [];
  return {
    writes,
    sendText(text) {
      const entry = { text, at: Date.now() };
      writes.push(entry);
      return { success: true, dryRun: true, written: [64, 64], text };
    },
    connect() {
      return { product: 'dry-run', vendorId: '0x0', productId: '0x0' };
    },
    disconnect() {}
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const userDataPath = resolveUserDataPath();
  warnLegacyToken(path.join(__dirname, '..'));
  const dryRun = options.dryRun;

  console.log('=== PixelLyrics M4.2: soda + song-state -> halo ===');
  console.log(`mode     : ${dryRun ? 'dry-run (no HID write)' : 'live Halo'}`);
  console.log(`media    : ${options.useMedia ? 'windows-media-sessions' : 'disabled'}`);
  console.log(`duration : ${options.durationSec}s`);
  console.log(`userData : ${userDataPath}`);
  console.log('');

  const haloClient = dryRun ? createDryRunHalo() : new HaloClient();
  const stats = {
    bridgePayloads: 0,
    bridgeLyrics: 0,
    trackChanges: 0,
    lastBridgeLyric: null,
    lastStatus: '',
    lastTrack: null
  };

  if (!dryRun) {
    try {
      const device = haloClient.connect();
      console.log('[halo] connected:', JSON.stringify(device));
    } catch (error) {
      console.log('[halo] connect failed:', error.message);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log('[halo] dry-run client ready');
  }

  const pipeline = new LyricPipeline({
    haloClient,
    onStatus: (status) => {
      stats.lastStatus = status;
      console.log('[pipeline]', status);
    },
    onSent: (info) => {
      console.log('[halo<-lyric]', JSON.stringify({ text: info.text }));
    }
  });

  const songState = new SongStateManager({
    pipeline,
    haloClient,
    onStatus: (status) => {
      stats.lastStatus = status;
      console.log('[song-state]', status);
    },
    onTrackChanged: (info) => {
      stats.trackChanges += 1;
      stats.lastTrack = info.current;
      console.log(
        '[track-changed]',
        JSON.stringify({
          from: info.previous?.title || null,
          to: info.current?.title || null,
          placeholder: info.placeholderResult
        })
      );
    }
  });

  let mediaMonitor = null;
  if (options.useMedia) {
    try {
      mediaMonitor = new MediaSessionMonitor({
        onTrack: ({ track }) => {
          songState.handleMediaUpdate(track);
        },
        onError: (error) => console.log('[media-error]', error.message)
      });
      await mediaMonitor.start();
      const current = await mediaMonitor.pollOnce().catch(() => null);
      console.log('[media] current track:', current && current.title
        ? `${current.title} - ${current.artist || ''}`
        : '(none)');
    } catch (error) {
      console.log('[media] unavailable:', error.message);
      mediaMonitor = null;
    }
  }

  const soda = new SodaLyricsDirectService({
    userDataPath,
    onStatus: (status) => console.log('[soda]', status),
    onPayload: (payload) => {
      stats.bridgePayloads += 1;
      songState.handleLyric(payload);
    },
    onLyric: (lyric) => {
      stats.bridgeLyrics += lyric ? 1 : 0;
      if (lyric) {
        stats.lastBridgeLyric = {
          text: lyric.text,
          translation: lyric.translation,
          hint: lyric.hint
        };
        console.log(
          '[soda-lyric]',
          JSON.stringify({
            text: lyric.text,
            translation: lyric.translation,
            hint: lyric.hint
          })
        );
      } else {
        console.log('[soda-lyric] null');
      }
    }
  });

  console.log('[soda] bridge starting...');
  soda.setEnabled(true);
  console.log('[info] Play music; switch tracks to verify Halo shows "title - artist" then new lyrics.');
  console.log('');

  const shutdown = () => {
    console.log('');
    console.log('=== M4.2 summary ===');
    console.log(
      JSON.stringify(
        {
          mode: dryRun ? 'dry-run' : 'live',
          bridgePayloads: stats.bridgePayloads,
          bridgeLyricCallbacks: stats.bridgeLyrics,
          trackChanges: stats.trackChanges,
          lastTrack: stats.lastTrack,
          lastBridgeLyric: stats.lastBridgeLyric,
          songState: songState.getStatus(),
          lastPipelineStatus: stats.lastStatus
        },
        null,
        2
      )
    );
    try { soda.stop(); } catch { /* ignore */ }
    if (mediaMonitor) {
      mediaMonitor.stop().catch(() => {});
    }
    try { haloClient.disconnect(); } catch { /* ignore */ }
    const ok = songState.pipeline.sentCount > 0 || stats.trackChanges > 0;
    process.exit(ok ? 0 : 2);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setTimeout(shutdown, options.durationSec * 1000);
  await new Promise(() => {});
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});
