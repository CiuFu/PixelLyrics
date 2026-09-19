// Single-shot Halo scroll observation — no mid-loop re-send (isolate firmware flash).
// Watch: A1... scroll right→left; does it flash/jump to left before finishing?
'use strict';

const path = require('node:path');
const { HaloClient } = require(path.join(__dirname, '..', 'src', 'halo', 'device'));
const { buildLayoutPacket, packetToHex } = require(path.join(
  __dirname,
  '..',
  'src',
  'halo',
  'packets'
));

const RGB = [0x66, 0xaf, 0xff];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildPacket(text) {
  const bytes = Buffer.from(text, 'utf8');
  const payload = [0x00, bytes.length, ...bytes];
  const header = Buffer.from([
    0x2e, 0xaa, 0xed, 0xe8,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff
  ]);
  const body = Buffer.concat([header, Buffer.from(payload)]);
  let sum = 0;
  for (let i = 1; i < body.length; i += 1) sum = (sum + body[i]) & 0xff;
  return Buffer.concat([body, Buffer.from([sum]), Buffer.alloc(64 - body.length - 1)]);
}

async function main() {
  const text = 'A1我带着比身体重的行李走向远方';
  const packet = buildPacket(text);
  console.log('=== Halo scroll ONCE only (no re-send during watch) ===');
  console.log('text', JSON.stringify(text), 'bytes', Buffer.from(text).length);
  console.log('hex', packetToHex(packet).slice(0, 40), '...');
  console.log('');
  console.log('Timeline:');
  console.log('  t=0s   send 0xEF scroll + 0xE8 text (ONCE)');
  console.log('  t=0..20s  DO NOT send anything else — pure device animation');
  console.log('');
  console.log('Observe A1… over ~20 seconds:');
  console.log('  - Does it scroll R→L until fully off-screen?');
  console.log('  - Mid-scroll jump/flash to leftmost? yes/no');
  console.log('  - Then clean re-enter from right? yes/no');
  console.log('  - Or continuous fixed-window wrap? yes/no');

  const client = new HaloClient();
  try {
    const device = client.connect();
    console.log('[halo]', device.product);
  } catch (e) {
    console.log('[halo] fail', e.message);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('>>> SENDING ONCE NOW — watch A1 on Halo <<<');
  client.sendPacket(buildLayoutPacket('scroll_right_to_left', RGB));
  await sleep(200);
  client.sendPacket(packet);
  console.log('[sent] layout+text only once at t=0');
  console.log('[watch] 20s device-only — no PixelLyrics writes...');
  await sleep(20000);
  console.log('[done] 20s elapsed with no re-send');
  console.log('');
  console.log('Please reply for this single-send run:');
  console.log('  A1 mid-scroll flash to left? yes/no');
  console.log('  A1 full exit then re-enter from right? yes/no');
  console.log('  A1 fixed-window wrap only? yes/no');
  console.log('Also if you saw earlier W/Z: gap / re-enter / wrap?');
  client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});