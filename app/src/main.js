// PixelLyrics Electron main (M4.3/M4.4).
// UI lyric preview is driven only by LyricPipeline events (final Halo-path results).
'use strict';

// Best-effort: mark Node streams as UTF-8. Windows console still needs chcp 65001
// for readable Chinese logs (see README).
try {
  if (process.stdout && process.stdout.setDefaultEncoding) {
    process.stdout.setDefaultEncoding('utf8');
  }
  if (process.stderr && process.stderr.setDefaultEncoding) {
    process.stderr.setDefaultEncoding('utf8');
  }
} catch {
  // ignore
}

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Packaged Windows build: native backend lives in asar.unpacked (electron-builder).
if (app.isPackaged && process.platform === 'win32') {
  process.env.WINDOWS_MEDIA_SESSIONS_BACKEND = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'windows-media-sessions',
    'bin',
    'win-x64',
    'windows-media-sessions-backend.exe'
  );
}

const { SodaLyricsDirectService } = require('./lyrics/soda-lyrics-service');
const { HaloClient } = require('./halo/device');
const { LyricPipeline } = require('./pipeline/lyric-pipeline');
const { SongStateManager } = require('./media/song-state-manager');
const { MediaSessionMonitor } = require('./media/media-session-monitor');
const { DisplayStrategy } = require('./halo/display-strategy');
const { HaloOwnership } = require('./halo/ownership');
const { createAppLifecycle } = require('./app-lifecycle');
const { BRIDGE_HOST, BRIDGE_PORT } = require('./config');

let mainWindow = null;
let tray = null;
let sodaService = null;
let haloClient = null;
let haloOwnership = null;
let pipeline = null;
let songState = null;
let mediaMonitor = null;
let shuttingDown = false;
let isQuitting = false;
const lifecycle = createAppLifecycle();
const INSTRUMENTAL_TEXT = '纯音乐，请欣赏';

const runtime = {
  startedAt: null,
  sodaStatus: '未启动',
  haloStatus: '未连接',
  haloDevice: null,
  // Preview state — updated ONLY from pipeline events.
  currentLyric: '',
  instrumental: false,
  displayStatus: 'idle',
  displayLyricHint: '',
  lastEvent: null,
  mediaAvailable: false,
  hideDesktopLyrics: true,
  closeBehavior: 'ask',
  lyricsPaused: false,
  sodaRunning: null,
  sodaRunningHint: '',
  error: ''
};

function statusLabel(eventType, status) {
  if (eventType === 'lyric-updated' || status === 'playing') return '播放';
  // Track title sent to Halo is track-info, not a lyric line.
  if (
    eventType === 'track-info' ||
    eventType === 'placeholder' ||
    status === 'track-info' ||
    status === 'placeholder'
  ) {
    return '切歌曲目';
  }
  if (eventType === 'track-changed' || status === 'track-changed') return '切歌';
  return status || eventType || '就绪';
}

function getStatus() {
  const track = songState ? songState.getTrackInfo() : null;
  const pipelineStatus = pipeline ? pipeline.getStatus() : null;
  return {
    sodaStatus: runtime.sodaStatus,
    haloStatus: runtime.haloStatus,
    currentTrack: track
      ? {
          title: track.title || '',
          artist: track.artist || '',
          album: track.album || '',
          trackKey: track.trackKey || '',
          playbackStatus: track.playbackStatus || ''
        }
      : null,
    // Pipeline final preview only — never raw soda payload text.
    currentLyric: runtime.currentLyric,
    instrumental: runtime.instrumental,
    lyricHint:
      runtime.currentLyric
        ? ''
        : runtime.displayLyricHint || (runtime.lastEvent ? '等待歌词' : ''),
    displayStatus: runtime.displayStatus,
    displayStatusLabel: statusLabel(runtime.lastEvent?.type, runtime.displayStatus),
    lastEvent: runtime.lastEvent,
    bridge: {
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      enabled: Boolean(sodaService?.enabled)
    },
    pipeline: pipelineStatus
      ? {
          lastText: pipelineStatus.lastText,
          sentCount: pipelineStatus.sentCount,
          trackEpoch: pipelineStatus.trackEpoch,
          lastEvent: pipelineStatus.lastEvent
        }
      : null,
    mediaAvailable: runtime.mediaAvailable,
    hideDesktopLyrics: runtime.hideDesktopLyrics,
    closeBehavior: runtime.closeBehavior,
    sodaRunning: runtime.sodaRunning,
    sodaRunningHint: runtime.sodaRunningHint,
    appState: lifecycle.getState(),
    lyricsPaused: lifecycle.isLyricsPaused(),
    windowVisible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    haloOwnership: haloOwnership
      ? {
          state: haloOwnership.getState(),
          snapshot: haloOwnership.getSnapshot(),
          preTakeoverMode: haloOwnership.getPreTakeoverMode
            ? haloOwnership.getPreTakeoverMode()
            : null
        }
      : null,
    error: runtime.error || '',
    startedAt: runtime.startedAt
  };
}

