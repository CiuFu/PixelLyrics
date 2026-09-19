// Soda chain diagnostics (read-only probe + optional log checklist).
// Usage: node tests/diagnose_soda_chain.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const asar = require('@electron/asar');

const { SodaLyricsDirectService } = require(path.join(
  __dirname,
  '..',
  'src',
  'lyrics',
  'soda-lyrics-service'
));
const { bridgeTokenPath, resolveUserDataPath, warnLegacyToken, readLegacyBridgeToken } = require(path.join(
  __dirname,
  '..',
  'src',
  'config'
));

const appRoot = path.join(__dirname, '..');
const userDataPath = resolveUserDataPath();
const electronUserData = userDataPath;
warnLegacyToken(appRoot);

function readToken(dir) {
  try {
    const p = bridgeTokenPath(dir);
    return { path: p, exists: fs.existsSync(p), token: fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '' };
  } catch (e) {
    return { path: bridgeTokenPath(dir), exists: false, token: '', error: e.message };
  }
}

function inspectAsar(svc, executable) {
  const candidates = svc.desktopLyricsAsarCandidates(executable);
  return candidates.map((archive) => {
    const exists = fs.existsSync(archive);
    let marker = false;
    let scriptHasCli = null;
    let scriptHasElectron = null;
    let scriptTokenSnippet = '';
    if (exists) {
      try {
        const html = asar.extractFile(archive, 'desktopLyrics.html').toString('utf8');
        marker = html.includes('PIXELLYRICS_SODA_LYRICS_BRIDGE_V1');
        const js = asar.extractFile(archive, 'pixellyrics-lyrics.js').toString('utf8');
        const m = js.match(/bridgeToken = '([^']+)'/);
        scriptTokenSnippet = m ? m[1] : '(not found)';
      } catch (e) {
        scriptTokenSnippet = 'extract-error: ' + e.message;
      }
    }
    return {
      archive,
      exists,
      marker,
      injectToken: scriptTokenSnippet,
      primary: archive === svc.desktopLyricsAsar(executable)
    };
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/soda-control', method: 'GET', timeout: 800 }, (res) => {
      resolve({ listening: true, statusCode: res.statusCode });
      res.resume();
    });
    req.on('error', (e) => resolve({ listening: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ listening: false, error: 'timeout' });
    });
    req.end();
  });
}

async function main() {
  console.log('=== PixelLyrics Soda chain diagnostics ===');
  console.log('');

  const unifiedToken = readToken(userDataPath);
  const legacyToken = readLegacyBridgeToken(appRoot);
  console.log('[token] unified userData ', userDataPath);
  console.log('         path/token      ', unifiedToken.path, unifiedToken.exists, unifiedToken.token || '(empty)');
  console.log('[token] legacy (unused)  ', legacyToken || '(none)');
  console.log('[token] Electron/CLI must both use unified userData token');
  console.log('');

  const hostSvc = new SodaLyricsDirectService({ userDataPath });
  const electronLikeSvc = hostSvc;

  const executable = await hostSvc.findSodaMusicExecutable();
  const running = await hostSvc.isSodaMusicRunning();
  console.log('[soda] executable', executable || '(not found)');
  console.log('[soda] running   ', running);
  console.log('');

  if (executable) {
    console.log('[asar] candidates + inject token vs host tokens:');
    const rows = inspectAsar(hostSvc, executable);
    for (const row of rows) {
      const matchUnified = row.injectToken === unifiedToken.token;
      console.log(' -', row.archive);
      console.log('   primary=', row.primary, 'exists=', row.exists, 'marker=', row.marker);
      console.log('   injectToken=', row.injectToken);
      console.log('   match unified userData token', matchUnified);
      console.log('   isBridgeInstalled', hostSvc.isBridgeInstalledSync(executable));
    }
    console.log('');
  }

  const portProbe = await probePort(19228);
  console.log('[bridge] port 19228 probe', portProbe);
  console.log('[bridge] unified-path preparePlayer simulation:');
  const statusLog = [];
  const listenSvc = new SodaLyricsDirectService({
    userDataPath,
    onStatus: (s) => statusLog.push(s),
    onPayload: () => {},
    onLyric: () => {}
  });
  await listenSvc.preparePlayer({ allowInstall: false, allowLaunch: false });
  console.log('  userData used:', listenSvc.userDataPath);
  console.log('  token        :', listenSvc.bridgeToken);
  console.log('  status chain :', statusLog.join(' | '));
  listenSvc.stop();

  console.log('');
  console.log('=== Flow comparison (post M4.5 token unify) ===');
  console.log('CLI test:soda-bridge / test:lyrics:');
  console.log('  userDataPath = resolveUserDataPath() = %APPDATA%/pixellyrics');
  console.log('Electron main.js:');
  console.log('  userDataPath = app.getPath("userData") = %APPDATA%/pixellyrics');
  console.log('  preparePlayer({allowInstall:true, allowLaunch:true}) after start');
  console.log('asar inject token must equal this unified token.');
  void electronLikeSvc;
  console.log('');
  console.log('=== Layer checklist ===');
  console.log('L0 Electron start -> setEnabled(true): should bind 127.0.0.1:19228 (unless EADDRINUSE)');
  console.log('L1 asar inject must contain the SAME token as the host process that listens');
  console.log('L2 inject POST /soda-lyric?token=... must match host token or 403');
  console.log('L3 onPayload -> SongStateManager.handleLyric -> pipeline -> halo');
  console.log('L4 Media track-changed path is independent (works without soda bridge)');
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exitCode = 1;
});
