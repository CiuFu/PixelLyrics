// Independent real-device experiment: ED vs EC packets + scroll send strategies.
// Does NOT modify packets.js / device.js / Pipeline.
// Usage:
//   node tests/test_halo_ec_protocol.js --suite=all
//   node tests/test_halo_ec_protocol.js --suite=ed-every
//   node tests/test_halo_ec_protocol.js --suite=ec-every
//   node tests/test_halo_ec_protocol.js --suite=ec-strategy
//   node tests/test_halo_ec_protocol.js --suite=ed-strategy
// Watch Halo: split = tail left + head right on the same marquee frame.
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
  buildEcLayoutPacket,
  haloLyricSyncChecksum
} = require(path.join(__dirname, '..', 'src', 'halo', 'ec-packets'));

const RGB = [0x66, 0xaf, 0xff];
const DEFAULT_GAP_MS = 7000;
const LAYOUT_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = { suite: 'all', gapMs: DEFAULT_GAP_MS };
  for (const arg of argv) {
    if (arg.startsWith('--suite=')) options.suite = arg.slice('--suite='.length);
    if (arg.startsWith('--gap=')) {
      const v = Number(arg.slice('--gap='.length));
      if (Number.isFinite(v) && v > 0) options.gapMs = v;
    }
  }
  return options;
}

function numberedLines(tag) {
  return [
    `${tag}1第一句`,
    `${tag}2第二句`,
    `${tag}3第三句`
  ];
}

function dumpPacket(label, buf) {
  console.log(`  ${label}: ${packetToHex(buf).slice(0, 56)}...`);
}

function sendRaw(client, packet, note) {
  const result = client.sendPacket(packet);
  console.log(`    write ok=${result.success !== false} ${note || ''}`);
  return result;
}

async function suiteEdEvery(client, gapMs) {
  console.log('');
  console.log('======== ED-Every (baseline, production-like) ========');
  console.log('Per line: ED 0xEF layout + ED 0xE8 text');
  console.log('Watch: W1第一句 W2第二句 W3第三句');
  const lines = numberedLines('W');
  const layout = buildLayoutPacket('scroll_right_to_left', RGB);
  dumpPacket('ED layout', layout);
  dumpPacket('ED text sample', buildTextPacket(lines[0]));
  for (let i = 0; i < lines.length; i += 1) {
    console.log(`--> ED every #${i + 1} "${lines[i]}"`);
    sendRaw(client, layout, 'ED layout');
    sendRaw(client, buildTextPacket(lines[i]), 'ED text');
    if (i < lines.length - 1) {
      console.log(`    wait ${gapMs}ms`);
      await sleep(gapMs);
    }
  }
}

async function suiteEcEvery(client, gapMs) {
  console.log('');
  console.log('======== EC-Every (ToolBox-like layout+text each line) ========');
  console.log('Per line: EC 0xEF layout + EC 0xE8 text');
  console.log('Watch: X1第一句 X2第二句 X3第三句');
  const lines = numberedLines('X');
  const layout = buildEcLayoutPacket('scroll_right_to_left');
  dumpPacket('EC layout', layout);
  dumpPacket('EC text sample', buildEcTextPacket(lines[0]));
  console.log('  checksum(A bytes) sample=', haloLyricSyncChecksum(Buffer.from(lines[0], 'utf8')));
  for (let i = 0; i < lines.length; i += 1) {
    console.log(`--> EC every #${i + 1} "${lines[i]}"`);
    sendRaw(client, layout, 'EC layout');
    sendRaw(client, buildEcTextPacket(lines[i]), 'EC text');
    if (i < lines.length - 1) {
      console.log(`    wait ${gapMs}ms`);
      await sleep(gapMs);
    }
  }
}