function pushLyricEvent(event) {
  runtime.lastEvent = event;
  if (['lyric-updated', 'track-info', 'track-changed'].includes(event.type)) {
    runtime.instrumental = false;
  }
  runtime.displayStatus = event.status || event.type;
  if (event.type === 'lyric-updated') {
    // Real lyric line (same content Halo shows for lyrics).
    runtime.currentLyric = event.text || '';
  } else if (
    event.type === 'track-info' ||
    event.type === 'placeholder' ||
    event.type === 'track-changed'
  ) {
    // Song title on Halo / song switch — not a lyric.
    runtime.currentLyric = '';
    runtime.displayLyricHint = '等待歌词';
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lyric-event', event);
    mainWindow.webContents.send('status-update', getStatus());
  }
}

function pushStatus() {
  const status = getStatus();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', status);
  }
  return status;
}

function setSodaStatus(status) {
  runtime.sodaStatus = String(status || '');
  if (runtime.sodaStatus.includes('纯音乐')) {
    runtime.instrumental = true;
  } else if (runtime.instrumental) {
    runtime.instrumental = false;
    runtime.displayLyricHint = '';
  }
  pushStatus();
}

function isInstrumentalHint(hint) {
  return String(hint || '').includes('纯音乐');
}

/**
 * Poll SodaMusic process only — never launch Soda, never click desktop-lyrics UI.
 * When running is detected, hint user to open desktop lyrics manually.
 */
function startSodaRunningPoll() {
  if (runtime.sodaPollTimer) {
    clearInterval(runtime.sodaPollTimer);
    runtime.sodaPollTimer = undefined;
  }
  const HINT_RUNNING =
    '检测到汽水已运行，请在汽水中打开桌面歌词';
  runtime.sodaPollTimer = setInterval(async () => {
    if (!sodaService || shuttingDown || isQuitting) return;
    try {
      const running = await sodaService.isSodaMusicRunning();
      const was = runtime.sodaRunning;
      runtime.sodaRunning = running;
      if (running) {
        if (!was) {
          console.log(`[main] ${HINT_RUNNING}`);
        }
        runtime.sodaRunningHint = HINT_RUNNING;
      } else {
        if (was) {
          console.log('[main] 汽水音乐未运行');
        }
        runtime.sodaRunningHint = '';
      }
      pushStatus();
    } catch (error) {
      // Poll must never crash the app.
      console.log('[main] soda running poll error', error.message);
    }
  }, 3000);
}

function stopSodaRunningPoll() {
  if (runtime.sodaPollTimer) {
    clearInterval(runtime.sodaPollTimer);
    runtime.sodaPollTimer = undefined;
  }
}

function setHaloStatus(status, device) {
  runtime.haloStatus = String(status || '');
  if (device !== undefined) runtime.haloDevice = device;
  pushStatus();
}

function haloStatusFromState(state) {
  if (state === 'connected') return '✓ 已连接';
  if (state === 'reconnecting') return '⚠ 未连接 正在重连...';
  return '⚠ 等待设备';
}

