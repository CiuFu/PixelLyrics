// Independent real-device diagnostic for the EC EF lyric-animation protocol.
// Usage:
//   node tests/diagnose_halo_lyric_animation.js --enable
//   node tests/diagnose_halo_lyric_animation.js --disable
//   node tests/diagnose_halo_lyric_animation.js --preset=0
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
const {
  buildEcTextPacket,
  parseLyricAnimationAck,
  validateLyricAnimationAck
} = require(path.join(__dirname, '..', 'src', 'halo', 'ec-packets'));

const DEFAULT_GAP_MS = 2500;
const DEFAULT_ACK_TIMEOUT_MS = 3000;
const FIXED_LAYOUT_DELAY_MS = 80;
const PRESET_SETTLE_DELAY_MS = 300;

function bytesToHex(bytes) {
  return Buffer.from(bytes || []).toString('hex').toUpperCase().match(/../g)?.join(' ') || '';
}

function parseArgs(argv) {
  const options = {
    operation: null,
    preset: null,
    gapMs: DEFAULT_GAP_MS,
    ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
    e8Family: 'ec',
    help: false
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--enable') {
      if (options.operation) throw new Error('choose exactly one operation');
      options.operation = 'switch';
      options.enabled = true;
    } else if (arg === '--disable') {
      if (options.operation) throw new Error('choose exactly one operation');
      options.operation = 'switch';
      options.enabled = false;
    } else if (arg.startsWith('--preset=')) {
      if (options.operation) throw new Error('choose exactly one operation');
      options.operation = 'preset';
      options.preset = Number(arg.slice('--preset='.length));
    } else if (arg.startsWith('--gap=')) {
      options.gapMs = Number(arg.slice('--gap='.length));
    } else if (arg.startsWith('--ack-timeout=')) {
      options.ackTimeoutMs = Number(arg.slice('--ack-timeout='.length));
    } else if (arg.startsWith('--e8=')) {
      options.e8Family = arg.slice('--e8='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  console.log(`EC EF lyric-animation diagnostic

Commands:
  node tests/diagnose_halo_lyric_animation.js --enable
  node tests/diagnose_halo_lyric_animation.js --disable
  node tests/diagnose_halo_lyric_animation.js --preset=0|1|2|3|4

Optional:
  --gap=2500          delay between E8 animation-test lines
  --ack-timeout=3000  ACK read timeout in milliseconds
  --e8=ed|ec          E8 family used by the fixed lyric test (default: ec)
`);
}

function readAck(client, timeoutMs) {
  if (!client.device || typeof client.device.readTimeout !== 'function') {
    throw new Error('HID readTimeout is unavailable; cannot verify EC EF ACK');
  }
  const deadline = Date.now() + timeoutMs;
  let lastRaw = [];
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const report = client.device.readTimeout(Math.min(500, remaining)) || [];
    if (!report.length) continue;
    lastRaw = Array.from(report);
    const parsed = parseLyricAnimationAck(report);
    if (parsed.ok) return { raw: Buffer.from(report), parsed };
  }
  throw new Error(`timed out waiting for EC EF ACK; last report=${bytesToHex(lastRaw)}`);
}

function sendAnimationOperation(client, options) {
  const request = options.operation === 'preset'
    ? { operation: 'preset', preset: options.preset }
    : { operation: 'switch', enabled: options.enabled };
  const startedAt = Date.now();
  const result = options.operation === 'preset'
    ? client.setLyricAnimationPreset(options.preset)
    : client.setLyricAnimationEnabled(options.enabled);
  const out = Buffer.from(result.packet);
  console.log(`OUT payload       : ${bytesToHex(out.subarray(6, 15))}`);
  console.log(`OUT report        : ${packetToHex(out)}`);

  const ack = readAck(client, options.ackTimeoutMs);
  const latency = Date.now() - startedAt;
  const parsed = validateLyricAnimationAck(ack.parsed, request);
  console.log(`ACK              : ${packetToHex(ack.raw)}`);
  console.log(`ACK latency      : ${latency} ms`);
  console.log(
    `parsed enabled   : ${parsed.ok
      ? request.operation === 'switch' ? parsed.enabled : 'not asserted by preset ACK'
      : 'invalid'}`
  );
  console.log(`parsed option0   : ${parsed.ok ? parsed.option0Index : 'invalid'}`);
  console.log(
    `parsed preset    : ${parsed.ok
      ? parsed.currentPreset == null ? 'not returned' : parsed.currentPreset
      : 'invalid'}`
  );
  if (!parsed.ok) throw new Error(`ACK validation failed: ${parsed.reason}`);
  return parsed;
}

async function runAnimationTest(client, gapMs, e8Family) {
  const lines = ['第一行歌词', '第二行歌词', '第三行歌词'];
  console.log(`\nFixed lyric ${e8Family.toUpperCase()} E8 animation trigger test: no software ticker, no hardware scroll.`);
  if (e8Family === 'ed') {
    const layoutPacket = buildLayoutPacket('center', client.defaultRgb);
    client.sendPacket(layoutPacket);
    console.log(`fixed layout report: ${packetToHex(layoutPacket)}`);
    await new Promise((resolve) => setTimeout(resolve, FIXED_LAYOUT_DELAY_MS));
  } else {
    console.log('TempoHub-compatible EC E8 sequence: no extra ED EF layout packet.');
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const packet = e8Family === 'ec' ? buildEcTextPacket(line) : buildTextPacket(line);
    client.sendPacket(packet);
    console.log(`${e8Family.toUpperCase()} E8 #${index + 1}: ${line}`);
    console.log(`${e8Family.toUpperCase()} E8 report: ${packetToHex(packet)}`);
    if (index < lines.length - 1) await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.operation) {
    usage();
    return options.help ? 0 : 1;
  }
  if (options.operation === 'preset' && (!Number.isInteger(options.preset) || options.preset < 0 || options.preset > 4)) {
    throw new Error('--preset must be an integer from 0 to 4');
  }
  if (!Number.isFinite(options.gapMs) || options.gapMs < 0) {
    throw new Error('--gap must be a non-negative number');
  }
  if (!Number.isFinite(options.ackTimeoutMs) || options.ackTimeoutMs <= 0) {
    throw new Error('--ack-timeout must be positive');
  }
  if (!['ed', 'ec'].includes(options.e8Family)) {
    throw new Error('--e8 must be ed or ec');
  }

  const client = new HaloClient({ autoReconnect: false });
  try {
    console.log('=== Halo EC EF lyric-animation diagnostic ===');
    console.log(`operation        : ${options.operation === 'preset' ? `preset ${options.preset}` : options.enabled ? 'enable' : 'disable'}`);
    console.log(`E8 gap           : ${options.gapMs} ms`);
    console.log(`E8 family        : ${options.e8Family.toUpperCase()}`);
    console.log(`ACK timeout      : ${options.ackTimeoutMs} ms`);
    console.log(`connected        : ${JSON.stringify(client.connect())}`);
    sendAnimationOperation(client, options);
    if (options.operation === 'preset') {
      await new Promise((resolve) => setTimeout(resolve, PRESET_SETTLE_DELAY_MS));
      await runAnimationTest(client, options.gapMs, options.e8Family);
    }
    console.log('\n[done] inspect the Halo for automatic enter/exit animation on each E8 line.');
    return 0;
  } finally {
    client.disconnect();
  }
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
