// PixelLyrics dashboard UI (renderer only; IPC shape unchanged).
'use strict';

function el(id) {
  return document.getElementById(id);
}

const syncState = {
  lastLyricAt: 0,
  lastTrackLabel: '',
  sampleCount: 0
};

function toneFromStatus(text, fallback = 'warn') {
  const value = String(text || '');
  if (!value || value === '—' || value === '…') return fallback;
  if (/失败|错误|未找到|占用|error|fail|等待设备/i.test(value)) return 'err';
  if (/重连|等待|未运行|未连接|未开启|检测中/i.test(value)) return 'warn';
  if (/已连接|正常|直读中|监听|运行中|✓/i.test(value)) return 'ok';
  return fallback;
}

function setTone(node, tone) {
  if (!node) return;
  node.dataset.tone = tone || 'warn';
}

function setPill(node, text, tone) {
  if (!node) return;
  node.textContent = text || '…';
  node.dataset.tone = tone || 'warn';
}

function formatTrack(track) {
  if (!track) return null;
  return {
    title: track.title || '未知歌曲',
    artist: track.artist || '—'
  };
}

function formatTrackLabel(track) {
  const item = formatTrack(track);
  if (!item) return '';
  return item.artist && item.artist !== '—'
    ? `${item.title} — ${item.artist}`
    : item.title;
}

function formatSyncAgo(ts) {
  if (!ts) return '等待第一句歌词';
  const delta = Date.now() - ts;
  if (delta < 2000) return '刚刚同步';
  if (delta < 60000) return `${Math.floor(delta / 1000)} 秒前同步`;
  return `${Math.floor(delta / 60000)} 分钟前同步`;
}

function noteSyncEvent(payload) {
  const now = Date.now();
  if (payload?.timestamp) syncState.lastLyricAt = payload.timestamp;
  else syncState.lastLyricAt = now;
  syncState.sampleCount += 1;
  if (payload?.track) {
    syncState.lastTrackLabel = formatTrackLabel(payload.track);
  }
}

function renderRunBadge(status) {
  const badge = el('run-badge');
  const label = el('run-label');
  if (!badge || !label) return;
  const appState = status?.appState || 'running';
  const haloTone = toneFromStatus(status?.haloStatus, 'warn');
  const sodaTone = toneFromStatus(status?.sodaStatus, 'warn');
  if (appState === 'releasing' || haloTone === 'err') {
    badge.dataset.tone = 'err';
    label.textContent = appState === 'releasing' ? '退出中' : '需要处理';
  } else if (haloTone === 'ok' && sodaTone === 'ok') {
    badge.dataset.tone = 'ok';
    label.textContent = '运行中';
  } else {
    badge.dataset.tone = 'warn';
    label.textContent = appState === 'hidden' ? '后台运行' : '等待连接';
  }
}

function renderHero(status, event) {
  const hero = el('hero-card');
  const idle = el('idle-state');
  const playing = el('playing-state');
  const titleNode = el('track-title');
  const artistNode = el('track-artist');
  const lyricNode = el('current-lyric');
  const statusNode = el('display-status');

  let track = status?.currentTrack || null;
  let lyricText = status?.currentLyric || '';
  let mode = 'idle';

  if (event) {
    if (event.track) track = event.track;
    if (event.type === 'lyric-updated' && event.text) {
      lyricText = event.text;
      mode = 'playing';
      noteSyncEvent(event);
    } else if (
      event.type === 'track-info' ||
      event.type === 'track-changed' ||
      event.type === 'placeholder'
    ) {
      lyricText = '';
      mode = track ? 'track-only' : 'idle';
    }
  } else if (lyricText) {
    mode = 'playing';
  } else if (track) {
    mode = 'track-only';
  }

  const formatted = formatTrack(track);
  if (mode === 'idle') {
    if (titleNode) titleNode.textContent = '正在播放';
    if (artistNode) artistNode.textContent = '等待歌曲信息';
  } else if (formatted) {
    if (titleNode) titleNode.textContent = formatted.title;
    if (artistNode) artistNode.textContent = formatted.artist;
  }

  if (statusNode) {
    if (mode === 'playing') statusNode.textContent = '正在播放';
    else if (mode === 'track-only') statusNode.textContent = '切歌曲目';
    else statusNode.textContent = status?.displayStatusLabel || '等待音乐播放';
  }

  const showPlaying = mode === 'playing' && Boolean(lyricText);
  if (hero) hero.dataset.state = showPlaying ? 'playing' : 'idle';
  if (idle) idle.classList.toggle('hidden', showPlaying);
  if (playing) playing.classList.toggle('hidden', !showPlaying);
  if (lyricNode && showPlaying) lyricNode.textContent = lyricText;
}

