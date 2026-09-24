// Independent real-device experiment for EC EF animation + ED/EC E8 mixes.
// This does not modify DisplayStrategy or the production lyric pipeline.
'use strict';

const path = require('node:path');
const { HaloClient } = require(path.join(__dirname, '..', 'src', 'halo', 'device'));
const {
  buildLayoutPacket,
  buildTextPacket,
  packetToHex
} = require(path.join(__dirname, '..', 'src', 'halo', 'packets'));
const {
  buildEcTextPacket,
  parseLyricAnimationAck,
  validateLyricAnimationAck
} = require(path.join(__dirname, '..', 'src', 'halo', 'ec-packets'));

const DEFAULT_LINE_GAP_MS = 2000;
const DEFAULT_TICKER_GAP_MS = 300;
const ACK_TIMEOUT_MS = 3000;
const LAYOUT_DELAY_MS = 80;
const PRESET_SETTLE_MS = 300;
const RGB = [0x66, 0xaf, 0xff];
const HANDOFF_DELAYS_MS = [100, 200, 300, 400, 500];
const HANDOFF_TEXT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';
const HANDOFF_WINDOWS = [
  'ABCDEFGHIJKLMNOP',
  'BCDEFGHIJKLMNOPQ',
  'CDEFGHIJKLMNOPQR'
];
const HANDOFF_500_DELAY_MS = 500;
const HANDOFF_500_TEXTS = [
  'FIRST LYRIC ABCDEFGHIJKLMNOPQRST',
  'SECOND LYRIC 1234567890ABCDEFGHIJ',
  'THIRD LYRIC PIXEL EMOTION TEST 01',
  'FOURTH LYRIC OFFICIAL ANIMATION 02',
  'FIFTH LYRIC CLASSIC TICKER CHECK 3'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToHex(bytes) {
  return Buffer.from(bytes || []).toString('hex').toUpperCase().match(/../g)?.join(' ') || '';
}

function parseArgs(argv) {
  const options = {
    suite: 'all',
    lineGapMs: DEFAULT_LINE_GAP_MS,
    tickerGapMs: DEFAULT_TICKER_GAP_MS
  };
  for (const arg of argv) {
    if (arg.startsWith('--suite=')) options.suite = arg.slice('--suite='.length);
    else if (arg.startsWith('--line-gap=')) options.lineGapMs = Number(arg.slice('--line-gap='.length));
    else if (arg.startsWith('--ticker-gap=')) options.tickerGapMs = Number(arg.slice('--ticker-gap='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  console.log(`Halo EC EF animation matrix

  node tests/diagnose_halo_animation_matrix.js --suite=a
  node tests/diagnose_halo_animation_matrix.js --suite=b
  node tests/diagnose_halo_animation_matrix.js --suite=c
  node tests/diagnose_halo_animation_matrix.js --suite=handoff
  node tests/diagnose_halo_animation_matrix.js --suite=handoff500
  node tests/diagnose_halo_animation_matrix.js --suite=ec-repeat
  node tests/diagnose_halo_animation_matrix.js --suite=mixed-repeat500
  node tests/diagnose_halo_animation_matrix.js --suite=all

Options:
  --line-gap=2000       gap between fixed lyric lines
  --ticker-gap=300      gap between ED E8 software-ticker windows
`);
}

function readAck(client, request) {
  if (!client.device || typeof client.device.readTimeout !== 'function') {
    throw new Error('HID readTimeout is unavailable');
  }
  const deadline = Date.now() + ACK_TIMEOUT_MS;
  let lastMismatch = null;
  while (Date.now() < deadline) {
    const report = client.device.readTimeout(Math.min(500, deadline - Date.now())) || [];
    if (!report.length) continue;
    const parsed = parseLyricAnimationAck(report);
    if (!parsed.ok) continue;
    const checked = validateLyricAnimationAck(parsed, request);
    if (checked.ok) return checked;
    lastMismatch = checked.reason;
  }
  throw new Error(`timed out waiting for matching EC EF ACK${lastMismatch ? ` (${lastMismatch})` : ''}`);
}

function sendPacket(client, label, packet) {
  client.sendPacket(packet);
  console.log(`${label}: ${packetToHex(packet)}`);
}

function sendEdText(client, label, text) {
  const packet = buildTextPacket(text);
  sendPacket(client, `${label} ED E8 ${JSON.stringify(text)}`, packet);
}

function sendEcText(client, label, text) {
  const packet = buildEcTextPacket(text);
  sendPacket(client, `${label} EC E8 ${JSON.stringify(text)}`, packet);
}

function setAnimation(client, label, operation) {
  const result = operation === 'preset'
    ? client.setLyricAnimationPreset(1, { rgb: RGB })
    : client.setLyricAnimationEnabled(operation, { rgb: RGB });
  const request = operation === 'preset'
    ? { operation: 'preset', preset: 1 }
    : { operation: 'switch', enabled: operation };
  console.log(`${label} OUT payload: ${bytesToHex(result.packet.subarray(6, 15))}`);
  console.log(`${label} OUT report : ${packetToHex(result.packet)}`);
  const checked = readAck(client, request);
  console.log(`${label} ACK        : ${bytesToHex(checked.raw)}`);
  console.log(`${label} parsed     : ${JSON.stringify({
    ok: checked.ok,
    enabled: checked.enabled,
    preset: checked.currentPreset,
    option0: checked.option0Index,
    option1: checked.option1Index,
    option2: checked.option2Index
  })}`);
  if (!checked.ok) throw new Error(`${label} ACK validation failed: ${checked.reason}`);
}

async function prepare(client, label) {
  console.log(`\n--- ${label}: reset known animation state ---`);
  setAnimation(client, `${label} disable`, false);
  await sleep(PRESET_SETTLE_MS);
  setAnimation(client, `${label} enable`, true);
  await sleep(PRESET_SETTLE_MS);
  setAnimation(client, `${label} preset1`, 'preset');
  await sleep(PRESET_SETTLE_MS);
}

async function suiteA(client, options) {
  console.log('\n========== Test A: EC EF + current ED E8 =========');
  await prepare(client, 'A');
  const layout = buildLayoutPacket('center', RGB);
  sendPacket(client, 'A fixed ED EF center', layout);
  await sleep(LAYOUT_DELAY_MS);
  sendEdText(client, 'A1', '第一行歌词');
  await sleep(options.lineGapMs);
  sendEdText(client, 'A2', '第二行歌词');
  console.log('A observation: compare ED E8 exit/entry animation and text replacement.');
}

async function suiteB(client, options) {
  console.log('\n========== Test B: EC EF + TempoHub EC E8 =========');
  await prepare(client, 'B');
  sendEcText(client, 'B1', '第一行歌词');
  await sleep(options.lineGapMs);
  sendEcText(client, 'B2', '第二行歌词');
  console.log('B observation: baseline official EC E8 animation and text replacement.');
}

async function suiteC(client, options) {
  console.log('\n========== Test C: EC E8 entry + ED E8 ticker =========');
  await prepare(client, 'C');
  sendEcText(client, 'C entry', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789');
  const windows = [
    'ABCDEFGHIJKLMNOP',
    'BCDEFGHIJKLMNOPQ',
    'CDEFGHIJKLMNOPQR'
  ];
  for (let index = 0; index < windows.length; index += 1) {
    await sleep(options.tickerGapMs);
    sendEdText(client, `C ticker ${index + 1}`, windows[index]);
  }
  await sleep(options.lineGapMs);
  sendEcText(client, 'C next entry', 'SECOND LYRIC');
  console.log('C observation: entry animation, ED ticker continuity, and next EC entry/exit.');
}

async function suiteHandoff(client, options) {
  console.log('\n========== Test D: EC E8 -> timed handoff -> ED E8 ticker =========');
  console.log(`same preset=1 text=${JSON.stringify(HANDOFF_TEXT)}`);
  console.log(`delays=${HANDOFF_DELAYS_MS.join(', ')} ms tickerGap=${options.tickerGapMs} ms`);

  for (const delayMs of HANDOFF_DELAYS_MS) {
    console.log(`\n----- D handoff delay ${delayMs} ms -----`);
    await prepare(client, `D ${delayMs}ms`);

    sendEcText(client, `D ${delayMs}ms EC entry`, HANDOFF_TEXT);
    await sleep(delayMs);

    const layout = buildLayoutPacket('center', RGB);
    sendPacket(client, `D ${delayMs}ms ED EF center`, layout);
    await sleep(LAYOUT_DELAY_MS);
    sendEdText(client, `D ${delayMs}ms ED classic 1`, HANDOFF_WINDOWS[0]);

    for (let index = 1; index < HANDOFF_WINDOWS.length; index += 1) {
      await sleep(options.tickerGapMs);
      sendEdText(client, `D ${delayMs}ms ED ticker ${index + 1}`, HANDOFF_WINDOWS[index]);
    }
    console.log(`D ${delayMs}ms observation: compare complete entry, handoff flash/split, and ticker continuity.`);
    await sleep(options.lineGapMs);
  }
}

async function suiteHandoff500(client, options) {
  console.log('\n========== Test E: repeated EC E8 entries at 500ms handoff =========');
  console.log(`preset=1 delay=${HANDOFF_500_DELAY_MS}ms tickerGap=${options.tickerGapMs}ms`);
  console.log(`entries=${HANDOFF_500_TEXTS.length}`);

  for (let phraseIndex = 0; phraseIndex < HANDOFF_500_TEXTS.length; phraseIndex += 1) {
    const text = HANDOFF_500_TEXTS[phraseIndex];
    const label = `E ${phraseIndex + 1}/${HANDOFF_500_TEXTS.length}`;
    const windows = [text.slice(0, 16), text.slice(1, 17), text.slice(2, 18)];

    console.log(`\n----- ${label}: new lyric -> official animation -> classic ticker -----`);
    await prepare(client, `${label} re-arm`);
    sendEcText(client, `${label} EC entry`, text);
    await sleep(HANDOFF_500_DELAY_MS);

    const layout = buildLayoutPacket('center', RGB);
    sendPacket(client, `${label} ED EF center`, layout);
    await sleep(LAYOUT_DELAY_MS);
    sendEdText(client, `${label} ED classic 1`, windows[0]);

    for (let windowIndex = 1; windowIndex < windows.length; windowIndex += 1) {
      await sleep(options.tickerGapMs);
      sendEdText(client, `${label} ED ticker ${windowIndex + 1}`, windows[windowIndex]);
    }
    console.log(`${label} observation: every EC E8 entry should show the preset animation before ED E8 takes over.`);
    await sleep(options.lineGapMs);
  }
}

async function suiteEcRepeat(client, options) {
  console.log('\n========== Test F: repeated EC E8 only =========');
  console.log(`preset=1 entryGap=${options.lineGapMs}ms entries=${HANDOFF_500_TEXTS.length}`);
  console.log('No ED EF or ED E8 packets are sent in this control test.');
  await prepare(client, 'F');

  for (let phraseIndex = 0; phraseIndex < HANDOFF_500_TEXTS.length; phraseIndex += 1) {
    const label = `F ${phraseIndex + 1}/${HANDOFF_500_TEXTS.length}`;
    sendEcText(client, `${label} EC entry`, HANDOFF_500_TEXTS[phraseIndex]);
    console.log(`${label} observation: watch for a fresh official animation.`);
    await sleep(options.lineGapMs);
  }
}

async function suiteMixedRepeat500(client, options) {
  console.log('\n========== Test G: repeated EC E8 -> 500ms -> ED E8 ticker =========');
  console.log(`preset=1 handoffDelay=${HANDOFF_500_DELAY_MS}ms tickerGap=${options.tickerGapMs}ms entries=3`);
  console.log('One animation session; no EC EF reset between lyric entries.');
  await prepare(client, 'G');

  for (let phraseIndex = 0; phraseIndex < 3; phraseIndex += 1) {
    const text = HANDOFF_500_TEXTS[phraseIndex];
    const label = `G ${phraseIndex + 1}/3`;
    const windows = [text.slice(0, 16), text.slice(1, 17), text.slice(2, 18)];

    console.log(`\n----- ${label}: EC E8 entry -> 500ms -> ED E8 ticker -----`);
    sendEcText(client, `${label} EC entry`, text);
    await sleep(HANDOFF_500_DELAY_MS);
    sendEdText(client, `${label} ED classic 1`, windows[0]);
    for (let windowIndex = 1; windowIndex < windows.length; windowIndex += 1) {
      await sleep(options.tickerGapMs);
      sendEdText(client, `${label} ED ticker ${windowIndex + 1}`, windows[windowIndex]);
    }
    console.log(`${label} observation: the next EC E8 should start a new official animation.`);
    await sleep(options.lineGapMs);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
    if (!['a', 'b', 'c', 'handoff', 'handoff500', 'ec-repeat', 'mixed-repeat500', 'all'].includes(options.suite)) {
      throw new Error('--suite must be a, b, c, handoff, handoff500, ec-repeat, mixed-repeat500, or all');
  }
  if (!Number.isFinite(options.lineGapMs) || options.lineGapMs < 0) throw new Error('--line-gap must be non-negative');
  if (!Number.isFinite(options.tickerGapMs) || options.tickerGapMs < 0) throw new Error('--ticker-gap must be non-negative');

  const client = new HaloClient({ autoReconnect: false });
  try {
    console.log('=== Halo EC EF animation matrix ===');
    console.log(`suite=${options.suite} lineGap=${options.lineGapMs} tickerGap=${options.tickerGapMs}`);
    console.log(`connected=${JSON.stringify(client.connect())}`);
    if (options.suite === 'a' || options.suite === 'all') await suiteA(client, options);
    if (options.suite === 'b' || options.suite === 'all') await suiteB(client, options);
    if (options.suite === 'c' || options.suite === 'all') await suiteC(client, options);
    if (options.suite === 'handoff' || options.suite === 'all') await suiteHandoff(client, options);
    if (options.suite === 'handoff500' || options.suite === 'all') await suiteHandoff500(client, options);
    if (options.suite === 'ec-repeat' || options.suite === 'all') await suiteEcRepeat(client, options);
    if (options.suite === 'mixed-repeat500' || options.suite === 'all') await suiteMixedRepeat500(client, options);
    console.log('\n[done] visual observations must be recorded from the Halo display.');
    return 0;
  } finally {
    client.disconnect();
  }
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
