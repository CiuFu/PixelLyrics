// SodaMusic desktop-lyrics bridge for PixelLyrics (M3.1).
//
// Third-party notice:
// Core logic adapted from HDZ123321/watch-heart-desktop
// (src/soda-lyrics-service.js).
// Upstream license: MIT (declared in package.json/README; no LICENSE file
// found in the reviewed source snapshot).
// Adapted: bridge HTTP/token handling, asar inject workflow, process/path detection.
// See THIRD_PARTY.md at the repository root.
// Core logic ported from refs/watch-heart-desktop-main/src/soda-lyrics-service.js.
// Scope: token + local HTTP bridge + lyric callbacks + install/detect + stale check.
// Not in scope: Halo, pipeline, UI, online lyrics.
'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const {
  BRIDGE_HOST,
  BRIDGE_PORT,
  BRIDGE_MARKER,
  bridgeTokenPath,
  readLegacyBridgeToken,
  resolveUserDataPath
} = require('../config');

const execFileAsync = promisify(execFile);
const UNINSTALL_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const INJECT_SCRIPT_NAME = 'pixellyrics-lyrics.js';
const TOKEN_PLACEHOLDER = '__PIXELLYRICS_BRIDGE_TOKEN__';
const STALE_AFTER_MS = 2600;

class SodaLyricsDirectService {
  constructor({ onLyric, onStatus, onPayload, userDataPath } = {}) {
    if (!userDataPath) {
      throw new Error('userDataPath is required for SodaLyricsDirectService');
    }
    this.onLyric = onLyric || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onPayload = onPayload || (() => {});
    this.userDataPath = userDataPath;
    this.tokenPath = bridgeTokenPath(userDataPath);
    this.enabled = false;
    this.autoHideDesktopLyrics = false;
    this.server = undefined;
    this.lastStatus = '';
    this.lastLyricKey = '';
    this.bridgeToken = this.loadBridgeToken();
    this.lastReceivedAt = 0;
    this.connectedOnce = false;
    this.staleTimer = undefined;
    this.warnLegacyTokenIfPresent();
  }

  warnLegacyTokenIfPresent() {
    try {
      const appRoot = path.join(__dirname, '..', '..');
      const legacyToken = readLegacyBridgeToken(appRoot);
      if (!legacyToken) return;
      const unified = resolveUserDataPath();
      const usingUnified = path.resolve(this.userDataPath) === path.resolve(unified);
      console.warn(
        '[pixellyrics] 旧 bridge token 仍存在于 app/.pixellyrics-data，已忽略，不再使用。\n' +
          `  legacyTokenPath=${bridgeTokenPath(path.join(appRoot, '.pixellyrics-data'))}\n` +
          `  current userDataPath=${this.userDataPath}\n` +
          `  unified userDataPath=${unified}\n` +
          `  usingUnified=${usingUnified}\n` +
          '  asar 注入 token 必须与 current userData token 一致，请用统一路径安装/重连。'
      );
    } catch {
      // non-fatal
    }
  }

  loadBridgeToken() {
    try {
      const saved = fs.readFileSync(this.tokenPath, 'utf8').trim();
      if (/^[A-Za-z0-9_-]{24}$/.test(saved)) return saved;
    } catch {
      // Generate a new token below.
    }
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    const token = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(this.tokenPath, token, { encoding: 'utf8', mode: 0o600 });
    return token;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return;
    this.enabled = next;
    this.clearLyric();
    if (!next) {
      this.stopServer();
      this.setStatus('未开启');
      return;
    }
    this.startServer();
    this.preparePlayer().catch((error) => {
      console.error('[soda-bridge] setup failed:', error);
      this.setStatus(`汽水直读初始化失败：${error.message}`);
    });
  }

  setAutoHideDesktopLyrics(enabled) {
    this.autoHideDesktopLyrics = Boolean(enabled);
    if (this.enabled && this.lastReceivedAt) {
      this.setStatus(
        this.autoHideDesktopLyrics
          ? '播放器直读中 · 汽水桌面歌词隐藏已启用'
          : '播放器直读中'
      );
    }
  }

