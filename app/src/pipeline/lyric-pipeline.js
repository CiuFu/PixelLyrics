// Soda bridge lyric -> Halo PixelBar pipeline (M4.5/M4.6 display strategy).
// Dedupe/time-window stay here. Layout vs center vs scroll is delegated to
// DisplayStrategy (haloClient.sendText) — protocol packet format unchanged.
'use strict';

const { normalizeLyricText } = require('../halo/lyrics-layout');

const DEFAULT_DEDUPE_WINDOW_MS = 2000;

function normalizeKey(text) {
  return normalizeLyricText(text);
}

class LyricPipeline {
  /**
   * @param {{
   *   haloClient: { sendText(text: string, options?: object): unknown, sendPackets?: Function },
   *   onStatus?: (status: string) => void,
   *   onSent?: (info: object) => void,
   *   onCleared?: (info: object) => void,
   *   onEvent?: (event: object) => void,
   *   dedupeWindowMs?: number,
   *   now?: () => number,
   *   layout?: string,
   *   rgb?: [number, number, number]
   * }} options
   */
  constructor({
    haloClient,
    onStatus,
    onSent,
    onCleared,
    onEvent,
    dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    now,
    layout = 'scroll_right_to_left',
    rgb
  } = {}) {
    if (!haloClient || typeof haloClient.sendText !== 'function') {
      throw new Error('LyricPipeline requires haloClient.sendText');
    }
    this.haloClient = haloClient;
    this.onStatus = onStatus || (() => {});
    this.onSent = onSent || (() => {});
    this.onCleared = onCleared || (() => {});
    this.onEvent = onEvent || (() => {});
    this.dedupeWindowMs = Number.isFinite(dedupeWindowMs) ? dedupeWindowMs : DEFAULT_DEDUPE_WINDOW_MS;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.layout = layout;
    this.rgb = rgb;

    this.currentTrack = null;
    // Send-policy state (M4.5)
    this.currentDisplayedText = '';
    this.lastSentTime = 0;
    this.lyricVersion = 0;
    this.lastLineIndex = null;
    this.lastLineCount = null;

    this.lastHint = '';
    this.lastEvent = null;
    this.trackEpoch = 0;
    this.sentCount = 0;
    this.skippedCount = 0;
    this.clearCount = 0;
    this.errorCount = 0;
    this.lastError = '';
  }

  // Compatibility aliases used by older tests / callers.
  get lastText() {
    return this.currentDisplayedText;
  }

  get lastKey() {
    return this.currentDisplayedText;
  }

  emitEvent(type, detail = {}) {
    const payload = {
      type,
      text: detail.text != null ? String(detail.text) : '',
      track: detail.track !== undefined ? detail.track : this.currentTrack,
      timestamp: this.now(),
      status: detail.status || type
    };
    this.lastEvent = payload;
    this.onEvent(payload);
    return payload;
  }

  setTrack(track) {
    this.currentTrack = track || null;
  }

  publishTrackInfo(text, track) {
    return this.emitEvent('track-info', {
      text: text != null ? String(text) : '',
      track: track !== undefined ? track : this.currentTrack,
      status: 'track-info'
    });
  }

  publishPlaceholder(text, track) {
    return this.publishTrackInfo(text, track);
  }

  // Delegate layout and page timing to DisplayStrategy.
  async sendFullDisplay(text, meta = {}) {
    const options = {};
    if (meta.reason) options.reason = meta.reason;
    if (meta.layout) options.layout = meta.layout;
    return this.haloClient.sendText(text, options);
  }

