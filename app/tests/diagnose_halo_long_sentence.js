// Long-sentence scroll observation — as much text as the ED 0xE8 packet allows.
// Device cap: 16 chars / 48 UTF-8 bytes per text packet (halo_core / PROTOCOL_NOTES).
// Production display-strategy pages at this cap; this script only tests the device.
'use strict';

const path = require('node:path');
const { HaloClient } = require(path.join(__dirname, '..', 'src', 'halo', 'device'));
const { buildLayoutPacket, buildTextPacket, packetToHex } = require(path.join(
  __dirname,
  '..',
  'src',
  'halo',
  'packets'
));
const { TEXT_MAX_BYTES } = require(path.join(__dirname, '..', 'src', 'halo', 'constants'));

const RGB = [0x66, 0xaf, 0xff];
const FULL = '我带着比身体重的行李走向远方寻找自由';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function keepSpacesPacket(text) {
  let working = String(text);
  const chars = Array.from(working);
  if (chars.length > 16) working = chars.slice(0, 16).join('');
  let bytes = Buffer.from(working, 'utf8');
  while (bytes.length > TEXT_MAX_BYTES && Array.from(working).length > 1) {
    working = Array.from(working).slice(0, -1).join('');
    bytes = Buffer.from(working, 'utf8');
  }
  const payload = [0x00, bytes.length, ...bytes];
  const header = Buffer.from([
    0x2e, 0xaa, 0xed, 0xe8,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff
  ]);
  const body = Buffer.concat([header, Buffer.from(payload)]);
  let sum = 0;
  for (let i = 1; i < body.length; i += 1) sum = (sum + body[i]) & 0xff;
  return { packet: Buffer.concat([body, Buffer.from([sum]), Buffer.alloc(64 - body.length - 1)]), text: working, bytes: bytes.length };
}

async function sendScrollLine(client, label, text, pad) {
  const payloadText = text + ' '.repeat(pad);
  const built = keepSpacesPacket(payloadText);
  console.log('');
  console.log(`======== ${label} ========`);
  console.log(`text=${JSON.stringify(built.text)} pad=${pad} chars=${Array.from(built.text).length} utf8=${built.bytes}`);
  console.log(`hex=${packetToHex(built.packet).slice(0, 48)}...`);
  client.sendPacket(buildLayoutPacket('scroll_right_to_left', RGB));
  await sleep(200);
  client.sendPacket(built.packet);
  console.log('sent layout+scroll text — watch Halo for ~10s');
  await sleep(10000);
}

async function main() {
  const chars = Array.from(FULL);
  console.log('=== Long lyric on Halo (max packet text) ===');
  console.log('Full sentence:', FULL);
  console.log('Full length: chars=', chars.length, 'utf8=', Buffer.from(FULL).length);
  console.log('ED device limit per write: 16 chars / 48 UTF-8 bytes');
  console.log('');

  const max16 = chars.slice(0, 16).join('');
  console.log('Max one packet can hold:', JSON.stringify(max16), 'bytes=', Buffer.from(max16).length);
  console.log('Cannot fit remaining:', JSON.stringify(chars.slice(16).join('')));
  console.log('');

  const client = new HaloClient();
  try {
    const device = client.connect();
    console.log('[halo]', device.product);
  } catch (e) {
    console.log('[halo] fail', e.message);
    process.exitCode = 1;
    return;
  }

  // A: production-like max text, no trailing space
  await sendScrollLine(client, 'A max16 no-space', max16, 0);
  // B: max16 + 3 spaces (if device accepts 16+space it may truncate to 16)
  await sendScrollLine(client, 'B max16 +3 spaces', max16, 3);
  // C: slightly shorter + more spaces for marquee gap
  const max13 = chars.slice(0, 13).join('');
  await sendScrollLine(client, 'C first13 +6 spaces', max13, 6);

  console.log('');
  console.log('=== Reply ===');
  console.log('A/B/C: how much of the sentence is readable on Halo?');
  console.log('Any scroll pause / full re-enter from right / fixed-window wrap?');
  console.log('');
  console.log('Note: production display-strategy already pages at 16 chars + ~700ms hold');
  console.log('when a line is longer than one packet; full text remains in the app UI.');

  client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});