  reconnect() {
    if (!this.enabled) {
      this.setStatus('请先开启汽水音乐播放器直读');
      return;
    }
    this.clearLyric();
    this.preparePlayer({ allowInstall: true, allowLaunch: true }).catch((error) => {
      console.error('[soda-bridge] reconnect failed:', error);
      this.setStatus(`汽水直读重连失败：${error.message}`);
    });
  }

  stop() {
    this.enabled = false;
    this.stopServer();
    this.clearLyric();
  }

  stopServer() {
    clearInterval(this.staleTimer);
    this.staleTimer = undefined;
    this.server?.close();
    this.server = undefined;
    this.connectedOnce = false;
  }

  setStatus(status) {
    const safeStatus = String(status || '').slice(0, 120);
    if (safeStatus === this.lastStatus) return;
    this.lastStatus = safeStatus;
    this.onStatus(safeStatus);
  }

  publishLyric(lyric) {
    const text = String(lyric?.text || '').trim().slice(0, 500);
    const translation = String(lyric?.translation || '').trim().slice(0, 500);
    const hint = String(lyric?.hint || '').trim().slice(0, 120);
    const key = `${text}\n${translation}`;
    if (key === this.lastLyricKey) return;
    this.lastLyricKey = key;
    this.onLyric(
      text
        ? { text, translation, hint, source: 'soda-direct' }
        : null
    );
  }

  clearLyric() {
    this.lastReceivedAt = 0;
    this.connectedOnce = false;
    this.lastLyricKey = '';
    this.onLyric(null);
  }

