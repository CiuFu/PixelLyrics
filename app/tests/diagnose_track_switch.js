// Real-device track-switch diagnostics (M4.2 follow-up).
// Does NOT change business logic — only wraps methods to log each layer.
// Usage:
//   node tests/diagnose_track_switch.js
//   npm run diagnose:track-switch
//   npm run diagnose:track-switch -- --duration=120
//   npm run diagnose:track-switch -- --dry-run
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

const PLACEHOLDER = '♪';

function parseArgs(argv) {
  const options = { durationSec: 120, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith('--duration=')) {
      const value = Number(arg.slice('--duration='.length));
      if (Number.isFinite(value) && value > 0) options.durationSec = value;
    }
    if (arg === '--dry-run') options.dryRun = true;
  }
  return options;
}

function ts() {
  return new Date().toISOString();
}

function log(layer, message, data) {
  const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
  console.log(`[${ts()}] [${layer}] ${message}${suffix}`);
}

function createDryRunHalo() {
  return {
    sendText(text) {
      return { success: true, dryRun: true, written: [64, 64], text };
    },
    connect() {
      return { product: 'dry-run', vendorId: '0x0', productId: '0x0' };
    },
    disconnect() {}
  };
}

/**
 * Wrap public methods only — control flow stays in the original modules.
 */
