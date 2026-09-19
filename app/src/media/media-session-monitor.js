// Windows media session monitor (M4.2).
// Uses windows-media-sessions like refs/watch-heart-desktop-main/src/media-service.js,
// but only exposes current-track identity — no online lyrics.
'use strict';

function cleanText(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  let text = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f) text += ch;
  }
  return text.trim().slice(0, maxLength);
}

function buildTrackKey({ id, artist, title }) {
  return [cleanText(id, 300), cleanText(artist), cleanText(title)].join(' | ');
}

function normalizeSession(session) {
  if (!session || !session.title) return null;
  const id = cleanText(session.id, 300);
  const title = cleanText(session.title);
  const artist = cleanText(session.artist);
  const album = cleanText(session.albumTitle);
  const playbackStatus = cleanText(session.playbackStatus, 40) || 'unknown';
  return {
    id,
    title,
    artist,
    album,
    playbackStatus,
    playing: playbackStatus === 'playing',
    positionMs: Math.max(0, Number(session.timeline?.positionMs) || 0),
    durationMs: Math.max(0, Number(session.timeline?.durationMs) || 0),
    capturedAt: Date.now(),
    trackKey: buildTrackKey({ id, artist, title })
  };
}

function pickPrimarySession(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return (
    list.find((s) => s.playbackStatus === 'playing' && s.title) ||
    list.find((s) => s.playbackStatus === 'paused' && s.title) ||
    null
  );
}

class MediaSessionMonitor {
  constructor({ onTrack, onError, backend, pollIntervalMs = 1000 } = {}) {
    this.onTrack = onTrack || (() => {});
    this.onError = onError || (() => {});
    this.backend = backend || null;
    this.pollIntervalMs = pollIntervalMs;
    this.unsubscribe = undefined;
    this.timer = undefined;
    this.running = false;
    this.lastTrackKey = '';
  }

  loadDefaultBackend() {
    if (this.backend) return this.backend;
    this.backend = require('windows-media-sessions');
    return this.backend;
  }

  normalizeFromSessions(sessions) {
    return normalizeSession(pickPrimarySession(sessions));
  }

  emitTrack(track) {
    const trackKey = track?.trackKey || '';
    const changed = trackKey !== this.lastTrackKey;
    const previousTrackKey = this.lastTrackKey;
    this.lastTrackKey = trackKey;
    this.onTrack({ track, changed, previousTrackKey });
    return changed;
  }

  async pollOnce() {
    const backend = this.loadDefaultBackend();
    const sessions = await backend.getAllSessions();
    const track = this.normalizeFromSessions(sessions);
    this.emitTrack(track);
    return track;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const backend = this.loadDefaultBackend();
    const handle = (sessions) => {
      try {
        const track = this.normalizeFromSessions(sessions);
        this.emitTrack(track);
      } catch (error) {
        this.onError(error);
      }
    };
    try {
      handle(await backend.getAllSessions());
      if (typeof backend.onSessionsChanged === 'function') {
        this.unsubscribe = backend.onSessionsChanged(handle);
      }
    } catch (error) {
      this.onError(error);
    }
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => this.onError(error));
    }, this.pollIntervalMs);
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch { /* ignore */ }
      this.unsubscribe = undefined;
    }
    try {
      const backend = this.backend;
      if (backend && typeof backend.shutdown === 'function') {
        await backend.shutdown();
      }
    } catch { /* ignore */ }
  }
}

module.exports = {
  MediaSessionMonitor,
  buildTrackKey,
  normalizeSession,
  pickPrimarySession,
  cleanText
};