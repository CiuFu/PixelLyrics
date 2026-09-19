// Halo ownership lifecycle (M5.3) — display release on app quit.
// Does not change lyric send path. Does NOT force clock mode on exit.
'use strict';

const DEFAULT_RESTORE_TEXT = '';

/**
 * States:
 *   idle      — PixelLyrics has not taken over Halo
 *   active    — PixelLyrics is controlling Halo lyrics display
 *   releasing — quitting; restore saved state then give up control
 */
class HaloOwnership {
  /**
   * @param {{
   *   haloClient?: { sendText?(text: string, options?: object): unknown, disconnect?: Function, stopReconnect?: Function },
   *   onStatus?: (s: string) => void,
   *   canRestoreText?: boolean
   * }} options
   */
  constructor({ haloClient = null, onStatus, canRestoreText = true } = {}) {
    this.haloClient = haloClient;
    this.onStatus = onStatus || (() => {});
    this.canRestoreText = Boolean(canRestoreText);
    this.state = 'idle';
    // Snapshot captured when PixelLyrics takes over / updates display.
    this.snapshot = null;
    // Pre-lyrics device mode (scene) captured at acquire time.
    this.preTakeoverMode = null;
    // Future: fill via protocol query (0xE7 / pixel state). Keep interface.
    this.deviceStateProbe = null;
    this.lastRelease = null;
  }

  getState() {
    return this.state;
  }

  getSnapshot() {
    return this.snapshot
      ? { ...this.snapshot }
      : null;
  }

  getPreTakeoverMode() {
    return this.preTakeoverMode ? { ...this.preTakeoverMode } : null;
  }

  /**
   * Call BEFORE first lyric display: try to read current Halo mode (scene).
   * Uses existing 0xEE query. If unreadable, preTakeoverMode.ok = false.
   */
  async captureBeforeLyrics(reason = 'before-lyrics') {
    if (typeof this.haloClient?.captureDisplayMode !== 'function') {
      this.preTakeoverMode = {
        ok: false,
        reason: 'captureDisplayMode-missing',
        scene: null,
        capturedAt: Date.now(),
        reasonTag: reason
      };
      this.onStatus(
        '[halo-ownership] capture skipped — captureDisplayMode missing'
      );
      return this.preTakeoverMode;
    }
    try {
      const captured = await this.haloClient.captureDisplayMode();
      this.preTakeoverMode = {
        ...captured,
        reasonTag: reason
      };
      if (captured && captured.ok && captured.scene) {
        this.onStatus(
          `[halo-ownership] captured pre-lyrics mode: ${captured.scene}`
        );
      } else {
        this.onStatus(
          `[halo-ownership] capture failed/unknown: ${(captured && captured.reason) || 'unknown'}`
        );
      }
      return this.preTakeoverMode;
    } catch (error) {
      this.preTakeoverMode = {
        ok: false,
        reason: error.message,
        scene: null,
        capturedAt: Date.now(),
        reasonTag: reason
      };
      this.onStatus(`[halo-ownership] capture error: ${error.message}`);
      return this.preTakeoverMode;
    }
  }

  /** Idle -> Active when PixelLyrics starts controlling Halo. */
  acquire(reason = 'acquire') {
    if (this.state === 'releasing') return this.state;
    const prev = this.state;
    this.state = 'active';
    this.onStatus(`[halo-ownership] ${prev} -> active (${reason})`);
    return this.state;
  }

  /**
   * Record what we last put on Halo (for optional restore on exit).
   * Called from Electron wiring only — does not alter lyric pipeline.
   */
  noteDisplay(text, layout = null) {
    if (this.state === 'releasing') return;
    this.acquire('display');
    this.snapshot = {
      text: String(text || ''),
      layout,
      savedAt: Date.now(),
      source: 'pixellyrics-display'
    };
  }

  /**
   * Reserved: query device for pre-takeover state.
   * Protocol may not expose this; do not assume clock.
   * @returns {Promise<{restored: false, reason: string, snapshot?: object}>}
   */
  async restoreDeviceState() {
    if (typeof this.deviceStateProbe === 'function') {
      try {
        const probed = await this.deviceStateProbe();
        return { restored: Boolean(probed?.restored), reason: probed?.reason || 'probe', snapshot: probed?.snapshot || null };
      } catch (error) {
        return { restored: false, reason: `probe-failed:${error.message}` };
      }
    }
    return {
      restored: false,
      reason: 'protocol-read-unavailable',
      snapshot: null
    };
  }

