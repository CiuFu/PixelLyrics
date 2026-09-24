'use strict';

const { buildLayoutPacket, buildTextPacket } = require('./packets');
const {
  DISPLAY_WIDTH_UNITS,
  buildScrollWindows
} = require('./lyrics-layout');

const DEFAULT_WINDOW_HOLD_MS = 300;
const DEFAULT_MAX_WINDOWS = 200;
const DEFAULT_RESET_DELAY_MS = 300;
const DEFAULT_CENTER_LAYOUT_DELAY_MS = 80;
const DEFAULT_PLACEHOLDER = '♪';
const DEFAULT_RGB = [0x66, 0xaf, 0xff];

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DisplayStrategy {
  constructor({
    haloClient,
    windowHoldMs = DEFAULT_WINDOW_HOLD_MS,
    maxWindows = DEFAULT_MAX_WINDOWS,
    resetDelayMs = DEFAULT_RESET_DELAY_MS,
    centerLayoutDelayMs = DEFAULT_CENTER_LAYOUT_DELAY_MS,
    placeholder = DEFAULT_PLACEHOLDER,
    rgb = DEFAULT_RGB,
    sleep,
    onStatus,
    onTicker,
    displayWidthUnits = DISPLAY_WIDTH_UNITS,
    utf8ByteBudget
  } = {}) {
    if (!haloClient || typeof haloClient.sendPacket !== 'function') {
      throw new Error('DisplayStrategy requires haloClient.sendPacket');
    }
    this.haloClient = haloClient;
    this.windowHoldMs = Number.isFinite(windowHoldMs)
      ? windowHoldMs
      : DEFAULT_WINDOW_HOLD_MS;
    this.maxWindows = Number.isFinite(maxWindows) ? maxWindows : DEFAULT_MAX_WINDOWS;
    this.resetDelayMs = resetDelayMs;
    this.centerLayoutDelayMs = centerLayoutDelayMs;
    this.placeholder = placeholder;
    this.rgb = rgb;
    this.sleep = typeof sleep === 'function' ? sleep : defaultSleep;
    this.onStatus = onStatus || (() => {});
    this.onTicker = onTicker || ((payload) => {
      console.log('[ticker]', JSON.stringify(payload));
    });
    this.displayWidthUnits = displayWidthUnits;
    this.utf8ByteBudget = utf8ByteBudget;

    this.currentMode = null;
    this.currentFullText = '';
    this.currentWindows = [];
    this.currentWindowIndex = 0;
    this.tickerRunning = false;
    this.sequenceId = 0;
  }

  layoutText(text) {
    return buildScrollWindows(text, {
      displayWidthUnits: this.displayWidthUnits,
      utf8ByteBudget: this.utf8ByteBudget
    });
  }

  pickMode(text) {
    return this.layoutText(text).windowCount > 1 ? 'cyclic' : 'center';
  }

  reset(reason = 'reset') {
    this.sequenceId += 1;
    this.currentMode = null;
    this.currentFullText = '';
    this.currentWindows = [];
    this.currentWindowIndex = 0;
    this.tickerRunning = false;
    this.onStatus(`显示已重置（${reason}）`);
  }

  getMode() {
    return this.currentMode;
  }

  _writeCenterLayout() {
    return this.haloClient.sendPacket(buildLayoutPacket('center', this.rgb));
  }

  _writeText(text) {
    return this.haloClient.sendPacket(buildTextPacket(text));
  }

  async _ensureCenterLayout() {
    this._writeCenterLayout();
    if (this.centerLayoutDelayMs > 0) await this.sleep(this.centerLayoutDelayMs);
  }

  async _resetToPlaceholder() {
    this._writeCenterLayout();
    this.currentMode = 'center';
    if (this.centerLayoutDelayMs > 0) await this.sleep(this.centerLayoutDelayMs);
    this._writeText(this.placeholder);
    this.onStatus(`切换复位：center + ${JSON.stringify(this.placeholder)}`);
    if (this.resetDelayMs > 0) await this.sleep(this.resetDelayMs);
  }

  async sendText(text, options = {}) {
    const layout = this.layoutText(text);
    const fullText = layout.normalizedText;
    if (!fullText || layout.windowCount === 0) {
      return { success: false, reason: 'empty', fullText: '' };
    }

    const forceCenter = options.layout === 'center' || options.layout === 'left';
    const mode = !forceCenter && layout.windowCount > 1 ? 'cyclic' : 'center';
    const windows = mode === 'center' ? layout.windows.slice(0, 1) : layout.windows;

    if (
      this.currentFullText === fullText &&
      (mode === 'cyclic' ? this.tickerRunning : this.currentMode === 'center')
    ) {
      this.onStatus('[ticker] same lyric in progress — skip restart');
      return {
        success: true,
        alreadyRunning: true,
        mode,
        fullText,
        windows: this.currentWindows.map((window) => window.text),
        windowCount: this.currentWindows.length,
        windowIndex: this.currentWindowIndex
      };
    }

    this.sequenceId += 1;
    const activeSeq = this.sequenceId;
    const previousText = this.currentFullText;
    this.currentFullText = fullText;
    this.currentWindows = windows;
    this.currentWindowIndex = 0;
    this.tickerRunning = mode === 'cyclic';
    this.currentMode = mode;

    await this._ensureCenterLayout();
    if (previousText && previousText !== fullText) {
      this.onStatus('[display] 切换直接进入新句（无 ♪）');
    }

    if (mode === 'center') {
      const window = windows[0];
      if (activeSeq !== this.sequenceId) {
        return { success: false, cancelled: true, mode, fullText, windows: [], windowCount: 0 };
      }
      this._writeText(window.text);
      this.onTicker({
        windowIndex: 0,
        windowCount: 1,
        text: window.text,
        fullText,
        mode,
        visualWidth: window.width,
        utf8Bytes: window.utf8Bytes
      });
      return {
        success: true,
        cancelled: false,
        mode,
        fullText,
        windows: [window.text],
        windowCount: 1,
        windowIndex: 0,
        text: window.text,
        windowHoldMs: this.windowHoldMs
      };
    }

    for (let iteration = 0; iteration < this.maxWindows; iteration += 1) {
      if (activeSeq !== this.sequenceId) {
        this.tickerRunning = false;
        this.onStatus(
          `[ticker] cancelled window=${iteration} seq=${activeSeq}!=${this.sequenceId}`
        );
        return {
          success: false,
          cancelled: true,
          mode,
          fullText,
          windows: windows.map((window) => window.text),
          windowCount: windows.length,
          windowIndex: this.currentWindowIndex
        };
      }

      const windowIndex = iteration % windows.length;
      const window = windows[windowIndex];
      this.currentWindowIndex = windowIndex;
      this._writeText(window.text);
      this.onTicker({
        windowIndex,
        windowCount: windows.length,
        text: window.text,
        fullText,
        mode,
        visualWidth: window.width,
        utf8Bytes: window.utf8Bytes
      });
      this.onStatus(
        `[ticker] ${windowIndex + 1}/${windows.length} text=${window.text}`
      );

      if (this.windowHoldMs > 0) await this.sleep(this.windowHoldMs);
    }

    this.tickerRunning = false;
    return {
      success: true,
      cancelled: false,
      mode,
      fullText,
      windows: windows.map((window) => window.text),
      windowCount: windows.length,
      windowIndex: this.currentWindowIndex,
      text: windows[0].text,
      windowHoldMs: this.windowHoldMs
    };
  }

  async sendTrackInfo(text) {
    return this.sendText(text, { layout: 'center' });
  }

  async restoreDefaultMode(options = {}) {
    if (this.haloClient && typeof this.haloClient.restoreDefaultMode === 'function') {
      return this.haloClient.restoreDefaultMode(options);
    }
    throw new Error('DisplayStrategy.haloClient.restoreDefaultMode not available');
  }

  async restoreScene(scene, options = {}) {
    if (this.haloClient && typeof this.haloClient.restoreScene === 'function') {
      return this.haloClient.restoreScene(scene, options);
    }
    throw new Error('DisplayStrategy.haloClient.restoreScene not available');
  }

  captureDisplayMode(options = {}) {
    if (this.haloClient && typeof this.haloClient.captureDisplayMode === 'function') {
      return this.haloClient.captureDisplayMode(options);
    }
    return { ok: false, reason: 'captureDisplayMode-missing', scene: null, raw: [] };
  }

  getStatus() {
    return {
      mode: this.currentMode,
      currentFullText: this.currentFullText,
      tickerRunning: this.tickerRunning,
      currentWindowIndex: this.currentWindowIndex,
      windowCount: this.currentWindows.length,
      windowHoldMs: this.windowHoldMs,
      displayWidthUnits: this.displayWidthUnits,
      sequenceId: this.sequenceId
    };
  }
}

module.exports = {
  DisplayStrategy,
  DEFAULT_WINDOW_HOLD_MS,
  DEFAULT_MAX_WINDOWS,
  DISPLAY_WIDTH_UNITS
};
