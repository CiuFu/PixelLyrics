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
// Does NOT replace ED TempoHub packets in packets.js — research layer only.
// Reference: nxz1026/HaloLyricSync src/hid_packet_builder.py
'use strict';

const PACKET_LENGTH = 64;

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

function pad64(data) {
  const buf = Buffer.from(data);
  if (buf.length > PACKET_LENGTH) {
    throw new EcPacketError(`EC packet too large: ${buf.length}`);
  }
  return Buffer.concat([buf, Buffer.alloc(PACKET_LENGTH - buf.length)]);
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
  const colorName = options.color || 'white';
  const maxLength = options.maxLength || 50;
  const color = Object.prototype.hasOwnProperty.call(TEXT_COLORS, colorName)
    ? TEXT_COLORS[colorName]
    : 0;

  let working = String(text == null ? '' : text);
  if (working.length > maxLength) working = working.slice(0, maxLength);
  const textBytes = Buffer.from(working, 'utf8');
  const textLen = textBytes.length;
  const totalLen = 1 + textLen + 1;

  const packet = Buffer.concat([
    Buffer.from([0x2e, 0xaa, 0xec, 0xe8, color]),
    Buffer.from([totalLen & 0xff, (totalLen >> 8) & 0xff]),
    Buffer.from([textLen]),
    textBytes,
    Buffer.from([haloLyricSyncChecksum(textBytes)])
  ]);
  return pad64(packet);
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
  TEXT_COLORS,
  EC_LAYOUT_HEADER,
  EC_LAYOUT_BYTES,
  EcPacketError,
  haloLyricSyncChecksum,
  buildEcTextPacket,
  buildEcLayoutPacket,
  packetToHex
};