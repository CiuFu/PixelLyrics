// Numbered Halo scroll/trailing-space observation (no business logic changes).
// ED text cap: 16 chars / 48 UTF-8 bytes per packet.
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
const FULL = '我带着比身体重的行李走向远方寻找自由';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fitPacketText(text) {
  let working = String(text);
  let chars = Array.from(working);
  if (chars.length > 16) working = chars.slice(0, 16).join('');
  let bytes = Buffer.from(working, 'utf8');
  while (bytes.length > TEXT_MAX_BYTES && Array.from(working).length > 1) {
    working = Array.from(working).slice(0, -1).join('');
    bytes = Buffer.from(working, 'utf8');
  }
  return { text: working, chars: Array.from(working).length, bytes: bytes.length };
}

function buildKeepSpacesPacket(text) {
  const fitted = fitPacketText(text);
  const bytes = Buffer.from(fitted.text, 'utf8');
  const payload = [0x00, bytes.length, ...bytes];
  const header = Buffer.from([
    0x2e, 0xaa, 0xed, 0xe8,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff
  ]);
  const body = Buffer.concat([header, Buffer.from(payload)]);
  let sum = 0;
  for (let i = 1; i < body.length; i += 1) sum = (sum + body[i]) & 0xff;
  const packet = Buffer.concat([body, Buffer.from([sum]), Buffer.alloc(64 - body.length - 1)]);
  return { ...fitted, packet };
}

async function phase(client, label, rawText, gapMs) {
  const built = buildKeepSpacesPacket(rawText);
  console.log('');
  console.log(`======== ${label} ========`);
  console.log(`device text=${JSON.stringify(built.text)} chars=${built.chars} utf8=${built.bytes}`);
  console.log(`hex=${packetToHex(built.packet).slice(0, 44)}...`);
  console.log('WATCH HALO for this label only.');
  client.sendPacket(buildLayoutPacket('scroll_right_to_left', RGB));
  await sleep(200);
  client.sendPacket(built.packet);
  console.log(`--> ${label}1 sent, wait ${gapMs}ms (scroll loop)`);
  await sleep(gapMs);
  client.sendPacket(buildLayoutPacket('scroll_right_to_left', RGB));
  await sleep(200);
  client.sendPacket(built.packet);
  console.log(`--> ${label}2 re-sent same line, wait ${gapMs / 2}ms`);
  await sleep(Math.floor(gapMs / 2));
  console.log(`${label} done. Reply: gap? full re-enter from right? fixed-window wrap?`);
}

async function main() {
  const gapMs = 10000;
  const body = Array.from(FULL);
  console.log('=== Numbered Halo scroll test ===');
  console.log('Full sentence:', FULL, 'chars=', body.length);
  console.log('Device limit: 16 chars / 48 bytes per 0xE8');
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

  // A: numbered + as much of the sentence as fits (no trailing spaces in payload)
  const aBody = body.slice(0, 14).join(''); // A1 + 14 chars
  await phase(client, 'A', `A1${aBody}`, gapMs);
  await sleep(2500);

  // W: numbered + shorter body + trailing spaces (spaces must fit in 16 chars)
  const wBody = body.slice(0, 9).join('');
  await phase(client, 'W', `W1${wBody}    `, gapMs);
  await sleep(2500);

  // Z: numbered + even shorter + more trailing spaces
  const zBody = body.slice(0, 6).join('');
  await phase(client, 'Z', `Z1${zBody}      `, gapMs);

  console.log('');
  console.log('=== ALL DONE — look at the bar labels A1 / W1 / Z1 ===');
  console.log('Reply format:');
  console.log('  A: 间隔/完整右侧重进/固定窗？可读多少？');
  console.log('  W: ...');
  console.log('  Z: ...');
  client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});