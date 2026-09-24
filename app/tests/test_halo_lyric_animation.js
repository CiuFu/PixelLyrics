// EC EF lyric-animation packet tests (no real device).
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const {
  EcPacketError,
  buildEcTextPacket,
  buildLyricAnimationPresetPacket,
  buildLyricAnimationSwitchPacket,
  frameChecksum,
  parseLyricAnimationAck,
  validateLyricAnimationAck
} = require(path.join(__dirname, '..', 'src', 'halo', 'ec-packets'));

const RGB = [0x12, 0x34, 0x56];
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

function assertOutFrame(packet, payload) {
  assert.equal(packet.length, 64);
  assert.deepEqual([...packet.subarray(0, 6)], [0x2e, 0xaa, 0xec, 0xef, 0x00, 0x09]);
  assert.deepEqual([...packet.subarray(6, 15)], payload);
  assert.equal(packet[15], frameChecksum(packet.subarray(0, 15)));
  assert.ok(packet.subarray(16).every((byte) => byte === 0));
}

function makeAck(payload) {
  const frame = Buffer.from([0x2f, 0xbb, 0xec, 0xef, 0x00, 0x09, ...payload]);
  return Buffer.concat([frame, Buffer.from([frameChecksum(frame)]), Buffer.alloc(48)]);
}

for (let preset = 0; preset <= 4; preset += 1) {
  test(`preset ${preset} uses the fixed EC EF payload`, () => {
    assertOutFrame(
      buildLyricAnimationPresetPacket(preset, RGB),
      [0x01, ...RGB, 0x00, 0x00, 0x01, 0x00, preset]
    );
  });
}

test('enable uses FF FF as unspecified preset fields', () => {
  assertOutFrame(
    buildLyricAnimationSwitchPacket(true, RGB),
    [0x02, ...RGB, 0x00, 0x00, 0x01, 0xff, 0xff]
  );
});

test('disable uses FF FF as unspecified preset fields', () => {
  assertOutFrame(
    buildLyricAnimationSwitchPacket(false, RGB),
    [0x02, ...RGB, 0x00, 0x00, 0x00, 0xff, 0xff]
  );
});

test('invalid preset and RGB values are rejected', () => {
  assert.throws(() => buildLyricAnimationPresetPacket(-1, RGB), EcPacketError);
  assert.throws(() => buildLyricAnimationPresetPacket(5, RGB), EcPacketError);
  assert.throws(() => buildLyricAnimationPresetPacket(1.5, RGB), EcPacketError);
  assert.throws(() => buildLyricAnimationPresetPacket(0, [256, 0, 0]), EcPacketError);
  assert.throws(() => buildLyricAnimationSwitchPacket('true', RGB), EcPacketError);
});

test('ACK parser validates EC EF, nine-byte payload, and checksum', () => {
  const ack = makeAck([0x01, ...RGB, 0x00, 0x00, 0x01, 0x00, 0x04]);
  const parsed = parseLyricAnimationAck(ack);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.currentPreset, 4);
  assert.deepEqual(parsed.rgb, RGB);

  const broken = Buffer.from(ack);
  broken[15] ^= 0xff;
  assert.equal(parseLyricAnimationAck(broken).ok, false);

  const wrongCommand = Buffer.from(ack);
  wrongCommand[3] = 0xee;
  assert.equal(parseLyricAnimationAck(wrongCommand).ok, false);

  const wrongLength = Buffer.from(ack);
  wrongLength[5] = 0x08;
  assert.equal(parseLyricAnimationAck(wrongLength).ok, false);
});

test('switch ACK accepts device-resolved current preset instead of FF FF', () => {
  const ack = makeAck([0x02, ...RGB, 0x00, 0x00, 0x01, 0x00, 0x04]);
  const parsed = validateLyricAnimationAck(ack, { operation: 'switch', enabled: true });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.option1Index, 0x00);
  assert.equal(parsed.option2Index, 0x04);
  assert.equal(parsed.currentPreset, 4);
});

test('switch ACK exposes no preset when the device returns FF FF', () => {
  const ack = makeAck([0x02, ...RGB, 0x00, 0x00, 0x00, 0xff, 0xff]);
  const parsed = validateLyricAnimationAck(ack, { operation: 'switch', enabled: false });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.currentPreset, null);
  assert.equal(parsed.option2Index, 0xff);
});

test('preset ACK must echo the requested preset', () => {
  const ack = makeAck([0x01, ...RGB, 0x00, 0x00, 0x01, 0x00, 0x03]);
  assert.equal(
    validateLyricAnimationAck(ack, { operation: 'preset', preset: 3 }).ok,
    true
  );
  assert.equal(
    validateLyricAnimationAck(ack, { operation: 'preset', preset: 4 }).ok,
    false
  );
});

test('EC E8 matches the TempoHub payload marker and big-endian length', () => {
  const text = '第一行歌词';
  const textBytes = Buffer.from(text, 'utf8');
  const packet = buildEcTextPacket(text);
  const payloadLength = 1 + 1 + textBytes.length;
  assert.deepEqual(
    [...packet.subarray(0, 8)],
    [0x2e, 0xaa, 0xec, 0xe8, (payloadLength >> 8) & 0xff, payloadLength & 0xff, 0x0e, textBytes.length]
  );
  assert.deepEqual([...packet.subarray(8, 8 + textBytes.length)], [...textBytes]);
  assert.equal(packet[8 + textBytes.length], frameChecksum(packet.subarray(0, 8 + textBytes.length)));
});

console.log('');
console.log(`Result: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