  /**
   * True quit: restore pre-lyrics Halo mode when known.
   * - Prefer scene captured before first lyric (not assumed clock).
   * - If capture failed: do NOT force clock; keep restoreDeviceState hook.
   */
  async release({ reason = 'quit', forceClockIfUnknown = false } = {}) {
    const hasSnapshot = Boolean(this.snapshot && this.snapshot.text);
    const hasPreMode = Boolean(this.preTakeoverMode);
    const active = this.state === 'active' || hasSnapshot || hasPreMode;

    if (!active) {
      const probe = await this.restoreDeviceState();
      this.onStatus(
        `[halo-ownership] idle — skip restore (${probe.reason}; no forced mode)`
      );
      return {
        state: 'idle',
        restored: false,
        reason: probe.reason || 'idle',
        probe,
        method: 'none'
      };
    }

    this.state = 'releasing';
    console.log('[halo-ownership] releasing');
    this.onStatus(`[halo-ownership] -> releasing (${reason})`);

    const result = {
      state: 'releasing',
      restored: false,
      method: 'none',
      reason: '',
      clockRestored: false,
      restoredScene: null
    };

    const probe = await this.restoreDeviceState();
    result.probe = probe;
    result.preTakeoverMode = this.preTakeoverMode
      ? { ...this.preTakeoverMode }
      : null;

    const scene =
      this.preTakeoverMode && this.preTakeoverMode.ok && this.preTakeoverMode.scene
        ? this.preTakeoverMode.scene
        : null;

    if (scene && this.haloClient && typeof this.haloClient.restoreScene === 'function') {
      try {
        console.log(`[halo] restore scene ${scene} (pre-lyrics mode)`);
        const sceneResult = await this.haloClient.restoreScene(scene);
        console.log(`[halo] scene restored: ${scene}`);
        result.restored = true;
        result.method = 'pre-takeover-scene';
        result.restoredScene = scene;
        result.reason = `restored-pre-lyrics-${scene}`;
        if (scene === 'clock') result.clockRestored = true;
        result.sceneResult = sceneResult || null;
      } catch (error) {
        console.log('[halo] scene restore failed', error.message);
        result.reason = `scene-restore-failed:${error.message}`;
      }
    } else if (
      this.haloClient &&
      typeof this.haloClient.restoreDefaultMode === 'function' &&
      (forceClockIfUnknown || !this.preTakeoverMode || !this.preTakeoverMode.ok)
    ) {
      // Capture missing/failed: restore TempoHub-like clock so device is not stuck on lyrics.
      try {
        console.log('[halo] restore clock mode (pre-lyrics scene unknown)');
        await this.haloClient.restoreDefaultMode();
        console.log('[halo] clock restored');
        result.restored = true;
        result.method = 'clock-fallback';
        result.restoredScene = 'clock';
        result.clockRestored = true;
        result.reason = this.preTakeoverMode
          ? `pre-takeover-unknown:${this.preTakeoverMode.reason || 'unknown'}; restored-clock`
          : 'pre-takeover-missing; restored-clock';
      } catch (error) {
        result.reason = `clock-fallback-failed:${error.message}`;
      }
    } else {
      result.reason = this.preTakeoverMode
        ? `no-pre-takeover-scene:${this.preTakeoverMode.reason || 'unknown'}; no forced clock`
        : 'pre-takeover-not-captured; no forced clock';
      console.log(`[halo-ownership] skip scene restore (${result.reason})`);
    }

    // Disconnect HID after release (true quit only).
    try {
      if (this.haloClient && typeof this.haloClient.stopReconnect === 'function') {
        this.haloClient.stopReconnect();
      }
      if (this.haloClient && typeof this.haloClient.disconnect === 'function') {
        this.haloClient.disconnect();
      }
    } catch (error) {
      this.onStatus(`[halo-ownership] disconnect error: ${error.message}`);
    }

    this.state = 'idle';
    this.lastRelease = { ...result, at: Date.now() };
    this.onStatus('[halo-ownership] released -> idle');
    return { ...result, state: 'idle' };
  }
}

module.exports = {
  HaloOwnership,
  DEFAULT_RESTORE_TEXT
};