function instrument({ monitor, songState, pipeline, haloClient }) {
  const diag = {
    mediaEvents: 0,
    mediaChanged: 0,
    lastMedia: null,
    trackChangedReceived: 0,
    pipelineClearCalls: 0,
    placeholderCalls: 0,
    placeholderSuccess: 0,
    placeholderFail: 0,
    haloSendTextCalls: 0,
    haloPlaceholderOk: 0,
    lyricsSent: 0
  };

  // --- Layer 1: MediaSessionMonitor ---
  const origEmitTrack = monitor.emitTrack.bind(monitor);
  monitor.emitTrack = (track) => {
    diag.mediaEvents += 1;
    const trackKey = track?.trackKey || '';
    const previousKey = monitor.lastTrackKey;
    const changedTrack = trackKey !== previousKey;
    if (changedTrack) diag.mediaChanged += 1;
    diag.lastMedia = track
      ? {
          title: track.title,
          artist: track.artist,
          trackKey,
          playbackStatus: track.playbackStatus,
          positionMs: track.positionMs
        }
      : null;

    log('MediaSession', changedTrack ? 'CHANGED' : 'same', {
      title: track?.title || null,
      artist: track?.artist || null,
      trackKey: trackKey || null,
      changedTrack,
      previousTrackKey: previousKey || null,
      playbackStatus: track?.playbackStatus || null
    });

    return origEmitTrack(track);
  };

  const origPollOnce = monitor.pollOnce.bind(monitor);
  monitor.pollOnce = async () => {
    try {
      return await origPollOnce();
    } catch (error) {
      log('MediaSession', 'pollOnce ERROR', { message: error.message });
      throw error;
    }
  };

  // --- Layer 2: SongStateManager ---
  const origHandleMedia = songState.handleMediaUpdate.bind(songState);
  songState.handleMediaUpdate = (update) => {
    const track =
      update && typeof update === 'object' && 'track' in update
        ? update.track
        : update;
    const nextKey = track?.trackKey || '';
    const currentKey = songState.currentTrackKey || '';
    const wouldChange = nextKey !== currentKey;

    log('SongStateManager', 'handleMediaUpdate enter', {
      incomingTitle: track?.title || null,
      incomingTrackKey: nextKey || null,
      currentTrackKey: currentKey || null,
      wouldChange,
      updateShape: update && typeof update === 'object' && 'track' in update
        ? '{track,changed}'
        : 'raw-track'
    });

    if (wouldChange) diag.trackChangedReceived += 1;
    const result = origHandleMedia(update);
    log('SongStateManager', 'handleMediaUpdate result', {
      action: result?.action || null,
      currentTrackKey: songState.currentTrackKey || null,
      placeholderResult: result?.placeholderResult || null
    });
    return result;
  };

  // --- Layer 3: LyricPipeline ---
  const origClear = pipeline.clear.bind(pipeline);
  pipeline.clear = (reason) => {
    diag.pipelineClearCalls += 1;
    log('Pipeline', 'clear() CALLED', {
      reason: reason || 'clear',
      lastTextBefore: pipeline.lastText,
      lastKeyBefore: pipeline.lastKey,
      trackEpochBefore: pipeline.trackEpoch,
      caller: new Error('stack').stack.split('\n')[2]?.trim() || ''
    });
    const result = origClear(reason);
    log('Pipeline', 'clear() DONE', {
      lastTextAfter: pipeline.lastText,
      trackEpochAfter: pipeline.trackEpoch,
      clearCount: pipeline.clearCount
    });
    return result;
  };

  const origTrackChanged = pipeline.trackChanged.bind(pipeline);
  pipeline.trackChanged = (info = {}) => {
    log('Pipeline', 'trackChanged() CALLED', {
      reason: info.reason || null,
      track: info.track || null,
      previousTrack: info.previousTrack || null
    });
    return origTrackChanged(info);
  };

  const origHandleLyric = pipeline.handleLyric.bind(pipeline);
  pipeline.handleLyric = (lyric) => {
    const result = origHandleLyric(lyric);
    if (result?.action === 'sent') {
      diag.lyricsSent += 1;
      log('Pipeline', 'lyric SENT', { text: result.text });
    } else if (result?.action === 'dedupe') {
      log('Pipeline', 'lyric DEDUPE', { text: result.text });
    } else if (result?.action === 'skip') {
      // Keep skip logs compact.
      log('Pipeline', 'lyric SKIP', {
        reason: result.reason,
        hint: result.hint || null
      });
    } else if (result?.action === 'error') {
      log('Pipeline', 'lyric ERROR', { error: result.error });
    }
    return result;
  };

  // --- Layer 4: Halo sendText ---
  const origSendText = haloClient.sendText.bind(haloClient);
  haloClient.sendText = (text, options) => {
    diag.haloSendTextCalls += 1;
    const isPlaceholder = text === PLACEHOLDER;
    log('Halo', 'sendText CALL', {
      text,
      isPlaceholder,
      options: options || null
    });
    try {
      const result = origSendText(text, options);
      const success = Boolean(result && result.success !== false);
      if (isPlaceholder) {
        diag.placeholderCalls += 1;
        if (success) {
          diag.placeholderSuccess += 1;
          diag.haloPlaceholderOk += 1;
        } else {
          diag.placeholderFail += 1;
        }
      }
      log('Halo', success ? 'sendText OK' : 'sendText FAILED', {
        text,
        isPlaceholder,
        success,
        written: result?.written || null,
        device: result?.device?.product || null,
        result
      });
      return result;
    } catch (error) {
      if (isPlaceholder) diag.placeholderFail += 1;
      log('Halo', 'sendText THROW', {
        text,
        isPlaceholder,
        message: error.message,
        name: error.name
      });
      throw error;
    }
  };

  return diag;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const userDataPath = resolveUserDataPath();
  warnLegacyToken(path.join(__dirname, '..'));
  const dryRun = options.dryRun;

  console.log('=== PixelLyrics track-switch DIAGNOSTICS ===');
  console.log(`mode     : ${dryRun ? 'dry-run' : 'live Halo'}`);
  console.log(`duration : ${options.durationSec}s`);
  console.log(`userData : ${userDataPath}`);
  console.log('');
  console.log('TEST FLOW:');
  console.log('  1) Ensure SodaMusic desktop lyrics is ON');
  console.log('  2) Play song A and wait for lyrics on Halo');
  console.log('  3) Switch to song B during this run');
  console.log('  4) Watch which layer logs CHANGED / clear / ♪');
  console.log('');

  const haloClient = dryRun ? createDryRunHalo() : new HaloClient();
  if (!dryRun) {
    try {
      const device = haloClient.connect();
      log('Halo', 'connected', device);
    } catch (error) {
      log('Halo', 'connect FAILED', { message: error.message });
      process.exitCode = 1;
      return;
    }
  }

  const pipeline = new LyricPipeline({
    haloClient,
    onStatus: (status) => log('Pipeline', 'status', { status }),
    onSent: (info) => log('Pipeline', 'onSent', { text: info.text })
  });

  const songState = new SongStateManager({
    pipeline,
    haloClient,
    onStatus: (status) => log('SongStateManager', 'status', { status }),
    onTrackChanged: (info) => {
      log('SongStateManager', 'onTrackChanged EVENT', {
        previous: info.previous,
        current: info.current,
        placeholderResult: info.placeholderResult
      });
    }
  });

  const monitor = new MediaSessionMonitor({
    onTrack: ({ track, changed }) => {
      // Delegates into instrumented handleMediaUpdate.
      songState.handleMediaUpdate(track);
      log('MediaSession', 'onTrack callback', {
        changed,
        title: track?.title || null,
        trackKey: track?.trackKey || null
      });
    },
    onError: (error) => log('MediaSession', 'ERROR', { message: error.message }),
    pollIntervalMs: 1000
  });

  const diag = instrument({ monitor, songState, pipeline, haloClient });

  const soda = new SodaLyricsDirectService({
    userDataPath,
    onStatus: (status) => log('SodaBridge', 'status', { status }),
    onPayload: (payload) => {
      log('SodaBridge', 'payload', {
        text: payload.text,
        translation: payload.translation,
        hint: payload.hint
      });
      songState.handleLyric(payload);
    },
    onLyric: (lyric) => {
      log('SodaBridge', 'onLyric', lyric
        ? { text: lyric.text, translation: lyric.translation, hint: lyric.hint }
        : null);
    }
  });

  log('Diag', 'starting media monitor + soda bridge + halo');
  await monitor.start();
  soda.setEnabled(true);

  const shutdown = () => {
    console.log('');
    console.log('=== DIAGNOSTIC SUMMARY ===');
    console.log(
      JSON.stringify(
        {
          mediaEvents: diag.mediaEvents,
          mediaChanged: diag.mediaChanged,
          lastMedia: diag.lastMedia,
          trackChangedReceived: diag.trackChangedReceived,
          pipelineClearCalls: diag.pipelineClearCalls,
          placeholderCalls: diag.placeholderCalls,
          placeholderSuccess: diag.placeholderSuccess,
          placeholderFail: diag.placeholderFail,
          haloSendTextCalls: diag.haloSendTextCalls,
          haloPlaceholderOk: diag.haloPlaceholderOk,
          lyricsSent: diag.lyricsSent,
          songState: songState.getStatus(),
          pipeline: pipeline.getStatus(),
          diagnosis: diagnose(diag)
        },
        null,
        2
      )
    );
    try { soda.stop(); } catch { /* ignore */ }
    monitor.stop().catch(() => {});
    try { haloClient.disconnect(); } catch { /* ignore */ }
    process.exit(0);
  };

  function diagnose(d) {
    const lines = [];
    if (d.mediaEvents === 0) {
      lines.push('L1 MediaSession: NO events — backend not loading or sessions empty.');
    } else if (d.mediaChanged === 0) {
      lines.push(
        'L1 MediaSession: events received but trackKey NEVER changed — ' +
          'session title/artist may be stale after switch (id may stay "汽水音乐").'
      );
    } else {
      lines.push(`L1 MediaSession: OK — ${d.mediaChanged} trackKey change(s).`);
    }

    if (d.trackChangedReceived === 0) {
      lines.push(
        'L2 SongStateManager: handleMediaUpdate never saw a key change — trackChanged path not entered.'
      );
    } else {
      lines.push(
        `L2 SongStateManager: OK — ${d.trackChangedReceived} track change(s) handled.`
      );
    }

    if (d.pipelineClearCalls === 0) {
      lines.push(
        'L3 Pipeline: clear() NEVER called — stale lastKey remains; Halo will keep old lyric until a NEW different line arrives.'
      );
    } else {
      lines.push(`L3 Pipeline: OK — clear() x${d.pipelineClearCalls}.`);
    }

    if (d.placeholderCalls === 0) {
      lines.push(
        'L4 Halo: sendText("♪") NEVER called — no placeholder overwrite on switch.'
      );
    } else if (d.placeholderSuccess === 0) {
      lines.push(
        'L4 Halo: sendText("♪") called but ALL failed — device write problem.'
      );
    } else {
      lines.push(
        `L4 Halo: OK — placeholder ♪ success ${d.placeholderSuccess}/${d.placeholderCalls}.`
      );
    }

    if (
      d.mediaChanged > 0 &&
      d.pipelineClearCalls === 0
    ) {
      lines.push(
        'SUSPECT: media detected switch but pipeline.clear not reached — check SongStateManager wiring / trackChanged throw.'
      );
    }
    if (
      d.mediaChanged === 0 &&
      d.lyricsSent > 0
    ) {
      lines.push(
        'SUSPECT: lyrics still flowing without media change detection — if you switched songs, MediaSession trackKey is not updating (layer 1 gap).'
      );
    }
    return lines;
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setTimeout(shutdown, options.durationSec * 1000);
  await new Promise(() => {});
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});