function startServices() {
  const userDataPath = app.getPath('userData');
  fs.mkdirSync(userDataPath, { recursive: true });
  runtime.startedAt = new Date().toISOString();

  haloClient = new HaloClient({
    reconnectIntervalMs: 2000,
    onStatus: (evt) => {
      console.log(evt.message);
      const device = evt.device || null;
      if (evt.state === 'connected') {
        setHaloStatus(haloStatusFromState('connected'), device);
      } else if (evt.state === 'reconnecting') {
        setHaloStatus(haloStatusFromState('reconnecting'), null);
      } else if (evt.state === 'waiting') {
        setHaloStatus(haloStatusFromState('waiting'), null);
      } else {
        setHaloStatus(evt.message || haloStatusFromState(evt.state), device);
      }
    },
    onReconnect: (device) => {
      // Optional restore: resend current lyric after HID is back.
      const restore = runtime.currentLyric ||
        (runtime.instrumental ? INSTRUMENTAL_TEXT : '');
      if (restore && runtime.display) {
        console.log('[halo] restore lyric after reconnect:', restore);
        Promise.resolve(runtime.display.sendText(restore)).catch((error) => {
          console.log('[halo] restore lyric failed:', error.message);
        });
      }
      setHaloStatus(haloStatusFromState('connected'), device);
    }
  });
  runtime.display = null;

  // Display + ownership MUST exist before any lyric or capture call.
  const display = new DisplayStrategy({
    haloClient,
    shortThreshold: 15,
    windowChars: 16,
    windowHoldMs: 900,
    resetDelayMs: 300,
    cycleSep: ' ',
    enableCyclicWindow: true,
    onStatus: (status) => {
      console.log('[display]', status);
    },
    onTicker: (payload) => {
      console.log('[ticker]', JSON.stringify(payload));
      // Mark ownership active as soon as first Halo window is written.
      if (haloOwnership && payload && payload.text) {
        haloOwnership.noteDisplay(payload.text, payload.mode || 'center');
      }
    }
  });
  runtime.display = display;

  haloOwnership = new HaloOwnership({
    haloClient: display,
    onStatus: (status) => {
      console.log(status);
    },
    canRestoreText: true
  });
  runtime.haloOwnership = haloOwnership;

  // Connect Halo, THEN capture pre-lyrics mode (before soda/pipeline traffic).
  try {
    const device = haloClient.connect();
    setHaloStatus(haloStatusFromState('connected'), device);
    console.log('[main] capturing Halo mode before lyrics...');
    const captured = haloOwnership.captureBeforeLyrics('startup');
    Promise.resolve(captured).then((mode) => {
      console.log(
        '[main] capture result=',
        JSON.stringify({
          ok: mode?.ok,
          scene: mode?.scene,
          reason: mode?.reason
        })
      );
      pushStatus();
    }).catch((error) => {
      console.log('[halo-ownership] capture error', error.message);
    });
  } catch (error) {
    runtime.error = error.message;
    setHaloStatus(haloStatusFromState('waiting'), null);
    console.log('[main] capture skipped — Halo not connected', error.message);
    try {
      haloClient.startReconnect();
    } catch (reconnectError) {
      console.log('[halo] startReconnect failed', reconnectError.message);
    }
  }

  pipeline = new LyricPipeline({
    haloClient: display,
    onStatus: (status) => {
      console.log('[pipeline]', status);
      pushStatus();
    },
    onSent: (info) => {
      console.log('[halo] send lyric', JSON.stringify({ text: info.text, mode: info.mode }));
      runtime.error = '';
      if (haloOwnership && info && info.text) {
        haloOwnership.noteDisplay(info.text, info.mode || 'center');
      }
    },
    onEvent: (event) => {
      console.log('[pipeline] event', event.type, JSON.stringify({ text: event.text, status: event.status }));
      pushLyricEvent(event);
    }
  });

  songState = new SongStateManager({
    pipeline,
    haloClient: display,
    onStatus: (status) => {
      console.log('[song-state]', status);
      pushStatus();
    },
    onTrackChanged: (info) => {
      if (typeof pipeline.setTrack === 'function') {
        pipeline.setTrack(info.current);
      }
      pushStatus();
    }
  });

  mediaMonitor = new MediaSessionMonitor({
    onTrack: (payload) => {
      runtime.mediaAvailable = true;
      Promise.resolve(songState.handleMediaUpdate(payload.track)).catch((error) => {
        console.log('[song-state] media error', error.message);
      });
      if (typeof pipeline.setTrack === 'function') {
        pipeline.setTrack(songState.getTrackInfo());
      }
      pushStatus();
    },
    onError: (error) => {
      runtime.mediaAvailable = false;
      runtime.error = `媒体会话：${error.message}`;
      pushStatus();
    },
    pollIntervalMs: 1000
  });

  sodaService = new SodaLyricsDirectService({
    userDataPath,
    onStatus: (status) => {
      console.log('[soda] status:', status);
      setSodaStatus(status);
    },
    onPayload: (payload) => {
      // Tray pause gate — does not change SodaLyricsDirectService / Pipeline modules.
      if (lifecycle.isLyricsPaused()) {
        return;
      }
      console.log('[soda] payload:', JSON.stringify({
        text: payload.text,
        translation: payload.translation,
        hint: payload.hint
      }));
      if (!payload.text && isInstrumentalHint(payload.hint)) {
        runtime.instrumental = true;
        runtime.currentLyric = '';
        runtime.displayLyricHint = INSTRUMENTAL_TEXT;
        Promise.resolve(runtime.display.sendText(INSTRUMENTAL_TEXT)).catch((error) => {
          console.log('[halo] pure-music hint send failed:', error.message);
        });
        pushStatus();
        return;
      }
      if (payload.text) {
        runtime.instrumental = false;
        runtime.displayLyricHint = '';
      }
      console.log('[pipeline] lyric received');
      // Mark ownership as soon as a lyric line arrives (don't wait for cyclic loop end).
      if (haloOwnership && payload && payload.text) {
        haloOwnership.noteDisplay(payload.text, 'cyclic-or-center');
      }
      Promise.resolve(songState.handleLyric(payload)).catch((error) => {
        console.log('[pipeline] lyric error', error.message);
      });
    },
    onLyric: () => {
      pushStatus();
    }
  });

  mediaMonitor
    .start()
    .then(() => mediaMonitor.pollOnce().catch(() => null))
    .catch((error) => {
      runtime.mediaAvailable = false;
      runtime.error = error.message;
    });

  sodaService.setEnabled(true);
  // Hide Soda desktop-lyrics window visuals only; do NOT disable the feature.
  runtime.closeBehavior = loadCloseBehavior(userDataPath);
  applyHideDesktopLyrics(loadHideDesktopLyrics(userDataPath));
  startSodaRunningPoll();
  console.log('[diag] soda enabled=', sodaService.enabled, 'userData=', userDataPath);
  console.log('[diag] soda tokenPath=', sodaService.tokenPath);
  console.log('[diag] soda token=', sodaService.bridgeToken);
  console.log('[diag] bridge target=', `${BRIDGE_HOST}:${BRIDGE_PORT}`);

  // Install/reconnect with the SAME userData token as this Electron process.
  // Do NOT auto-launch SodaMusic on app start — user opens Soda themselves.
  // allowInstall: patch asar only when Soda is not running; never spawn SodaMusic.exe.
  sodaService
    .preparePlayer({ allowInstall: true, allowLaunch: false })
    .then((result) => {
      console.log('[diag] preparePlayer result=', JSON.stringify(result));
      if (executableHint(result)) {
        console.log(
          '[diag] asarInstalled=',
          sodaService.isBridgeInstalledSync(result.executable)
        );
      }
      if (result && result.running === false) {
        console.log('[main] SodaMusic not running — waiting for user to open it');
      }
      pushStatus();
    })
    .catch((error) => {
      console.log('[diag] preparePlayer error=', error.message);
      pushStatus();
    });
}

