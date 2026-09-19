// Soda bridge CLI / acceptance harness (no Halo, no UI).
// Usage:
//   node tests/test_soda_bridge.js
//   node tests/test_soda_bridge.js --probe
//   node tests/test_soda_bridge.js --listen
//   node tests/test_soda_bridge.js --install
//   node tests/test_soda_bridge.js --reconnect
//   npm run test:soda-bridge -- --reconnect
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const {
  SodaLyricsDirectService,
  BRIDGE_HOST,
  BRIDGE_PORT
} = require(path.join(__dirname, '..', 'src', 'lyrics', 'soda-lyrics-service'));
const {
  bridgeTokenPath,
  resolveUserDataPath,
  warnLegacyToken
} = require(path.join(__dirname, '..', 'src', 'config'));

// Unified with Electron: %APPDATA%/pixellyrics (not app/.pixellyrics-data)
const userDataPath = resolveUserDataPath();
fs.mkdirSync(userDataPath, { recursive: true });
warnLegacyToken(path.join(__dirname, '..'));

const state = {
  lyricCount: 0,
  payloadCount: 0,
  lastLyric: null,
  lastPayload: null,
  lastStatus: ''
};

function parseArgs(argv) {
  return {
    probe: argv.includes('--probe'),
    listen: argv.includes('--listen'),
    install: argv.includes('--install'),
    reconnect: argv.includes('--reconnect'),
    hide: argv.includes('--hide-desktop-lyrics'),
    help: argv.includes('--help') || argv.includes('-h'),
    simulate: argv.includes('--simulate')
  };
}

function logStatus(status) {
  state.lastStatus = status;
  console.log(`[status] ${status}`);
}

function logLyric(lyric) {
  state.lyricCount += 1;
  state.lastLyric = lyric;
  if (!lyric) {
    console.log('[lyric] null (cleared / waiting)');
    return;
  }
  console.log('[lyric]', JSON.stringify({
    text: lyric.text,
    translation: lyric.translation,
    hint: lyric.hint
  }, null, 0));
}

function logPayload(payload) {
  state.payloadCount += 1;
  state.lastPayload = payload;
  console.log('[payload]', JSON.stringify({
    text: payload.text,
    translation: payload.translation,
    hint: payload.hint
  }));
}

function postSimulatedLyric(token) {
  const body = JSON.stringify({
    text: '模拟歌词 Hello PixelLyrics',
    translation: 'simulated translation',
    hint: ''
  });
  const request = http.request(
    {
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: `/soda-lyric?token=${encodeURIComponent(token)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Content-Length': Buffer.byteLength(body)
      }
    },
    (response) => {
      response.resume();
      console.log(`[simulate] POST /soda-lyric -> ${response.statusCode}`);
    }
  );
  request.on('error', (error) => {
    console.log(`[simulate] POST failed: ${error.message}`);
  });
  request.end(body);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Soda bridge test CLI (PixelLyrics M3.1)

  --probe     Find SodaMusic install / running / bridge status, then exit
  --listen    Start bridge only and log lyric payloads
  --install   Start bridge, install inject if needed (requires SodaMusic exited)
  --reconnect Start bridge + install/launch (watch-heat style reconnect)
  --hide-desktop-lyrics  Ask inject to hide Soda desktop lyric window
  --simulate  Also POST a fake lyric once the bridge is listening
`);
    return 0;
  }

  console.log('=== PixelLyrics soda-lyrics bridge (M3.1) ===');
  console.log(`userData : ${userDataPath}`);
  console.log(`tokenPath: ${bridgeTokenPath(userDataPath)}`);
  console.log(`bridge   : http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  console.log('');

  const service = new SodaLyricsDirectService({
    userDataPath,
    onStatus: logStatus,
    onLyric: logLyric,
    onPayload: logPayload
  });

  console.log(`[info] bridge token loaded (${service.bridgeToken.length} chars)`);
  if (options.hide) service.setAutoHideDesktopLyrics(true);

  if (options.probe) {
    const executable = await service.findSodaMusicExecutable();
    const running = await service.isSodaMusicRunning();
    let patched = false;
    let asarStatus = [];
    if (executable) {
      patched = await service.isBridgeInstalled(executable);
      asarStatus = service.listDesktopLyricsAsarStatus(executable);
    }
    console.log('[probe] SodaMusic executable:', executable || '(not found)');
    console.log('[probe] running:', running);
    console.log('[probe] pixellyrics bridge installed (any candidate):', patched);
    console.log('[probe] desktopLyrics.asar candidates:');
    for (const item of asarStatus) {
      console.log(
        `  - ${item.archive}\n` +
          `    exists=${item.exists} marker=${item.hasMarker} installed=${item.installed}`
      );
    }
    service.stop();
    return 0;
  }

  const shouldInstall = options.install || options.reconnect;
  service.setEnabled(true);
  if (shouldInstall) {
    // Give the HTTP server a tick to bind before install messaging.
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.reconnect();
  } else {
    await service.preparePlayer({
      allowInstall: false,
      allowLaunch: false
    });
  }

  if (options.simulate) {
    setTimeout(() => postSimulatedLyric(service.bridgeToken), 300);
  }

  console.log('[info] bridge running. Open SodaMusic desktop lyrics to receive data.');
  console.log('[info] Press Ctrl+C to stop.');
  console.log('');

  const shutdown = () => {
    console.log('');
    console.log('=== shutdown summary ===');
    console.log('bridge info:', JSON.stringify(service.getBridgeInfo(), null, 2));
    console.log('payload count:', state.payloadCount);
    console.log('lyric change count:', state.lyricCount);
    console.log('last payload:', state.lastPayload);
    console.log('last lyric  :', state.lastLyric);
    console.log('last status :', state.lastStatus);
    service.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive.
  await new Promise(() => {});
  return 0;
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});