  startServer() {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response);
    });
    this.server.on('error', (error) => {
      console.error('[soda-bridge] server error:', error.message);
      this.setStatus(
        error.code === 'EADDRINUSE'
          ? `本地歌词端口 ${BRIDGE_PORT} 被占用`
          : `本地歌词服务错误：${error.message}`
      );
    });
    this.server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
      this.setStatus(`歌词桥已监听 ${BRIDGE_HOST}:${BRIDGE_PORT}`);
    });

    this.staleTimer = setInterval(() => {
      if (
        this.enabled &&
        this.lastReceivedAt &&
        Date.now() - this.lastReceivedAt > STALE_AFTER_MS
      ) {
        this.clearLyric();
        this.setStatus('播放器直读已断开（超时未收到歌词数据）');
      }
    }, 1000);
  }

  handleRequest(request, response) {
    if (!this.isLoopback(request.socket.remoteAddress)) {
      response.writeHead(403).end();
      return;
    }

    const parsedUrl = new URL(request.url || '/', `http://${BRIDGE_HOST}`);
    if (parsedUrl.searchParams.get('token') !== this.bridgeToken) {
      response.writeHead(403, { 'Cache-Control': 'no-store' }).end();
      return;
    }

    if (request.method === 'GET' && parsedUrl.pathname === '/soda-control') {
      if (!this.enabled) {
        response.writeHead(403, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      response.end(
        JSON.stringify({ hideDesktopLyrics: this.autoHideDesktopLyrics })
      );
      return;
    }

    if (!this.enabled) {
      response.writeHead(403).end();
      return;
    }

    if (request.method === 'GET' && parsedUrl.pathname === '/soda-lyric') {
      try {
        const encoded = parsedUrl.searchParams.get('data') || '';
        if (encoded.length > 4096) throw new Error('Payload too large');
        this.acceptPayload(JSON.parse(encoded));
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
      return;
    }

    if (request.method !== 'POST' || parsedUrl.pathname !== '/soda-lyric') {
      response.writeHead(404).end();
      return;
    }

    let body = '';
    let rejected = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        rejected = true;
        request.destroy();
      }
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        this.acceptPayload(JSON.parse(body));
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
  }

  isLoopback(address) {
    return (
      address === BRIDGE_HOST ||
      address === '::1' ||
      address === `::ffff:${BRIDGE_HOST}`
    );
  }

  acceptPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid lyrics payload');
    }
    this.lastReceivedAt = Date.now();
    this.connectedOnce = true;

    const normalized = {
      text: String(payload.text || '').trim(),
      translation: String(payload.translation || '').trim(),
      hint: String(payload.hint || '').trim(),
      lineIndex: Number.isFinite(payload.lineIndex) ? payload.lineIndex : null,
      lineCount: Number.isFinite(payload.lineCount) ? payload.lineCount : null,
      desktopLyricsHidden: Boolean(payload.desktopLyricsHidden)
    };
    this.lastLineIndex = normalized.lineIndex;
    this.lastLineCount = normalized.lineCount;
    this.onPayload(normalized);

    if (normalized.text) {
      this.publishLyric(normalized);
      this.setStatus(
        this.autoHideDesktopLyrics && normalized.desktopLyricsHidden
          ? '播放器直读中 · 汽水桌面歌词隐藏已启用'
          : '播放器直读中'
      );
    } else {
      this.publishLyric(null);
      this.setStatus(
        normalized.hint
          ? `汽水音乐：${normalized.hint.slice(0, 60)}`
          : '已连接汽水音乐，等待当前歌词'
      );
    }
  }

  async preparePlayer({
    allowInstall = false,
    allowLaunch = false
  } = {}) {
    this.setStatus('正在检查汽水音乐直读组件…');
    const executable = await this.findSodaMusicExecutable();
    if (!executable) {
      this.setStatus('未找到汽水音乐安装目录');
      return { executable: null, patched: false, running: false };
    }

    const patched = await this.isBridgeInstalled(executable);
    const running = await this.isSodaMusicRunning();

    if (!patched) {
      if (!allowInstall) {
        this.setStatus(
          running
            ? '直读组件未安装；请退出汽水音乐后重连安装'
            : '直读组件未安装，需先安装/重连'
        );
        return { executable, patched: false, running };
      }
      if (running) {
        this.setStatus('请完全退出汽水音乐，再安装/重连');
        return { executable, patched: false, running };
      }
      await this.installBridge(executable);
      if (!this.isBridgeInstalledSync(executable)) {
        throw new Error('Bridge install verification failed after asar replace');
      }
      this.setStatus(
        allowLaunch
          ? '直读组件安装完成，正在启动汽水音乐…'
          : '直读组件安装完成，请自行打开汽水音乐并开启桌面歌词'
      );
    }

    const stillRunning = await this.isSodaMusicRunning();
    if (!stillRunning) {
      if (!allowLaunch) {
        this.setStatus('汽水音乐未运行，请打开汽水并开启桌面歌词');
        return { executable, patched: true, running: false };
      }
      this.launchSodaMusic(executable);
    }
    this.setStatus('等待汽水音乐“桌面歌词”…');
    return {
      executable,
      patched: this.isBridgeInstalledSync(executable),
      running: await this.isSodaMusicRunning()
    };
  }

  // SodaMusic shell may boot a "small package" from <install>/Packages/<version>.
  // Desktop lyrics windows then load that package's desktopLyrics.asar via app://
  // resources resolution — not the shell's resources/desktopLyrics.asar.
  resolvePackagesDesktopLyricsAsar(executable) {
    const installRoot = path.dirname(path.dirname(executable));
    const packagesDir = path.join(installRoot, 'Packages');
    const configPath = path.join(packagesDir, 'config.json');
    if (!fs.existsSync(configPath)) return null;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const latest = String(config.latestVersion || '').trim();
      if (!latest) return null;
      const packaged = path.join(packagesDir, latest, 'desktopLyrics.asar');
      return fs.existsSync(packaged) ? packaged : null;
    } catch {
      return null;
    }
  }

  desktopLyricsAsarCandidates(executable) {
    const candidates = [];
    const packaged = this.resolvePackagesDesktopLyricsAsar(executable);
    if (packaged) candidates.push(packaged);
    candidates.push(
      path.join(path.dirname(executable), 'resources', 'desktopLyrics.asar')
    );
    return [...new Set(candidates)];
  }

  desktopLyricsAsar(executable) {
    return this.desktopLyricsAsarCandidates(executable)[0];
  }

  // Token lives in the injected JS, not in desktopLyrics.html.
  // Only the primary candidate (Packages/latest when present) counts —
  // that is the asar the running shell actually loads.
  isBridgeInstalledSync(executable) {
    return this.isBridgeInstalledSyncForArchive(
      this.desktopLyricsAsar(executable)
    );
  }

  isBridgeInstalledSyncForArchive(archive) {
    if (!fs.existsSync(archive)) return false;
    try {
      const asar = require('@electron/asar');
      const html = asar
        .extractFile(archive, 'desktopLyrics.html')
        .toString('utf8');
      if (!html.includes(BRIDGE_MARKER)) return false;
      if (!html.includes(`./${INJECT_SCRIPT_NAME}`)) return false;
      const script = asar
        .extractFile(archive, INJECT_SCRIPT_NAME)
        .toString('utf8');
      return script.includes(this.bridgeToken);
    } catch {
      return false;
    }
  }

  async isBridgeInstalled(executable) {
    return this.isBridgeInstalledSync(executable);
  }

  listDesktopLyricsAsarStatus(executable) {
    return this.desktopLyricsAsarCandidates(executable).map((archive) => {
      const exists = fs.existsSync(archive);
      let hasMarker = false;
      if (exists) {
        try {
          const asar = require('@electron/asar');
          const html = asar
            .extractFile(archive, 'desktopLyrics.html')
            .toString('utf8');
          hasMarker = html.includes(BRIDGE_MARKER);
        } catch {
          hasMarker = false;
        }
      }
      return {
        archive,
        exists,
        hasMarker,
        installed: this.isBridgeInstalledSyncForArchive(archive),
        primary: archive === this.desktopLyricsAsar(executable)
      };
    });
  }

  async installBridge(executable) {
    const archives = this.desktopLyricsAsarCandidates(executable);
    const results = [];
    for (const archive of archives) {
      results.push(await this.installBridgeIntoArchive(archive));
    }
    return { archives, results };
  }

  async installBridgeIntoArchive(archive) {
    if (!fs.existsSync(archive)) {
      throw new Error(`SodaMusic desktopLyrics.asar was not found: ${archive}`);
    }

    const asar = require('@electron/asar');
    const html = asar
      .extractFile(archive, 'desktopLyrics.html')
      .toString('utf8');
    if (this.isBridgeInstalledSyncForArchive(archive)) {
      return { alreadyInstalled: true, archive };
    }
    if (!html.includes('</body>')) {
      throw new Error(`Unsupported SodaMusic desktopLyrics.html in ${archive}`);
    }

    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pixellyrics-soda-lyrics-')
    );
    const tempAsar = `${archive}.pixellyrics-${process.pid}.tmp`;
    const oldAsar = `${archive}.pixellyrics-old`;
    const backupAsar = `${archive}.pixellyrics-backup`;

    try {
      asar.extractAll(archive, tempDirectory);
      const cleanHtml = html
        .replace(
          /\s*<script type="module" src="\.\/(?:watch-heart-lyrics|pixellyrics-lyrics)\.js"><\/script>\s*/g,
          '\n'
        )
        .replace(
          /\s*<!-- (?:WATCH_HEART_SODA_LYRICS_BRIDGE_V\d+|PIXELLYRICS_SODA_LYRICS_BRIDGE_V\d+) -->\s*/g,
          '\n'
        );

      const bridgeScript = fs
        .readFileSync(path.join(__dirname, 'soda-lyrics-inject.js'), 'utf8')
        .replace(TOKEN_PLACEHOLDER, this.bridgeToken);

      const injectedHtml = cleanHtml.replace(
        '</body>',
        `    <script type="module" src="./${INJECT_SCRIPT_NAME}"></script>\n` +
          `    <!-- ${BRIDGE_MARKER} -->\n  </body>`
      );

      fs.writeFileSync(
        path.join(tempDirectory, 'desktopLyrics.html'),
        injectedHtml,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempDirectory, INJECT_SCRIPT_NAME),
        bridgeScript,
        'utf8'
      );
      await asar.createPackage(tempDirectory, tempAsar);

      const verification = asar
        .extractFile(tempAsar, 'desktopLyrics.html')
        .toString('utf8');
      if (!verification.includes(BRIDGE_MARKER)) {
        throw new Error('SodaMusic lyrics bridge verification failed');
      }

      if (!fs.existsSync(backupAsar)) fs.copyFileSync(archive, backupAsar);
      if (fs.existsSync(oldAsar)) fs.rmSync(oldAsar, { force: true });
      fs.renameSync(archive, oldAsar);
      try {
        fs.renameSync(tempAsar, archive);
      } catch (error) {
        fs.renameSync(oldAsar, archive);
        throw error;
      }
      fs.rmSync(oldAsar, { force: true });
      return { alreadyInstalled: false, archive };
    } finally {
      if (fs.existsSync(tempAsar)) fs.rmSync(tempAsar, { force: true });
      const resolvedTemp = path.resolve(tempDirectory);
      const resolvedRoot = path.resolve(os.tmpdir());
      if (resolvedTemp.startsWith(`${resolvedRoot}${path.sep}`)) {
        fs.rmSync(resolvedTemp, { recursive: true, force: true });
      }
    }
  }

  launchSodaMusic(executable) {
    const installRoot = path.dirname(path.dirname(executable));
    const launcher = path.join(installRoot, 'SodaMusicLauncher.exe');
    const launchTarget = fs.existsSync(launcher) ? launcher : executable;
    const child = spawn(launchTarget, [], {
      cwd: path.dirname(launchTarget),
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
  }

  async isSodaMusicRunning() {
    try {
      const { stdout } = await execFileAsync(
        'tasklist.exe',
        ['/FI', 'IMAGENAME eq SodaMusic.exe', '/FO', 'CSV', '/NH'],
        { windowsHide: true, encoding: 'utf8', timeout: 3000 }
      );
      return /SodaMusic\.exe/i.test(stdout);
    } catch {
      return false;
    }
  }

  async findSodaMusicExecutable() {
    const roots = [];
    try {
      const { stdout } = await execFileAsync(
        'reg.exe',
        ['query', UNINSTALL_KEY, '/s', '/f', 'SodaMusic'],
        { windowsHide: true, encoding: 'utf8', timeout: 5000 }
      );
      const match = stdout.match(/DisplayIcon\s+REG_SZ\s+(.+)/i);
      if (match) {
        roots.push(path.dirname(match[1].trim().replace(/^"|"$/g, '')));
      }
    } catch {
      // Fall through to conventional install locations.
    }

    roots.push(
      path.join(process.env.LOCALAPPDATA || '', 'SodaMusic'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'SodaMusic')
    );

    for (const root of [...new Set(roots.filter(Boolean))]) {
      const direct = path.join(root, 'SodaMusic.exe');
      if (fs.existsSync(direct)) return direct;

      try {
        const config = JSON.parse(
          fs.readFileSync(path.join(root, 'launcher_config.json'), 'utf8')
        );
        if (/^[\w.-]+$/.test(config.cur_path || '')) {
          const current = path.join(root, config.cur_path, 'SodaMusic.exe');
          if (fs.existsSync(current)) return current;
        }
      } catch {
        // Try version folders below.
      }

      try {
        const versions = fs
          .readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions) {
          const candidate = path.join(root, version, 'SodaMusic.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch {
        // Continue with the next root.
      }
    }
    return null;
  }

  getBridgeInfo() {
    return {
      enabled: this.enabled,
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      marker: BRIDGE_MARKER,
      tokenPath: this.tokenPath,
      lastStatus: this.lastStatus,
      lastReceivedAt: this.lastReceivedAt,
      connectedOnce: this.connectedOnce
    };
  }
}

module.exports = {
  SodaLyricsDirectService,
  BRIDGE_HOST,
  BRIDGE_PORT,
  BRIDGE_MARKER,
  INJECT_SCRIPT_NAME
};