function renderDeviceStatus(status) {
  const sodaText = status?.sodaStatus || '检测中…';
  const haloText = status?.haloStatus || '检测中…';
  const sodaTone = toneFromStatus(sodaText, 'warn');
  const haloTone = toneFromStatus(haloText, 'warn');

  const sodaNode = el('soda-status');
  const haloNode = el('halo-status');
  if (sodaNode) sodaNode.textContent = sodaText;
  if (haloNode) haloNode.textContent = haloText;

  setTone(el('soda-icon'), sodaTone);
  setTone(el('halo-icon'), haloTone);
  setPill(el('soda-pill'), sodaTone === 'ok' ? '正常' : sodaTone === 'err' ? '异常' : '待命', sodaTone);
  setPill(el('halo-pill'), haloTone === 'ok' ? '已连接' : haloTone === 'err' ? '异常' : '等待设备', haloTone);

  const lyricActive = Boolean(status?.currentLyric) || status?.displayStatusLabel === '播放';
  const bridgeOn = Boolean(status?.bridge?.enabled);
  const syncText = lyricActive ? '实时同步中' : bridgeOn ? '桥接已就绪' : '等待数据';
  const syncTone = lyricActive ? 'ok' : bridgeOn ? 'ok' : 'warn';
  const syncNode = el('sync-status');
  if (syncNode) syncNode.textContent = syncText;
  setTone(el('sync-icon'), syncTone);
  setPill(el('sync-pill'), lyricActive ? '实时' : bridgeOn ? '就绪' : '空闲', syncTone);

  const hint = el('soda-run-hint');
  if (hint) hint.textContent = status?.sodaRunningHint || '';
}

function renderRecent(status) {
  const trackNode = el('recent-track');
  const statusNode = el('recent-status');
  const label = syncState.lastTrackLabel || formatTrackLabel(status?.currentTrack);
  if (trackNode) trackNode.textContent = label || '暂无记录';
  const ago = formatSyncAgo(syncState.lastLyricAt);
  if (statusNode) {
    statusNode.textContent = ago;
    statusNode.dataset.tone = syncState.lastLyricAt ? 'ok' : 'warn';
  }
}

function renderToggles(status) {
  const hideBox = el('hide-desktop-lyrics');
  const hideState = el('hide-lyrics-state');
  if (hideBox && typeof status?.hideDesktopLyrics === 'boolean') {
    hideBox.checked = status.hideDesktopLyrics;
  }
  if (hideState) hideState.textContent = hideBox?.checked ? 'ON' : 'OFF';
  const syncLabel = el('lyrics-sync-state');
  if (syncLabel) {
    syncLabel.textContent = status?.lyricsPaused ? 'OFF' : 'ON';
  }
}

function renderStatus(status) {
  if (!status) return;
  renderRunBadge(status);
  renderDeviceStatus(status);
  renderToggles(status);
  renderHero(status, null);
  renderRecent(status);
  if (status.lastEvent) {
    renderHero(status, status.lastEvent);
    if (status.lastEvent.track) {
      syncState.lastTrackLabel = formatTrackLabel(status.lastEvent.track);
    }
  }
  if (status.currentLyric && !syncState.lastLyricAt) {
    syncState.lastLyricAt = Date.now();
    syncState.lastTrackLabel = formatTrackLabel(status.currentTrack);
  }
  renderRecent(status);
  const err = el('error-line');
  if (err) err.textContent = status.error ? status.error : '';
}

function renderEvent(event) {
  if (!event) return;
  renderHero(null, event);
  renderRecent(null);
}

function bindHideDesktopLyrics() {
  const box = el('hide-desktop-lyrics');
  const state = el('hide-lyrics-state');
  if (!box || !window.pixellyrics) return;
  if (typeof window.pixellyrics.getStatus === 'function') {
    window.pixellyrics
      .getStatus()
      .then((status) => {
        if (status && typeof status.hideDesktopLyrics === 'boolean') {
          box.checked = status.hideDesktopLyrics;
        }
        if (state) state.textContent = box.checked ? 'ON' : 'OFF';
      })
      .catch(() => {});
  }
  box.addEventListener('change', () => {
    if (state) state.textContent = box.checked ? 'ON' : 'OFF';
    if (typeof window.pixellyrics.setHideDesktopLyrics !== 'function') return;
    window.pixellyrics
      .setHideDesktopLyrics(box.checked)
      .then((result) => {
        if (result && typeof result.hideDesktopLyrics === 'boolean') {
          box.checked = result.hideDesktopLyrics;
        }
        if (state) state.textContent = box.checked ? 'ON' : 'OFF';
      })
      .catch(() => {});
  });
}