function executableHint(result) {
  return Boolean(result && result.executable);
}

function hideDesktopLyricsSettingsPath(userDataPath) {
  return path.join(userDataPath, 'hide-desktop-lyrics.json');
}

function loadHideDesktopLyrics(userDataPath) {
  // Default: hide visual only; keep Soda desktop-lyrics feature + bridge on.
  try {
    const p = hideDesktopLyricsSettingsPath(userDataPath);
    if (!fs.existsSync(p)) return true;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data.hideDesktopLyrics !== false;
  } catch {
    return true;
  }
}

function loadCloseBehavior(userDataPath) {
  try {
    const data = JSON.parse(
      fs.readFileSync(hideDesktopLyricsSettingsPath(userDataPath), 'utf8')
    );
    return ['ask', 'quit', 'minimize'].includes(data.closeBehavior)
      ? data.closeBehavior
      : 'ask';
  } catch {
    return 'ask';
  }
}

function saveHideDesktopLyrics(userDataPath, enabled) {
  try {
    const p = hideDesktopLyricsSettingsPath(userDataPath);
    fs.writeFileSync(
      p,
      JSON.stringify({
        hideDesktopLyrics: Boolean(enabled),
        closeBehavior: runtime.closeBehavior
      }, null, 2),
      'utf8'
    );
  } catch (error) {
    console.log('[diag] save hide-desktop-lyrics failed', error.message);
  }
}

