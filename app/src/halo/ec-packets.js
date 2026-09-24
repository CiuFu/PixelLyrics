// Experimental EC (HaloPixelToolBox / HaloLyricSync) packet builders.
//
// Third-party notice:
// Adapted from nxz1026/HaloLyricSync (src/hid_packet_builder.py).
// Upstream license: MIT (declared in upstream README badge/docs; no LICENSE
// file found in the reviewed source snapshot).
// Adapted: EC frame layout, text colors, layout bytes, text checksum.
// HaloLyricSync itself references XFEstudio/HaloPixelToolBox for this protocol.
// See THIRD_PARTY.md at the repository root.
//
// Does NOT replace ED TempoHub packets in packets.js. EC packet builders are
// shared by the production client and the independent real-device diagnostic.
// Reference: nxz1026/HaloLyricSync src/hid_packet_builder.py
'use strict';

const PACKET_LENGTH = 64;
const EC_DEVICE_TYPE = 0xec;
const CMD_EC_PIXEL_SETTING = 0xef;
const LYRIC_ANIMATION_PRESET_MIN = 0x00;
const LYRIC_ANIMATION_PRESET_MAX = 0x04;

const TEXT_COLORS = {
  white: 0,
  red: 1,
  green: 2,
  blue: 3,
  yellow: 4,
  cyan: 5,
  magenta: 6
};

const EC_LAYOUT_HEADER = [
  0x2e, 0xaa, 0xec, 0xef, 0x00, 0x09, 0x01,
  0xf0, 0xb4, 0xc8, 0x00, 0x02, 0x00
];

const EC_LAYOUT_BYTES = {
  left: [0x00, 0xff, 0xfc, 0x00],
  center: [0x01, 0xff, 0xfd, 0x00],
  right: [0x02, 0xff, 0xfe, 0x00],
  stretch: [0x03, 0xff, 0xff, 0x00],
  scroll_left_to_right: [0x00, 0xff, 0xfd, 0x00],
  scroll_right_to_left: [0x01, 0xff, 0xfe, 0x00]
};

class EcPacketError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EcPacketError';
  }
}

function assertRgb(rgb) {
  if (!Array.isArray(rgb) || rgb.length !== 3) {
    throw new EcPacketError('RGB must be [r, g, b]');
  }
  for (const channel of rgb) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 0xff) {
      throw new EcPacketError(`Invalid RGB channel: ${channel}`);
    }
  }
  return rgb;
}

function pad64(data) {
  const buf = Buffer.from(data);
  if (buf.length > PACKET_LENGTH) {
    throw new EcPacketError(`EC packet too large: ${buf.length}`);
  }
  return Buffer.concat([buf, Buffer.alloc(PACKET_LENGTH - buf.length)]);
}

function frameChecksum(frame) {
  let sum = 0;
  for (let index = 1; index < frame.length; index += 1) {
    sum = (sum + frame[index]) & 0xff;
  }
  return sum;
}

function buildEcEfPacket(payload) {
  const values = Array.from(payload || []);
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new EcPacketError(`Invalid EC EF payload byte: ${value}`);
    }
  }
  const body = Buffer.from(values);
  if (body.length !== 9) {
    throw new EcPacketError(`EC EF payload must be 9 bytes, got ${body.length}`);
  }
  const frame = Buffer.from([
    0x2e,
    0xaa,
    EC_DEVICE_TYPE,
    CMD_EC_PIXEL_SETTING,
    0x00,
    0x09,
    ...body
  ]);
  return pad64(Buffer.concat([frame, Buffer.from([frameChecksum(frame)])]));
}

function assertLyricAnimationPreset(preset) {
  if (
    !Number.isInteger(preset) ||
    preset < LYRIC_ANIMATION_PRESET_MIN ||
    preset > LYRIC_ANIMATION_PRESET_MAX
  ) {
    throw new EcPacketError(`Invalid lyric animation preset: ${preset}`);
  }
  return preset;
}

function buildLyricAnimationPresetPacket(preset, rgb) {
  const selectedPreset = assertLyricAnimationPreset(preset);
  const [r, g, b] = assertRgb(rgb);
  return buildEcEfPacket([
    0x01,
    r,
    g,
    b,
    0x00,
    0x00,
    0x01,
    0x00,
    selectedPreset
  ]);
}

function buildLyricAnimationSwitchPacket(enabled, rgb) {
  if (typeof enabled !== 'boolean') {
    throw new EcPacketError(`Enabled must be boolean, got ${enabled}`);
  }
  const [r, g, b] = assertRgb(rgb);
  return buildEcEfPacket([
    0x02,
    r,
    g,
    b,
    0x00,
    0x00,
    enabled ? 0x01 : 0x00,
    0xff,
    0xff
  ]);
}

