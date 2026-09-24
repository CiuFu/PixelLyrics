// Electron preload — status + lyric-event IPC (M4.4).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pixellyrics', {
  getStatus: () => ipcRenderer.invoke('getStatus'),
  onStatusUpdate: (handler) => {
    ipcRenderer.on('status-update', (_event, status) => handler(status));
  },
  onLyricEvent: (handler) => {
    ipcRenderer.on('lyric-event', (_event, payload) => handler(payload));
  },
  onConfirmClose: (handler) => {
    ipcRenderer.on('confirm-close', (_event, payload) => handler(payload));
  },
  confirmCloseResult: (result) =>
    ipcRenderer.invoke('confirm-close-result', result),
  getHideDesktopLyrics: () => ipcRenderer.invoke('get-hide-desktop-lyrics'),
  setHideDesktopLyrics: (enabled) =>
    ipcRenderer.invoke('set-hide-desktop-lyrics', Boolean(enabled)),
  setCloseBehavior: (behavior) =>
    ipcRenderer.invoke('set-close-behavior', behavior),
  quitApp: () => ipcRenderer.invoke('quit-app')
});