function bindConfirmModal() {
  const root = el('confirm-modal');
  const okBtn = el('confirm-ok');
  const cancelBtn = el('confirm-cancel');
  const backdrop = el('confirm-backdrop');
  const titleNode = el('confirm-title');
  const messageNode = el('confirm-message');
  const detailNode = el('confirm-detail');
  if (!root || !okBtn || !cancelBtn) return;

  const sendResult = (confirmed) => {
    root.classList.add('hidden');
    if (typeof window.pixellyrics?.confirmCloseResult === 'function') {
      window.pixellyrics.confirmCloseResult(Boolean(confirmed)).catch(() => {});
    }
  };

  const open = (payload) => {
    if (titleNode && payload?.title) titleNode.textContent = payload.title;
    if (messageNode && payload?.message) {
      messageNode.textContent = payload.message;
    }
    if (detailNode && payload?.detail) detailNode.textContent = payload.detail;
    if (okBtn && payload?.confirmText) okBtn.textContent = payload.confirmText;
    if (cancelBtn && payload?.cancelText) cancelBtn.textContent = payload.cancelText;
    root.classList.remove('hidden');
  };

  okBtn.addEventListener('click', () => sendResult(true));
  cancelBtn.addEventListener('click', () => sendResult(false));
  if (backdrop) backdrop.addEventListener('click', () => sendResult(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.classList.contains('hidden')) {
      sendResult(false);
    }
  });

  if (typeof window.pixellyrics?.onConfirmClose === 'function') {
    window.pixellyrics.onConfirmClose((payload) => open(payload));
  }
}

function bindActions() {
  const quitBtn = el('quit-app');
  if (quitBtn) {
    quitBtn.addEventListener('click', () => {
      console.log('[ui] quit-app clicked');
      // Same themed modal as window X.
      const root = el('confirm-modal');
      if (root && typeof window.pixellyrics?.onConfirmClose === 'function') {
        // Reuse modal via synthetic open through confirm-close path in main if available;
        // fallback: direct quit when modal API missing.
      }
      if (typeof window.pixellyrics.confirmCloseResult === 'function' && root) {
        const titleNode = el('confirm-title');
        const messageNode = el('confirm-message');
        const detailNode = el('confirm-detail');
        const okBtn = el('confirm-ok');
        const cancelBtn = el('confirm-cancel');
        if (titleNode) titleNode.textContent = '退出 PixelLyrics';
        if (messageNode) messageNode.textContent = '关闭应用程序将会还原花在的显示模式';
        if (detailNode) {
          detailNode.textContent =
            '确认后将停止歌词同步，并恢复 Halo 接管前的显示（读到的 scene；未知时回退时钟）。';
        }
        if (okBtn) okBtn.textContent = '退出并还原';
        if (cancelBtn) cancelBtn.textContent = '取消';
        root.classList.remove('hidden');
        return;
      }
      if (typeof window.pixellyrics.quitApp === 'function') {
        window.pixellyrics.quitApp().catch(() => {});
      }
    });
  }

  const reconnectBtn = el('reconnect-halo');
  if (reconnectBtn) {
    reconnectBtn.addEventListener('click', () => {
      console.log('[ui] reconnect-halo clicked');
      if (typeof window.pixellyrics.reconnectHalo === 'function') {
        window.pixellyrics.reconnectHalo().catch(() => {});
        return;
      }
      const err = el('error-line');
      if (err) err.textContent = '请使用托盘菜单：「重新连接花在」';
    });
  }
}

async function refresh() {
  try {
    const status = await window.pixellyrics.getStatus();
    renderStatus(status);
  } catch (error) {
    const err = el('error-line');
    if (err) err.textContent = `状态读取失败：${error.message}`;
  }
}

if (window.pixellyrics) {
  if (typeof window.pixellyrics.onLyricEvent === 'function') {
    window.pixellyrics.onLyricEvent(renderEvent);
  }
  if (typeof window.pixellyrics.onStatusUpdate === 'function') {
    window.pixellyrics.onStatusUpdate(renderStatus);
  }
}

bindHideDesktopLyrics();
bindConfirmModal();
bindActions();
refresh();
setInterval(() => {
  refresh();
  renderRecent(null);
}, 1500);
