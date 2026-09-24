// Song state manager (M4.2/M4.4): media track identity + lyric pipeline coordination.
'use strict';

const DEFAULT_PLACEHOLDER = '♪';

function formatTrackDisplay(track, fallback = DEFAULT_PLACEHOLDER) {
  const title = String(track?.title || '').trim();
  const artist = String(track?.artist || '').trim();
  if (title && artist) return `${title} - ${artist}`;
  return title || artist || fallback;
}

class SongStateManager {
  /**
   * @param {{
   *   pipeline: { handleLyric(lyric: object): object, trackChanged(info?: object): object, clear(reason?: string): object, getStatus(): object },
   *   haloClient?: { sendText(text: string, options?: object): unknown },
   *   onStatus?: (status: string) => void,
   *   onTrackChanged?: (info: object) => void,
   *   placeholder?: string,
   *   requireTrackForLyrics?: boolean
   * }} options
   */
  constructor({
    pipeline,
    haloClient,
    onStatus,
    onTrackChanged,
    placeholder = DEFAULT_PLACEHOLDER,
    requireTrackForLyrics = false
  } = {}) {
    if (!pipeline || typeof pipeline.handleLyric !== 'function') {
      throw new Error('SongStateManager requires pipeline.handleLyric');
    }
    this.pipeline = pipeline;
    this.haloClient = haloClient || pipeline.haloClient || null;
    this.onStatus = onStatus || (() => {});
    this.onTrackChanged = onTrackChanged || (() => {});
    this.placeholder = placeholder;
    this.requireTrackForLyrics = Boolean(requireTrackForLyrics);

    this.currentTrack = null;
    this.currentTrackKey = '';
    this.trackChangeCount = 0;
    this.lyricPassCount = 0;
    this.lyricBlockedCount = 0;
  }

  getTrackInfo() {
    if (!this.currentTrack) return null;
    return {
      trackKey: this.currentTrack.trackKey,
      title: this.currentTrack.title,
      artist: this.currentTrack.artist,
      album: this.currentTrack.album,
      playbackStatus: this.currentTrack.playbackStatus
    };
  }

  // Short track labels center; long title/artist pairs use DisplayStrategy's ticker.
  async showPlaceholder(reason = 'track-changed') {
    const displayText = formatTrackDisplay(this.currentTrack, '');
    const trackInfo = this.getTrackInfo();

    if (typeof this.pipeline.publishTrackInfo === 'function') {
      this.pipeline.publishTrackInfo(displayText || trackInfo?.title || '', trackInfo);
    } else if (typeof this.pipeline.publishPlaceholder === 'function') {
      this.pipeline.publishPlaceholder(displayText || '', trackInfo);
    }

    if (!displayText) {
      this.onStatus(
        reason === 'track-cleared'
          ? '媒体会话结束，等待下一句歌词'
          : '切歌：无歌名，等待下一句歌词'
      );
      return {
        action: 'track-info-only',
        reason,
        text: '',
        skippedDevice: true,
        layout: null
      };
    }

    if (!this.haloClient || typeof this.haloClient.sendText !== 'function') {
      this.onStatus(`切歌：${displayText}（无设备，仅 UI）`);
      return {
        action: 'track-info-only',
        reason,
        text: displayText,
        skippedDevice: true,
        layout: null
      };
    }

    try {
      // Let DisplayStrategy choose center or scrolling based on the full label.
      const result = await this.haloClient.sendText(displayText);
      this.onStatus(`切歌：花在显示「${displayText}」`);
      return {
        action: 'track-info',
        reason,
        text: displayText,
        result,
        skippedDevice: false,
        layout: result?.mode || 'center'
      };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.onStatus(`切歌显示失败：${message}`);
      return {
        action: 'track-info-error',
        reason,
        text: displayText,
        error: message,
        skippedDevice: true
      };
    }
  }

  // Accepts MediaSessionMonitor payload { track, changed } or raw track/null.
  async handleMediaUpdate(update) {
    const track =
      update && typeof update === 'object' && 'track' in update
        ? update.track
        : update;
    const nextKey = track?.trackKey || '';
    const changed = nextKey !== this.currentTrackKey;

    if (!changed) {
      if (track) this.currentTrack = track;
      return { action: 'same-track', trackKey: nextKey || null };
    }

    const previous = this.getTrackInfo();
    this.currentTrack = track || null;
    this.currentTrackKey = nextKey;
    this.trackChangeCount += 1;

    // Reset lyric dedupe so the new song's first line can be sent.
    if (typeof this.pipeline.trackChanged === 'function') {
      this.pipeline.trackChanged({
        reason: nextKey ? 'track-changed' : 'track-cleared',
        track: this.getTrackInfo(),
        previousTrack: previous
      });
    } else {
      this.pipeline.clear('track-changed');
    }

    let placeholderResult;
    if (nextKey) {
      placeholderResult = await this.showPlaceholder('track-changed');
      this.onStatus(
        '切歌：' + (previous?.title || '(无)') + ' → ' + (track.title || '(未知)')
      );
    } else {
      placeholderResult = await this.showPlaceholder('track-cleared');
      this.onStatus('媒体会话结束，已清理歌词状态');
    }

    const payload = {
      action: 'track-changed',
      previous,
      current: this.getTrackInfo(),
      placeholderResult
    };
    this.onTrackChanged(payload);
    return payload;
  }

  async handleLyric(lyric) {
    if (this.requireTrackForLyrics && !this.currentTrackKey) {
      this.lyricBlockedCount += 1;
      this.onStatus('忽略歌词：尚未识别当前歌曲');
      return { action: 'blocked', reason: 'no-track' };
    }
    this.lyricPassCount += 1;
    return this.pipeline.handleLyric(lyric);
  }

  getStatus() {
    return {
      track: this.getTrackInfo(),
      trackKey: this.currentTrackKey || null,
      trackChangeCount: this.trackChangeCount,
      lyricPassCount: this.lyricPassCount,
      lyricBlockedCount: this.lyricBlockedCount,
      placeholder: this.placeholder,
      lastTrackDisplay: formatTrackDisplay(this.currentTrack, this.placeholder),
      pipeline: this.pipeline.getStatus ? this.pipeline.getStatus() : null
    };
  }
}

module.exports = {
  SongStateManager,
  DEFAULT_PLACEHOLDER,
  formatTrackDisplay
};