async function runStrategy(client, { tag, gapMs, family }) {
  const label = family === 'ec' ? 'EC-Strategy' : 'ED-Strategy';
  console.log('');
  console.log(`======== ${label} ========`);
  console.log('First enter scroll: layout + delay 300ms + text');
  console.log('Later lines: text only (no layout until mode/song reset)');
  console.log(`Watch: ${tag}1第一句 ${tag}2第二句 ${tag}3第三句`);
  const lines = numberedLines(tag);
  const layoutPacket =
    family === 'ec'
      ? buildEcLayoutPacket('scroll_right_to_left')
      : buildLayoutPacket('scroll_right_to_left', RGB);
  const textOf = (t) =>
    family === 'ec' ? buildEcTextPacket(t) : buildTextPacket(t);
  dumpPacket(`${family.toUpperCase()} layout`, layoutPacket);
  dumpPacket(`${family.toUpperCase()} text sample`, textOf(lines[0]));

  let scrollArmed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const modeReset = i === 0; // "first enter scroll" / suite start
    console.log(`--> ${label} #${i + 1} "${lines[i]}" modeReset=${modeReset}`);
    if (!scrollArmed || modeReset) {
      sendRaw(client, layoutPacket, `${family.toUpperCase()} layout`);
      console.log(`    delay ${LAYOUT_DELAY_MS}ms after layout`);
      await sleep(LAYOUT_DELAY_MS);
      scrollArmed = true;
    } else {
      console.log('    skip layout (steady scroll, text-only)');
    }
    sendRaw(client, textOf(lines[i]), `${family.toUpperCase()} text`);
    if (i < lines.length - 1) {
      console.log(`    wait ${gapMs}ms`);
      await sleep(gapMs);
    }
  }
  console.log(`${label} done. Simulate song change: next suite will re-arm layout.`);
}

async function suiteEdStrategy(client, gapMs) {
  await runStrategy(client, { tag: 'S', gapMs, family: 'ed' });
}

async function suiteEcStrategy(client, gapMs) {
  await runStrategy(client, { tag: 'Y', gapMs, family: 'ec' });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('=== Halo EC vs ED scroll experiment (independent CLI) ===');
  console.log('Device: EDIFIER Halo PixelBar. Pipeline/ED production code untouched.');
  console.log('Split signature: [tail left]+[head right] on one marquee cycle.');
  console.log('Suites:');
  console.log('  W* = ED layout+text each line');
  console.log('  X* = EC layout+text each line');
  console.log('  S* = ED strategy (layout once + delay, then text-only)');
  console.log('  Y* = EC strategy (layout once + delay, then text-only)');

  const client = new HaloClient();
  try {
    const device = client.connect();
    console.log('[halo] connected', device.product, device.vendorId + ':' + device.productId);
  } catch (error) {
    console.log('[halo] connect failed:', error.message);
    process.exitCode = 1;
    return;
  }

  const suite = options.suite;
  if (suite === 'all' || suite === 'ed-every') {
    await suiteEdEvery(client, options.gapMs);
    if (suite === 'all') {
      console.log('Pause 3s before next suite...');
      await sleep(3000);
    }
  }
  if (suite === 'all' || suite === 'ec-every') {
    await suiteEcEvery(client, options.gapMs);
    if (suite === 'all') {
      console.log('Pause 3s before next suite...');
      await sleep(3000);
    }
  }
  if (suite === 'all' || suite === 'ed-strategy') {
    await suiteEdStrategy(client, options.gapMs);
    if (suite === 'all') {
      console.log('Pause 3s before next suite...');
      await sleep(3000);
    }
  }
  if (suite === 'all' || suite === 'ec-strategy') {
    await suiteEcStrategy(client, options.gapMs);
  }

  console.log('');
  console.log('=== Reply checklist ===');
  console.log('W (ED every EF+E8):   saw W1W2W3? split yes/no');
  console.log('X (EC every EF+E8):   saw X1X2X3? split yes/no');
  console.log('S (ED layout-once):   saw S1S2S3? split yes/no');
  console.log('Y (EC layout-once):   saw Y1Y2Y3? split yes/no');
  console.log('');
  console.log('Interpretation:');
  console.log('- If X/Y normal but W/S split: switch protocol to EC for PixelBar.');
  console.log('- If S/Y normal but W/X split: keep ED, only change send strategy (layout+delay once, then E8).');
  console.log('- If all split: both dialects + strategies fail; firmware marquee reset still unavailable.');
  console.log('- If X writes fail / garbage: device on this HID path rejects EC; stay on ED.');

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