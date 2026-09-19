// HID identity and protocol constants for EDIFIER Halo PixelBar.
//
// Third-party notice:
// Adapted from Seraph310/halo-pixelbar-mcp (halo_core.py / PROTOCOL_NOTES.md).
// Copyright (c) 2026 Seraph310
// License: MIT
// See THIRD_PARTY.md at the repository root.
// Values match refs/halo-pixelbar-mcp-main/halo_core.py (validated source).
'use strict';

const VENDOR_ID = 0x2d99;
const PRODUCT_ID = 0xa106;
const INTERFACE_NUMBER = 4;
const PACKET_LENGTH = 64;
const CONTROL_USAGE_PAGE = 0xff14;
const CONTROL_USAGE = 0x01;
const EDIFIER_DEVICE_TYPE = 0xed;

// Host frame: 2E AA ED <cmd> <len_hi> <len_lo> <payload...> <checksum> <pad...>
const HOST_FRAME_PREFIX = [0x2e, 0xaa, 0xed];

// Commands needed for MVP lyrics display.
const CMD_TEXT_SET = 0xe8;
const CMD_PIXEL_SETTING = 0xef;

const LAYOUTS = {
  left: [0, 0],
  center: [0, 1],
  right: [0, 2],
  stretch: [0, 3],
  scroll_left_to_right: [1, 0],
  scroll_right_to_left: [1, 1]
};

const TEXT_MAX_CHARS = 16;
const TEXT_MAX_BYTES = 48;

module.exports = {
  VENDOR_ID,
  PRODUCT_ID,
  INTERFACE_NUMBER,
  PACKET_LENGTH,
  CONTROL_USAGE_PAGE,
  CONTROL_USAGE,
  EDIFIER_DEVICE_TYPE,
  HOST_FRAME_PREFIX,
  CMD_TEXT_SET,
  CMD_PIXEL_SETTING,
  LAYOUTS,
  TEXT_MAX_CHARS,
  TEXT_MAX_BYTES
};
