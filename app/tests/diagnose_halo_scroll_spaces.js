// Halo scroll trailing-space experiment (no business-logic changes).
// packets.js buildTextPacket trims spaces — this test builds raw ED text
// packets that KEEP trailing spaces so we can observe device marquee behavior.
// Usage:
//   node tests/diagnose_halo_scroll_spaces.js
//   node tests/diagnose_halo_scroll_spaces.js --gap=9000
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
const { TEXT_MAX_BYTES } = require(path.join(__dirname, '..', 'src', 'halo', 'constants'));

const RGB = [0x66, 0xaf, 0xff];
const LAYOUT = 'scroll_right_to_left';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const options = { gapMs: 9000 };
  for (const arg of argv) {
    if (arg.startsWith('--gap=')) {
      const v = Number(arg.slice('--gap='.length));
      if (Number.isFinite(v) && v > 0) options.gapMs = v;
    }
  }
  return options;
}

// Raw ED 0xE8 that preserves trailing spaces (test-only; production still trims).
function buildTextPacketKeepSpaces(text) {
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
    0x2e,
    0xaa,
    0xed,
    0xe8,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff
  ]);
  const body = Buffer.concat([header, Buffer.from(payload)]);
  let sum = 0;
  for (let i = 1; i < body.length; i += 1) sum = (sum + body[i]) & 0xff;
  return Buffer.concat([body, Buffer.from([sum]), Buffer.alloc(64 - body.length - 1)]);
}

function dump(label, text, packet) {
  const visible = JSON.stringify(text);
  console.log(`  ${label} text=${visible} utf8Len=${Buffer.from(text, 'utf8').length} chars=${Array.from(text).length}`);
  console.log(`    hex=${packetToHex(packet).slice(0, 40)}...`);
}

async function sendCase(client, tag, base, padSpaces, gapMs) {
  const text = base + ' '.repeat(padSpaces);
  console.log('');
  console.log(`======== ${tag} padSpaces=${padSpaces} ========`);
  console.log(`Watch Halo: does marquee pause after text, re-enter fully from right, or wrap in a fixed window?`);
  dump(`${tag}1`, text, buildTextPacketKeepSpaces(text));
  client.sendPacket(buildLayoutPacket(LAYOUT, RGB));
  await sleep(200);
  client.sendPacket(buildTextPacketKeepSpaces(text));
  console.log(`  sent ${tag}1 (layout+text). Watch full loop ~${gapMs}ms...`);
  await sleep(gapMs);
  console.log(`  sent ${tag}2 same text again (re-arm layout+text)`);
  client.sendPacket(buildLayoutPacket(LAYOUT, RGB));
  await sleep(200);
  client.sendPacket(buildTextPacketKeepSpaces(text));
  await sleep(Math.floor(gapMs / 2));
  console.log(`  ${tag} phase done`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('=== Halo scroll + trailing spaces (device observation) ===');
  console.log('Production packets.js TRIMS spaces — this test uses raw ED packets.');
  console.log('Base sentence (fits device after padding):');
  const base = '行李走向远方寻自由';
  console.log(`  base=${JSON.stringify(base)} chars=${Array.from(base).length}`);
  console.log('');
  console.log('Cases:');
  console.log('  N*  no trailing spaces');
  console.log('  W*  +3 trailing spaces');
  console.log('  Z*  +6 trailing spaces');
  console.log('');
  console.log('Reply for each:');
  console.log('  1) gap after scroll before loop? yes/no');
  console.log('  2) full re-enter from right? yes/no');
  console.log('  3) fixed-window wrap instead? yes/no');

  const client = new HaloClient();
  try {
    const device = client.connect();
    console.log('[halo] connected', device.product);
  } catch (error) {
    console.log('[halo] connect failed:', error.message);
    process.exitCode = 1;
    return;
  }

  // Compare production builder (trimmed) once for reference.
  const { buildTextPacket } = require(path.join(__dirname, '..', 'src', 'halo', 'packets'));
  const trimmed = buildTextPacket(base + '   ');
  const kept = buildTextPacketKeepSpaces(base + '   ');
  console.log('[note] production builder would trim: last payload bytes differ from keep-spaces packet');
  console.log('  prod hex tail', packetToHex(trimmed).slice(24, 48));
  console.log('  keep hex tail', packetToHex(kept).slice(24, 48));

  const gap = options.gapMs;
  await sendCase(client, 'N', base, 0, gap);
  await sleep(2000);
  await sendCase(client, 'W', base, 3, gap);
  await sleep(2000);
  await sendCase(client, 'Z', base, 6, gap);

  console.log('');
  console.log('=== Test complete. Watch was on device during N/W/Z. ===');
  console.log('Please reply per case (N/W/Z): gap? re-enter? fixed-window?');
  try {
    client.disconnect();
  } catch {
    // ignore
  }
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});