  async handleLyric(lyric) {
    const text = normalizeKey(lyric?.text);
    const hint = normalizeKey(lyric?.hint);
    const lineIndex = Number.isFinite(lyric?.lineIndex) ? lyric.lineIndex : null;
    const lineCount = Number.isFinite(lyric?.lineCount) ? lyric.lineCount : null;
    const nowMs = this.now();

    // Interlude / no lyric line: keep device as-is, never re-push last text.
    if (!text) {
      this.skippedCount += 1;
      this.lastHint = hint;
      this.onStatus(hint ? `等待歌词：${hint}` : '等待歌词');
      return {
        action: 'skip',
        reason: 'empty-text',
        hint,
        lineIndex,
        lineCount,
        currentDisplayedText: this.currentDisplayedText
      };
    }

    // Same line as already on Halo: never replay / never restart ticker.
    if (text === this.currentDisplayedText) {
      this.skippedCount += 1;
      this.lastHint = hint;
      if (lineIndex != null || lineCount != null) {
        this.lastLineIndex = lineIndex;
        this.lastLineCount = lineCount;
      }
      return {
        action: 'dedupe',
        reason: 'same-displayed-text',
        text,
        lineIndex,
        lineCount,
        lyricVersion: this.lyricVersion
      };
    }

    const previousDisplayed = this.currentDisplayedText;
    // Lock the lyric immediately so soda ~1s heartbeats cannot re-enter
    // sendText and cancel an in-flight cyclic ticker.
    this.currentDisplayedText = text;
    this.lastSentTime = nowMs;
    if (lineIndex != null || lineCount != null) {
      this.lastLineIndex = lineIndex;
      this.lastLineCount = lineCount;
    }

    try {
      const result = await this.sendFullDisplay(text, {
        reason: 'lyric-change'
      });
      if (result && result.cancelled) {
        // Another lyric replaced this one mid-send.
        return { action: 'cancelled', text, result, lineIndex, lineCount };
      }
      if (result && result.alreadyRunning) {
        this.skippedCount += 1;
        return {
          action: 'dedupe',
          reason: 'ticker-already-running',
          text,
          result,
          lineIndex,
          lineCount
        };
      }
      this.lyricVersion += 1;
      this.lastHint = hint;
      this.sentCount += 1;
      this.lastError = '';
      const mode = result && result.mode ? result.mode : undefined;
      const windowCount = result && Number.isInteger(result.windowCount)
        ? result.windowCount
        : 1;
      const windows = result && Array.isArray(result.windows) && result.windows.length
        ? result.windows
        : [text];
      const lineLabel =
        lineIndex != null && lineCount != null
          ? ` [${lineIndex + 1}/${lineCount}]`
          : '';
      this.onStatus(
        `已上屏：${text}${lineLabel}${windowCount > 1 ? ` (${windowCount}窗口)` : ''}`
      );
      this.onSent({
        text,
        fullText: (result && result.fullText) || text,
        result,
        mode,
        windowCount,
        windows,
        lineIndex,
        lineCount,
        trackEpoch: this.trackEpoch,
        lyricVersion: this.lyricVersion,
        reason: 'lyric-change'
      });
      this.emitEvent('lyric-updated', {
        text,
        track: this.currentTrack,
        status: 'playing',
        lineIndex,
        lineCount
      });
      return {
        action: 'sent',
        text,
        fullText: (result && result.fullText) || text,
        result,
        mode,
        windowCount,
        windows,
        lineIndex,
        lineCount,
        trackEpoch: this.trackEpoch,
        lyricVersion: this.lyricVersion,
        reason: 'lyric-change'
      };
    } catch (error) {
      this.errorCount += 1;
      this.lastError = error && error.message ? error.message : String(error);
      this.currentDisplayedText = previousDisplayed;
      this.onStatus(`Halo 发送失败：${this.lastError}`);
      return { action: 'error', text, error: this.lastError };
    }
  }

  handlePayload(payload) {
    return this.handleLyric(payload);
  }

  clear(reason = 'clear', detail = {}) {
    const previousText = this.currentDisplayedText;
    this.currentDisplayedText = '';
    this.lastSentTime = 0;
    this.lastHint = '';
    this.trackEpoch += 1;
    this.clearCount += 1;
    this.lastError = '';
    if (detail.track !== undefined) this.currentTrack = detail.track;
    // Force layout re-send on next display write (song change / reset).
    if (typeof this.haloClient.reset === 'function') {
      this.haloClient.reset(reason);
    }
    this.onStatus('管线已清空，等待新歌词');
    this.onCleared({
      reason,
      previousText,
      trackEpoch: this.trackEpoch,
      track: this.currentTrack,
      lyricVersion: this.lyricVersion
    });
    return {
      action: 'cleared',
      reason,
      previousText,
      trackEpoch: this.trackEpoch,
      track: this.currentTrack
    };
  }

  trackChanged(info = {}) {
    const reason = info.reason || 'track-changed';
    if (info.track !== undefined) this.currentTrack = info.track || null;
    const cleared = this.clear(reason, { track: info.track });
    const event = this.emitEvent('track-changed', {
      text: '',
      track: info.track || null,
      status: 'track-changed'
    });
    return {
      ...cleared,
      action: 'track-changed',
      track: info.track || null,
      previousTrack: info.previousTrack || null,
      event
    };
  }

  getStatus() {
    return {
      currentDisplayedText: this.currentDisplayedText,
      lastText: this.currentDisplayedText,
      lastSentTime: this.lastSentTime,
      lyricVersion: this.lyricVersion,
      lastLineIndex: this.lastLineIndex,
      lastLineCount: this.lastLineCount,
      dedupeWindowMs: this.dedupeWindowMs,
      lastHint: this.lastHint,
      trackEpoch: this.trackEpoch,
      sentCount: this.sentCount,
      skippedCount: this.skippedCount,
      clearCount: this.clearCount,
      errorCount: this.errorCount,
      lastError: this.lastError,
      lastEvent: this.lastEvent,
      currentTrack: this.currentTrack,
      implemented: true
    };
  }
}

module.exports = {
  LyricPipeline,
  normalizeKey,
  DEFAULT_DEDUPE_WINDOW_MS
};