function applyHideDesktopLyrics(enabled) {
  const next = Boolean(enabled);
  runtime.hideDesktopLyrics = next;
  if (sodaService) {
    sodaService.setAutoHideDesktopLyrics(next);
    console.log('[diag] hideDesktopLyrics=', next, '(CSS hide only; bridge/DOM unchanged)');
  }
  pushStatus();
  return next;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  lifecycle.showWindow();
  console.log('[tray] window restored');
  pushStatus();
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  }
  lifecycle.hideWindow();
  console.log('[tray] window hidden');
  pushStatus();
}

function requestAppQuit(reason = 'quit') {
  console.log('[main] quit requested', reason);
  isQuitting = true;
  lifecycle.beginRelease();
  app.quit();
}

let windowCloseDialogOpen = false;

/**
 * Window X: apply the saved policy or ask whether to quit or hide to tray.
 */
function confirmWindowCloseAndQuit() {
  if (isQuitting || windowCloseDialogOpen) return;
  if (runtime.closeBehavior === 'quit') {
    requestAppQuit('window-close-setting');
    return;
  }
  if (runtime.closeBehavior === 'minimize') {
    hideMainWindow();
    return;
  }
  const win =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    requestAppQuit('window-close');
    return;
  }
  if (!win.isVisible()) win.show();
  win.focus();
  windowCloseDialogOpen = true;
  console.log('[main] window close — ask UI confirm (themed modal)');
  win.webContents.send('confirm-close', {
    reason: 'window-close',
    title: '关闭 PixelLyrics',
    message: '请选择关闭方式',
    detail:
      '退出会停止歌词同步并恢复 Halo 接管前的显示；最小化后会继续在后台同步。',
    confirmText: '退出并还原',
    cancelText: '取消',
    minimizeText: '最小化到托盘'
  });
}

ipcMain.handle('confirm-close-result', (_event, result) => {
  windowCloseDialogOpen = false;
  const action = typeof result === 'boolean'
    ? (result ? 'quit' : 'cancel')
    : result?.action;
  if (result?.remember && ['quit', 'minimize'].includes(action)) {
    runtime.closeBehavior = action;
    saveHideDesktopLyrics(app.getPath('userData'), runtime.hideDesktopLyrics);
    pushStatus();
  }
  if (action === 'quit') {
    console.log('[main] close confirm OK — quit and restore Halo');
    requestAppQuit('window-close');
    return { quit: true };
  }
  if (action === 'minimize') {
    hideMainWindow();
    return { quit: false, hidden: true };
  }
  console.log('[main] close confirm cancelled — keep running');
  return { quit: false };
});

