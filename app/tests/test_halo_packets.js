// Protocol-layer tests for Halo packets (no real device).
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const {
  HaloPacketError,
  padPacket,
  edifierPacket,
  truncateUtf8,
  buildTextPacket,
  buildLayoutPacket,
  packetToHex
} = require(path.join(__dirname, '..', 'src', 'halo', 'packets'));
const {
  PACKET_LENGTH,
  TEXT_MAX_BYTES,
  TEXT_MAX_CHARS,
  LEGACY_TEXT_MAX_CHARS,
  HID_TEXT_BYTE_CAPACITY
} = require(path.join(__dirname, '..', 'src', 'halo', 'constants'));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

function sumFromAa(packet, endExclusive) {
  let sum = 0;
  for (let index = 1; index < endExclusive; index += 1) {
    sum = (sum + packet[index]) & 0xff;
  }
  return sum;
}

test('all builder outputs are 64 bytes', () => {
  const packets = [
    buildTextPacket('Celia'),
    buildTextPacket('宝宝'.repeat(30)),
    buildTextPacket('HELLO FROM GPT'),
    buildLayoutPacket('center', [240, 180, 200]),
    buildLayoutPacket('scroll_right_to_left', [255, 255, 255]),
    buildLayoutPacket('left', [0, 0, 0]),
    padPacket([0x2e, 0xaa]),
    edifierPacket(0xe8, [0x00, 0x00])
  ];
  for (const packet of packets) {
    assert.equal(packet.length, PACKET_LENGTH, `expected 64 bytes, got ${packet.length}`);
  }
});

test('text packet header matches reference (Celia)', () => {
  const packet = buildTextPacket('Celia');
  assert.deepEqual(
    [...packet.subarray(0, 8)],
    [0x2e, 0xaa, 0xed, 0xe8, 0x00, 0x07, 0x00, 0x05]
  );
  assert.equal(packet.subarray(8, 13).toString('utf8'), 'Celia');
});

test('ASCII text is no longer capped at the legacy 16-code-point value', () => {
  const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
  const packet = buildTextPacket(text);
  const payloadLength = packet[7];
  assert.equal(LEGACY_TEXT_MAX_CHARS, 16);
  assert.equal(TEXT_MAX_CHARS, LEGACY_TEXT_MAX_CHARS);
  assert.equal(payloadLength, text.length);
  assert.equal(packet.subarray(8, 8 + payloadLength).toString('utf8'), text);
});

test('text packet checksum is sum from 0xAA', () => {
  const packet = buildTextPacket('Celia');
  // payload length 7 -> checksum at index 13
  assert.equal(packet[13], sumFromAa(packet, 13));
  assert.equal(packet[13], sumFromAa(Buffer.concat([
    Buffer.from([0x2e, 0xaa, 0xed, 0xe8, 0x00, 0x07, 0x00, 0x05]),
    Buffer.from('Celia', 'utf8')
  ]), 13));
});

test('layout packet header and payload for scroll_right_to_left', () => {
  const packet = buildLayoutPacket('scroll_right_to_left', [0x66, 0xaf, 0xff]);
  assert.deepEqual(
    [...packet.subarray(0, 6)],
    [0x2e, 0xaa, 0xed, 0xef, 0x00, 0x09]
  );
  assert.deepEqual(
    [...packet.subarray(6, 15)],
    [0x01, 0x66, 0xaf, 0xff, 0x00, 0x02, 0x01, 0x01, 0xff]
  );
  assert.equal(packet[15], sumFromAa(packet, 15));
});

test('UTF-8 Chinese long text is truncated without mojibake', () => {
  const raw = '宝宝'.repeat(30); // 60 chars
  const packet = buildTextPacket(raw);
  const textLength = packet[7];
  assert.ok(textLength > 0 && textLength <= TEXT_MAX_BYTES);
  const decoded = packet.subarray(8, 8 + textLength).toString('utf8');
  assert.doesNotThrow(() => {
    // Round-trip decode must be valid UTF-8 (throws on invalid bytes in Buffer.toString in some paths;
    // also verify replacement char absence).
    const again = Buffer.from(decoded, 'utf8');
    assert.equal(again.length, textLength);
  });
  assert.ok(!decoded.includes('�'), 'decoded text must not contain replacement chars');
  assert.equal(decoded, '宝宝'.repeat(8)); // 16 chars * 3 bytes = 48
});

test('overlong CJK text respects the UTF-8 byte budget', () => {
  const text = '一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾中文歌词测试';
  const bytes = truncateUtf8(text);
  assert.ok(bytes.length <= TEXT_MAX_BYTES);
  assert.equal(
    bytes.toString('utf8'),
    Array.from(text.trim()).slice(0, 16).join('')
  );
  assert.equal(HID_TEXT_BYTE_CAPACITY, 55);
});

test('empty / whitespace text throws', () => {
  assert.throws(() => buildTextPacket(''), HaloPacketError);
  assert.throws(() => buildTextPacket('   \n\t'), HaloPacketError);
  assert.throws(() => truncateUtf8(null), HaloPacketError);
});

test('invalid layout throws', () => {
  assert.throws(() => buildLayoutPacket('diagonal', [255, 255, 255]), HaloPacketError);
  assert.throws(() => buildLayoutPacket('', [1, 2, 3]), HaloPacketError);
});

test('invalid RGB throws', () => {
  assert.throws(() => buildLayoutPacket('center', [256, 0, 0]), HaloPacketError);
  assert.throws(() => buildLayoutPacket('center', [0, 0]), HaloPacketError);
  assert.throws(() => buildLayoutPacket('center', ['a', 0, 0]), HaloPacketError);
});

test('oversized padPacket throws', () => {
  assert.throws(() => padPacket(Buffer.alloc(65)), HaloPacketError);
});

test('sample packets hex dump is stable', () => {
  const textHex = packetToHex(buildTextPacket('Celia'));
  assert.ok(textHex.startsWith('2EAAEDE80007000543656C6961'));
  const layoutHex = packetToHex(buildLayoutPacket('center', [240, 180, 200]));
  assert.ok(layoutHex.startsWith('2EAAEDEF000901F0B4C800020001FF'));
});

console.log('');
console.log(`Result: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  process.exitCode = 1;
}
