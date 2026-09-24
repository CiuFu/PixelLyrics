// Halo PixelBar HID discovery, write path, and auto-reconnect (M5.2).
// HID connection lifecycle, packet sending, and auto-reconnect.
'use strict';

const nodeHid = require('node-hid');
const {
  VENDOR_ID,
  PRODUCT_ID,
  INTERFACE_NUMBER,
  CONTROL_USAGE_PAGE,
  CONTROL_USAGE,
  PACKET_LENGTH,
  EDIFIER_DEVICE_TYPE,
  LAYOUTS
} = require('./constants');
const {
  buildLayoutPacket,
  buildTextPacket,
  buildScenePacket,
  buildPixelStateQueryPacket,
  parsePixelStateResponse
} = require('./packets');
const {
  buildLyricAnimationPresetPacket,
  buildLyricAnimationSwitchPacket
} = require('./ec-packets');

const DEFAULT_RECONNECT_INTERVAL_MS = 2000;

class HaloDeviceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HaloDeviceError';
  }
}

function hex4(value) {
  return `0x${Number(value || 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

function readInterfaceNumber(item) {
  if (item.interface_number != null) return Number(item.interface_number);
  if (item.interface != null) return Number(item.interface);
  return -1;
}

function readUsagePage(item) {
  if (item.usage_page != null) return Number(item.usage_page);
  if (item.usagePage != null) return Number(item.usagePage);
  return 0;
}

function readProduct(item) {
  return String(item.product_string || item.product || '');
}

function readManufacturer(item) {
  return String(item.manufacturer_string || item.manufacturer || '');
}

function publicDeviceInfo(device) {
  return {
    product: device.product,
    manufacturer: device.manufacturer,
    vendorId: hex4(device.vendorId),
    productId: hex4(device.productId),
    interfaceNumber: device.interfaceNumber,
    usagePage: hex4(device.usagePage),
    usage: device.usage,
    path: device.path
  };
}

function listAllHidDevices(hid = nodeHid) {
  try {
    return (hid.devices() || []).map((item) => ({
      path: item.path,
      vendorId: item.vendorId,
      productId: item.productId,
      product: readProduct(item),
      manufacturer: readManufacturer(item),
      serialNumber: item.serialNumber || '',
      interfaceNumber: readInterfaceNumber(item),
      usagePage: readUsagePage(item),
      usage: Number(item.usage || 0)
    }));
  } catch (error) {
    throw new HaloDeviceError(`HID device listing failed: ${error.message}`);
  }
}

function enumerateHaloDevices(hid = nodeHid) {
  let items = [];
  try {
    items = hid.devices(VENDOR_ID, PRODUCT_ID) || [];
  } catch (error) {
    throw new HaloDeviceError(`Halo HID enumerate failed: ${error.message}`);
  }

  const devices = [];
  for (const item of items) {
    const interfaceNumber = readInterfaceNumber(item);
    const product = readProduct(item);
    const usagePage = readUsagePage(item);
    const usage = Number(item.usage || 0);
    if (interfaceNumber !== INTERFACE_NUMBER) continue;
    if (usagePage !== CONTROL_USAGE_PAGE) continue;
    if (usage !== CONTROL_USAGE) continue;
    const productFold = product.casefold ? product.casefold() : product.toLowerCase();
    if (!productFold.includes('halo') && !productFold.includes('pixelbar')) {
      continue;
    }
    devices.push({
      path: item.path,
      product,
      manufacturer: readManufacturer(item),
      serialNumber: item.serialNumber || '',
      vendorId: Number(item.vendorId || VENDOR_ID),
      productId: Number(item.productId || PRODUCT_ID),
      usagePage,
      usage,
      interfaceNumber
    });
  }

  return devices.sort((a, b) => a.usagePage - b.usagePage);
}

function assertPacket(packet) {
  const buffer = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
  if (buffer.length !== PACKET_LENGTH) {
    throw new HaloDeviceError(
      `Packet must be ${PACKET_LENGTH} bytes, got ${buffer.length}`
    );
  }
  return buffer;
}

class HaloClient {
  /**
   * @param {{
   *   hid?: object,
   *   defaultLayout?: string,
   *   defaultRgb?: [number,number,number],
   *   reconnectIntervalMs?: number,
   *   onStatus?: (evt: { state: string, message: string, device?: object|null }) => void,
   *   onReconnect?: (device: object|null) => void,
   *   autoReconnect?: boolean
   * }} options
   */
  constructor(options = {}) {
    this.hid = options.hid || nodeHid;
    this.defaultLayout = options.defaultLayout || 'scroll_right_to_left';
    this.defaultRgb = options.defaultRgb || [0x66, 0xaf, 0xff];
    this.reconnectIntervalMs =
      options.reconnectIntervalMs || DEFAULT_RECONNECT_INTERVAL_MS;
    this.onStatus = options.onStatus || null;
    this.onReconnect = options.onReconnect || null;
    this.autoReconnect = options.autoReconnect !== false;

    this.device = null;
    this.info = null;
    // disconnected | connected | reconnecting | waiting
    this.state = 'disconnected';
    this.lastError = null;
    this.reconnectTimer = null;
  }

  isConnected() {
    return Boolean(this.device) && this.state === 'connected';
  }

  getDeviceInfo() {
    return this.info ? publicDeviceInfo(this.info) : null;
  }

  getStatus() {
    return {
      connected: this.isConnected(),
      state: this.state,
      device: this.getDeviceInfo(),
      lastError: this.lastError,
      reconnectIntervalMs: this.reconnectIntervalMs,
      autoReconnect: this.autoReconnect
    };
  }

  _emit(message) {
    const line = typeof message === 'string' ? message : String(message);
    console.log(line);
    if (typeof this.onStatus === 'function') {
      this.onStatus({
        state: this.state,
        message: line,
        device: this.getDeviceInfo()
      });
    }
  }

  connect() {
    if (this.device && this.state === 'connected') return this.getDeviceInfo();

    const candidates = enumerateHaloDevices(this.hid);
    if (!candidates.length) {
      this.lastError = 'Halo PixelBar HID control interface was not found';
      throw new HaloDeviceError(
        'Halo PixelBar HID control interface was not found ' +
          `(need VID ${hex4(VENDOR_ID)} PID ${hex4(PRODUCT_ID)} ` +
          `interface ${INTERFACE_NUMBER} usage ${hex4(CONTROL_USAGE_PAGE)}/${CONTROL_USAGE}, ` +
          'product name containing halo/pixelbar)'
      );
    }

    const errors = [];
    const HIDCtor = this.hid.HID || this.hid;
    for (const candidate of candidates) {
      try {
        const handle = new HIDCtor(candidate.path);
        this.device = handle;
        this.info = candidate;
        this.state = 'connected';
        this.lastError = null;
        this._emit('[halo] connected');
        return this.getDeviceInfo();
      } catch (error) {
        errors.push(`usagePage=${hex4(candidate.usagePage)}: ${error.message}`);
      }
    }
    this.device = null;
    this.info = null;
    this.state = 'waiting';
    this.lastError = errors.join('; ');
    throw new HaloDeviceError(
      `No openable Halo PixelBar HID channel: ${errors.join('; ')}`
    );
  }

  disconnect() {
    this.stopReconnect();
    if (this.device) {
      try {
        this.device.close();
      } catch {
        // ignore
      }
    }
    this.device = null;
    this.info = null;
    if (this.state === 'connected') {
      this._emit('[halo] disconnected');
    }
    this.state = 'disconnected';
  }

  _markDisconnected(error) {
    this.lastError = error && error.message ? error.message : String(error || '');
    if (this.device) {
      try {
        this.device.close();
      } catch {
        // ignore
      }
    }
    this.device = null;
    this.info = null;
    if (this.state !== 'disconnected') {
      this._emit('[halo] disconnected');
    }
    this.state = 'waiting';
    if (this.autoReconnect) {
      this.startReconnect();
    }
  }

  startReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    this.state = 'reconnecting';
    this._emit('[halo] reconnect attempt');
    this.reconnectTimer = setInterval(() => {
      this._tryReconnectOnce();
    }, this.reconnectIntervalMs);
  }

  _tryReconnectOnce() {
    if (this.state === 'connected' && this.device) {
      this.stopReconnectTimerOnly();
      return;
    }
    this.state = 'reconnecting';
    this._emit('[halo] reconnect attempt');
    try {
      if (this.device) {
        try {
          this.device.close();
        } catch {
          // ignore
        }
        this.device = null;
        this.info = null;
      }
      const device = this.connect();
      this.stopReconnectTimerOnly();
      this.state = 'connected';
      this._emit('[halo] reconnect success');
      if (typeof this.onReconnect === 'function') {
        try {
          this.onReconnect(device);
        } catch (error) {
          this._emit(`[halo] reconnect callback error: ${error.message}`);
        }
      }
    } catch (error) {
      this.state = 'waiting';
      this.lastError = error.message;
      this._emit(`[halo] reconnect failed: ${error.message}`);
    }
  }

  stopReconnectTimerOnly() {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  stopReconnect() {
    this.stopReconnectTimerOnly();
  }

  sendPacket(packet) {
    const buffer = assertPacket(packet);

    if (this.state === 'reconnecting') {
      throw new HaloDeviceError('Halo device reconnecting');
    }

    if (!this.device || this.state !== 'connected') {
      try {
        this.connect();
      } catch (error) {
        this._markDisconnected(error);
        throw new HaloDeviceError(`Halo device not connected: ${error.message}`);
      }
    }

    try {
      const written = this.device.write([...buffer]);
      const count = Number(written);
      if (!Number.isFinite(count) || count < 0) {
        throw new HaloDeviceError(`HID write returned an error (${written})`);
      }
      return { success: true, written: count, device: this.getDeviceInfo() };
    } catch (error) {
      const deviceError =
        error instanceof HaloDeviceError
          ? error
          : new HaloDeviceError(`HID write failed: ${error.message}`);
      this._markDisconnected(deviceError);
      throw deviceError;
    }
  }

  sendPackets(packets) {
    const list = Array.from(packets);
    const written = [];
    for (const packet of list) {
      const result = this.sendPacket(packet);
      written.push(result.written);
    }
    return {
      success: true,
      device: this.getDeviceInfo(),
      written
    };
  }

  sendText(text, options = {}) {
    const layout = options.layout || this.defaultLayout;
    const rgb = options.rgb || this.defaultRgb;
    if (!LAYOUTS[layout]) {
      throw new HaloDeviceError(`Unsupported text layout: ${layout}`);
    }
    const layoutPacket = buildLayoutPacket(layout, rgb);
    const textPacket = buildTextPacket(text);
    const result = this.sendPackets([layoutPacket, textPacket]);
    return {
      ...result,
      layout,
      rgb,
      text
    };
  }

  setLyricAnimationPreset(preset, options = {}) {
    const rgb = options.rgb || this.defaultRgb;
    const packet = buildLyricAnimationPresetPacket(preset, rgb);
    const result = this.sendPacket(packet);
    return { ...result, preset, rgb, packet };
  }

  setLyricAnimationEnabled(enabled, options = {}) {
    const rgb = options.rgb || this.defaultRgb;
    const packet = buildLyricAnimationSwitchPacket(enabled, rgb);
    const result = this.sendPacket(packet);
    return { ...result, enabled, rgb, packet };
  }

  /**
   * Restore Halo built-in scene (clock/game/...). Uses TempoHub 0xEF scene packet.
   */
  restoreScene(scene = 'clock', options = {}) {
    const rgb = options.rgb || this.defaultRgb;
    console.log(`[halo] restore scene ${scene}`);
    if (!this.device || this.state !== 'connected') {
      try {
        this.connect();
      } catch (error) {
        this._markDisconnected(error);
        throw new HaloDeviceError(
          `Cannot restore scene — device not connected: ${error.message}`
        );
      }
    }
    const packet = buildScenePacket(scene, rgb);
    const result = this.sendPacket(packet);
    console.log(`[halo] scene restored: ${scene}`);
    return { ...result, scene, packet: `0xEF-scene-${scene}` };
  }

  /** TempoHub-compatible clock restore (alias). */
  restoreDefaultMode(options = {}) {
    console.log('[halo] restore clock mode');
    const result = this.restoreScene('clock', options);
    console.log('[halo] clock restored');
    return { ...result, mode: 'clock' };
  }

  /**
   * Query current pixel-screen state (0xEE) before taking over lyrics.
   * Returns best-effort mode info; never throws for missing protocol data.
   */
  captureDisplayMode(options = {}) {
    const timeoutMs = options.timeoutMs || 500;
    const capturedAt = Date.now();
    if (!this.device || this.state !== 'connected') {
      try {
        this.connect();
      } catch (error) {
        this._markDisconnected(error);
        return {
          ok: false,
          reason: `not-connected:${error.message}`,
          capturedAt,
          scene: null,
          raw: []
        };
      }
    }

    try {
      const query = buildPixelStateQueryPacket();
      const writeResult = this.sendPacket(query);
      let response = [];
      try {
        if (typeof this.device.read === 'function') {
          response = this.device.read(64, timeoutMs) || [];
        }
      } catch (readError) {
        return {
          ok: false,
          reason: `read-failed:${readError.message}`,
          capturedAt,
          scene: null,
          raw: [],
          write: writeResult
        };
      }

      const parsed = parsePixelStateResponse(response);
      const scene = parsed.scene || null;
      console.log(
        `[halo] captured mode before lyrics: scene=${scene || '(unknown)'} ` +
          `raw=${(parsed.raw || []).map((b) => `0x${b.toString(16)}`).join(' ')}`
      );
      return {
        ok: Boolean(parsed.ok && scene),
        reason: scene ? 'captured' : 'response-unparsed-or-no-scene',
        capturedAt,
        scene,
        sceneId: parsed.sceneId == null ? null : parsed.sceneId,
        pixel: parsed,
        raw: parsed.raw || []
      };
    } catch (error) {
      console.log('[halo] captureDisplayMode failed', error.message);
      return {
        ok: false,
        reason: error.message,
        capturedAt,
        scene: null,
        raw: []
      };
    }
  }
}

function sendPackets(packets, options = {}) {
  const client = new HaloClient(options);
  try {
    return client.sendPackets(packets);
  } finally {
    client.stopReconnect();
    client.disconnect();
  }
}

function sendText(text, options = {}) {
  const client = new HaloClient(options);
  try {
    return client.sendText(text, options);
  } finally {
    client.stopReconnect();
    client.disconnect();
  }
}

function setLyricAnimationPreset(preset, options = {}) {
  const client = new HaloClient(options);
  try {
    return client.setLyricAnimationPreset(preset, options);
  } finally {
    client.stopReconnect();
    client.disconnect();
  }
}

function setLyricAnimationEnabled(enabled, options = {}) {
  const client = new HaloClient(options);
  try {
    return client.setLyricAnimationEnabled(enabled, options);
  } finally {
    client.stopReconnect();
    client.disconnect();
  }
}

module.exports = {
  HaloDeviceError,
  enumerateHaloDevices,
  listAllHidDevices,
  publicDeviceInfo,
  HaloClient,
  sendPackets,
  sendText,
  setLyricAnimationPreset,
  setLyricAnimationEnabled,
  EDIFIER_DEVICE_TYPE,
  DEFAULT_RECONNECT_INTERVAL_MS
};