function rebuildTrayMenu() {
  if (!tray) return;
  const paused = lifecycle.isLyricsPaused();
  const menu = Menu.buildFromTemplate([
    { label: 'PixelLyrics', enabled: false },
    {
      label: '打开主窗口',
      click: () => showMainWindow()
    },
    {
      label: '重新连接花在',
      click: () => {
        console.log('[tray] reconnect halo');
        try {
          if (haloClient) {
            haloClient.stopReconnect();
            haloClient.connect();
            setHaloStatus('✓ 已连接', haloClient.getDeviceInfo());
          }
        } catch (error) {
          setHaloStatus('⚠ 等待设备', null);
          try {
            haloClient?.startReconnect();
          } catch {
            // ignore
          }
        }
        pushStatus();
      }
    },
    {
      label: paused ? '恢复歌词同步' : '暂停歌词同步',
      click: () => {
        const next = !lifecycle.isLyricsPaused();
        lifecycle.setLyricsPaused(next);
        runtime.lyricsPaused = next;
        console.log(`[tray] lyrics ${next ? 'paused' : 'resumed'}`);
        rebuildTrayMenu();
        pushStatus();
      }
    },
    { type: 'separator' },
    {
      label: '退出并释放花在',
      click: () => requestAppQuit('tray-quit')
    }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(
    `PixelLyrics · ${lifecycle.getState()}${lifecycle.isLyricsPaused() ? ' · 暂停同步' : ''}`
  );
}

function loadAppIcon() {
  try {
    return nativeImage.createFromBuffer(
      fs.readFileSync(path.join(__dirname, '..', 'assets', 'pixellyrics.png'))
    );
  } catch {
    return nativeImage.createEmpty();
  }
}

async function createTray() {
  if (tray) return tray;
  let icon = loadAppIcon();
  if (icon.isEmpty()) {
    try {
      icon = await app.getFileIcon(process.execPath, { size: 'small' });
    } catch {
      // Keep an empty icon only if Windows cannot provide the executable icon.
    }
  }
  try {
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
  } catch {
    tray = new Tray(icon);
  }
  rebuildTrayMenu();
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  console.log('[tray] created');
  return tray;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 560,
    backgroundColor: '#0b0d12',
    icon: loadAppIcon(),
    title: 'PixelLyrics',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    pushStatus();
    if (runtime.lastEvent && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyric-event', runtime.lastEvent);
    }
  });
  // X = confirm quit + restore Halo (not silent hide).
  // Never window.closed -> app.quit; always go through before-quit release path.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    confirmWindowCloseAndQuit();
  });
}

ipcMain.handle('getStatus', () => getStatus());
ipcMain.handle('quit-app', () => {
  console.log('[main] quit-app received');
  requestAppQuit('ui-quit');
  return { quitting: true };
});
ipcMain.on('quit-app', () => {
  console.log('[main] quit-app received');
  requestAppQuit('ui-quit');
});
ipcMain.handle('get-hide-desktop-lyrics', () => Boolean(runtime.hideDesktopLyrics));
ipcMain.handle('set-hide-desktop-lyrics', (_event, enabled) => {
  const next = applyHideDesktopLyrics(enabled);
  const userDataPath = app.getPath('userData');
  saveHideDesktopLyrics(userDataPath, next);
  return { hideDesktopLyrics: next };
});
ipcMain.handle('set-close-behavior', (_event, behavior) => {
  if (!['ask', 'quit', 'minimize'].includes(behavior)) {
    return { closeBehavior: runtime.closeBehavior };
  }
  runtime.closeBehavior = behavior;
  saveHideDesktopLyrics(app.getPath('userData'), runtime.hideDesktopLyrics);
  pushStatus();
  return { closeBehavior: runtime.closeBehavior };
});

app.whenReady().then(async () => {
  startServices();
  createWindow();
  await createTray();
  lifecycle.showWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Tray residency: do not quit when window is closed/hidden.
});

app.on('before-quit', async (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  isQuitting = true;
  lifecycle.beginRelease();
  event.preventDefault();
  console.log('[tray] quit requested');
  try {
    if (haloOwnership) {
      await haloOwnership.release({ reason: 'app-quit' });
    } else {
      try {
        haloClient?.stopReconnect();
        haloClient?.disconnect();
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.log('[halo-ownership] release error', error.message);
  }
  try {
    sodaService?.stop();
  } catch {
    // ignore
  }
  stopSodaRunningPoll();
  if (mediaMonitor) {
    mediaMonitor.stop().catch(() => {});
  }
  try {
    haloClient?.stopReconnect();
  } catch {
    // ignore
  }
  try {
    if (tray && !tray.isDestroyed()) tray.destroy();
  } catch {
    // ignore
  }
  lifecycle.markExited();
  console.log('[tray] app exited');
  app.exit(0);
});
