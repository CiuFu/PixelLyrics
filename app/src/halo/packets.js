// Packet builders for Halo PixelBar.
//
// Third-party notice:
// Ported/adapted from Seraph310/halo-pixelbar-mcp (halo_core.py).
// Copyright (c) 2026 Seraph310
// License: MIT
// Adapted: device constants context, HID frame builders, checksum, layout/scene packets.
// See THIRD_PARTY.md at the repository root.
// Ported from refs/halo-pixelbar-mcp-main/halo_core.py (no device I/O here).
'use strict';

const {
  PACKET_LENGTH,
  EDIFIER_DEVICE_TYPE,
  CMD_TEXT_SET,
  CMD_PIXEL_SETTING,
  LAYOUTS,
  TEXT_MAX_CHARS,
  TEXT_MAX_BYTES
} = require('./constants');

class HaloPacketError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HaloPacketError';
  }
}

function padPacket(data) {
  const packet = Buffer.from(data);
  if (packet.length > PACKET_LENGTH) {
    throw new HaloPacketError(`Packet is too large: ${packet.length} bytes`);
  }
  return Buffer.concat([packet, Buffer.alloc(PACKET_LENGTH - packet.length)]);
}

// Frame: 2E AA ED <cmd> <len_hi> <len_lo> <payload...> <checksum> <zero pad...>
// Checksum is sum of bytes from 0xAA onward, modulo 256.
function edifierPacket(command, payload) {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw new HaloPacketError(`Invalid command: ${command}`);
  }
  const body = Buffer.from(Array.from(payload, (value) => {
    const byte = Number(value);
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new HaloPacketError(`Invalid payload byte: ${value}`);
    }
    return byte;
  }));

  const header = Buffer.from([
    0x2e,
    0xaa,
    EDIFIER_DEVICE_TYPE,
    command,
    (body.length >> 8) & 0xff,
    body.length & 0xff
  ]);
  const withoutChecksum = Buffer.concat([header, body]);
  let sum = 0;
  for (let index = 1; index < withoutChecksum.length; index += 1) {
    sum = (sum + withoutChecksum[index]) & 0xff;
  }
  return padPacket(Buffer.concat([withoutChecksum, Buffer.from([sum])]));
}

function truncateUtf8(text, maxChars = TEXT_MAX_CHARS, maxBytes = TEXT_MAX_BYTES) {
  if (typeof text !== 'string') {
    throw new HaloPacketError('Text must be a string');
  }
  let working = text.trim();
  if (!working) {
    throw new HaloPacketError('Text cannot be empty');
  }
  working = Array.from(working).slice(0, maxChars).join('');
  let encoded = Buffer.from(working, 'utf8');
  while (encoded.length > maxBytes) {
    const chars = Array.from(working);
    if (chars.length <= 1) {
      throw new HaloPacketError('Text cannot fit within UTF-8 byte limit');
    }
    chars.pop();
    working = chars.join('');
    encoded = Buffer.from(working, 'utf8');
  }
  return encoded;
}

function buildTextPacket(text) {
  // Color is a separate 0xEF pixel-setting concern; 0xE8 carries UTF-8 text only.
  const textBytes = truncateUtf8(text);
  return edifierPacket(CMD_TEXT_SET, [0x00, textBytes.length, ...textBytes]);
}

function assertRgb(rgb) {
  if (!Array.isArray(rgb) || rgb.length !== 3) {
    throw new HaloPacketError('RGB must be [r, g, b]');
  }
  for (const channel of rgb) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 0xff) {
      throw new HaloPacketError(`Invalid RGB channel: ${channel}`);
    }
  }
  return rgb;
}

function buildLayoutPacket(layout = 'scroll_right_to_left', rgb = [255, 255, 255]) {
  const pair = LAYOUTS[layout];
  if (!pair) {
    throw new HaloPacketError(`Unsupported text layout: ${layout}`);
  }
  const [r, g, b] = assertRgb(rgb);
  const [scroll, mode] = pair;
  return edifierPacket(CMD_PIXEL_SETTING, [0x01, r, g, b, 0x00, 0x02, scroll, mode, 0xff]);
}

// TempoHub scene packet (halo_core.build_scene_packet) — existing protocol.
// clock scene id = 0. Used on quit to restore Halo clock display.
const SCENE_IDS = {
  clock: 0,
  game: 1,
  work: 2,
  read: 3,
  cats: 4,
  dogs: 5,
  memes: 6,
  cyber: 7,
  waves: 8
};

function buildScenePacket(scene = 'clock', rgb = [0x66, 0xaf, 0xff]) {
  const sceneId = SCENE_IDS[scene];
  if (sceneId == null) {
    throw new HaloPacketError(`Unsupported scene: ${scene}`);
  }
  const [r, g, b] = assertRgb(rgb);
  return edifierPacket(
    CMD_PIXEL_SETTING,
    [0x02, r, g, b, 0x00, 0x01, sceneId, 0xff, 0xff]
  );
}

// PROTOCOL_NOTES: pixel state query 0xEE, empty payload.
const CMD_PIXEL_STATE_QUERY = 0xee;
const CMD_TEXT_QUERY = 0xe7;

function buildPixelStateQueryPacket() {
  return edifierPacket(CMD_PIXEL_STATE_QUERY, []);
}

function buildTextQueryPacket() {
  return edifierPacket(CMD_TEXT_QUERY, [0x00]);
}

/**
 * Best-effort parse of 0xEE response (device: 2F BB EC EE ...).
 * Scene payload layout is not fully documented — try common offsets.
 */
function parsePixelStateResponse(buffer) {
  const packet = Buffer.from(buffer || []);
  if (!packet.length) {
    return { ok: false, reason: 'empty-response', raw: [] };
  }
  const raw = Array.from(packet);
  // Accept device frame 2F BB EC <cmd> or bare payload.
  let payload = raw;
  if (
    raw.length >= 4 &&
    raw[0] === 0x2f &&
    raw[1] === 0xbb &&
    raw[2] === 0xec
  ) {
    const cmd = raw[3];
    const len = raw.length > 6 ? (raw[4] << 8) | raw[5] : 0;
    payload = len > 0 ? raw.slice(6, 6 + len) : raw.slice(6);
    return {
      ok: true,
      command: cmd,
      payload,
      raw,
      sceneId: inferSceneId(payload),
      scene: sceneNameFromId(inferSceneId(payload))
    };
  }
  return {
    ok: true,
    command: null,
    payload,
    raw,
    sceneId: inferSceneId(payload),
    scene: sceneNameFromId(inferSceneId(payload))
  };
}

function inferSceneId(payload) {
  if (!payload || !payload.length) return null;
  // Scene ids observed in TempoHub: 0 clock … 8 waves.
  for (const byte of payload) {
    if (Number.isInteger(byte) && byte >= 0 && byte <= 8) {
      return byte;
    }
  }
  return null;
}

function sceneNameFromId(id) {
  if (id == null) return null;
  const entry = Object.entries(SCENE_IDS).find(([, v]) => v === id);
  return entry ? entry[0] : null;
}

function packetToHex(packet) {
  return Buffer.from(packet).toString('hex').toUpperCase();
}

module.exports = {
  HaloPacketError,
  padPacket,
  edifierPacket,
  truncateUtf8,
  buildTextPacket,
  buildLayoutPacket,
  buildScenePacket,
  buildPixelStateQueryPacket,
  buildTextQueryPacket,
  parsePixelStateResponse,
  sceneNameFromId,
  SCENE_IDS,
  CMD_PIXEL_STATE_QUERY,
  CMD_TEXT_QUERY,
  packetToHex
};