function parseLyricAnimationAck(buffer) {
  const raw = Buffer.from(buffer || []);
  const fail = (reason) => ({ ok: false, reason, raw: [...raw] });
  if (raw.length < 16) return fail(`ACK too short: ${raw.length}`);
  if (raw[0] !== 0x2f || raw[1] !== 0xbb) return fail('invalid ACK prefix');
  if (raw[2] !== EC_DEVICE_TYPE || raw[3] !== CMD_EC_PIXEL_SETTING) {
    return fail('ACK is not EC EF');
  }
  const payloadLength = (raw[4] << 8) | raw[5];
  if (payloadLength !== 9) return fail(`invalid ACK payload length: ${payloadLength}`);
  if (raw[15] !== frameChecksum(raw.subarray(0, 15))) {
    return fail('invalid ACK checksum');
  }
  const payload = raw.subarray(6, 15);
  return {
    ok: true,
    raw: [...raw],
    payload: [...payload],
    actionIndex: payload[0],
    rgb: [...payload.subarray(1, 4)],
    modeGroupIndex: payload[4],
    modeIndex: payload[5],
    option0Index: payload[6],
    option1Index: payload[7],
    option2Index: payload[8],
    enabled: payload[6] === 0x01,
    currentPreset: payload[8] <= LYRIC_ANIMATION_PRESET_MAX ? payload[8] : null
  };
}

function validateLyricAnimationAck(ack, request) {
  const parsed = ack && ack.ok != null ? ack : parseLyricAnimationAck(ack);
  if (!parsed.ok) return parsed;
  if (request?.operation === 'preset') {
    const preset = assertLyricAnimationPreset(request.preset);
    if (parsed.actionIndex !== 0x01 || parsed.option2Index !== preset) {
      return { ...parsed, ok: false, reason: 'preset ACK does not match request' };
    }
  } else if (request?.operation === 'switch') {
    if (
      parsed.actionIndex !== 0x02 ||
      parsed.option0Index !== (request.enabled ? 0x01 : 0x00)
    ) {
      return { ...parsed, ok: false, reason: 'switch ACK does not match request' };
    }
  }
  return parsed;
}

// HaloLyricSync / ToolBox checksum (text bytes only).
function haloLyricSyncChecksum(textBytes) {
  let acc = 128;
  for (const b of textBytes) {
    acc += b + 2;
  }
  return acc % 256;
}

function buildEcTextPacket(text, options = {}) {
  const maxLength = options.maxLength || 50;

  let working = String(text == null ? '' : text);
  if (working.length > maxLength) working = working.slice(0, maxLength);
  const textBytes = Buffer.from(working, 'utf8');
  const textLen = textBytes.length;
  const totalLen = 1 + textLen + 1;

  const frame = Buffer.concat([
    // TempoHub capture: length is big-endian and 0x0E is a fixed EC E8
    // payload marker. The checksum follows the declared payload length.
    Buffer.from([
      0x2e,
      0xaa,
      0xec,
      0xe8,
      (totalLen >> 8) & 0xff,
      totalLen & 0xff,
      0x0e,
      textLen
    ]),
    textBytes
  ]);
  return pad64(Buffer.concat([frame, Buffer.from([frameChecksum(frame)])]));
}

function buildEcLayoutPacket(layout = 'scroll_right_to_left') {
  const modeBytes = EC_LAYOUT_BYTES[layout];
  if (!modeBytes) {
    throw new EcPacketError(`Unsupported EC layout: ${layout}`);
  }
  return pad64(Buffer.from([...EC_LAYOUT_HEADER, ...modeBytes]));
}

function packetToHex(packet) {
  return Buffer.from(packet).toString('hex').toUpperCase();
}

module.exports = {
  PACKET_LENGTH,
  EC_DEVICE_TYPE,
  CMD_EC_PIXEL_SETTING,
  LYRIC_ANIMATION_PRESET_MIN,
  LYRIC_ANIMATION_PRESET_MAX,
  TEXT_COLORS,
  EC_LAYOUT_HEADER,
  EC_LAYOUT_BYTES,
  EcPacketError,
  frameChecksum,
  buildEcEfPacket,
  buildLyricAnimationPresetPacket,
  buildLyricAnimationSwitchPacket,
  parseLyricAnimationAck,
  validateLyricAnimationAck,
  haloLyricSyncChecksum,
  buildEcTextPacket,
  buildEcLayoutPacket,
  packetToHex
};
