// Halo continuous lyric scroll diagnostics (M4.5 follow-up).
// Does NOT change Soda Bridge / MediaSession / LyricPipeline.
// Usage:
//   node tests/diagnose_halo_scroll.js
//   node tests/diagnose_halo_scroll.js --phase=current
//   node tests/diagnose_halo_scroll.js --phase=double-layout
//   node tests/diagnose_halo_scroll.js --phase=layout-delay
//   node tests/diagnose_halo_scroll.js --phase=wide-gap
//   node tests/diagnose_halo_scroll.js --phase=all
// Watch the PixelBar while phases run. Observe whether each line enters
// fully from the right, or appears split (tail left + head right).
'use strict';

const path = require('node:path');

const { HaloClient } = require(path.join(__dirname, '..', 'src', 'halo', 'device'));
const {
  buildLayoutPacket,
  buildTextPacket,
  edifierPacket,
  packetToHex
} = require(path.join(__dirname, '..', 'src', 'halo', 'packets'));

const BASE_LINES = ['第一句测试歌词', '第二句测试歌词', '第三句测试歌词'];
const LAYOUT = 'scroll_right_to_left';
const RGB = [0x66, 0xaf, 0xff];

// Prefix lines with phase id so the bar itself shows which mode is running.
// Keep total length <= 16 chars (protocol limit).
function linesForPhase(phaseLabel) {
  return BASE_LINES.map((line, index) => {
    const n = index + 1;
    const tag = `${phaseLabel}${n}`;
    // "A1当前第一句测试" style — short enough to fit with prefix.
    const body = line.replace('测试歌词', '');
    return `${tag}${body}`.slice(0, 16);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = { phase: 'all', gapMs: 3500, layoutDelayMs: 120 };
  for (const arg of argv) {
    if (arg.startsWith('--phase=')) options.phase = arg.slice('--phase='.length);
    if (arg.startsWith('--gap=')) {
      const v = Number(arg.slice('--gap='.length));
      if (Number.isFinite(v) && v >= 0) options.gapMs = v;
    }
    if (arg.startsWith('--layout-delay=')) {
      const v = Number(arg.slice('--layout-delay='.length));
      if (Number.isFinite(v) && v >= 0) options.layoutDelayMs = v;
    }
  }
  return options;
}

function dumpPackets(label, sampleText) {
  const layout = buildLayoutPacket(LAYOUT, RGB);
  const text = buildTextPacket(sampleText || 'A1当前第一句');
  console.log(`[packets] ${label}`);
  console.log(`  layout 0xEF ${LAYOUT} hex=${packetToHex(layout).slice(0, 40)}...`);
  console.log(`  text   0xE8 "${sampleText || 'A1当前第一句'}" hex=${packetToHex(text).slice(0, 48)}...`);
}

async function sendViaClient(client, text, mode, options = {}) {
  const layoutDelayMs = options.layoutDelayMs || 0;
  const centerHoldMs = options.centerHoldMs || 1200;
  if (mode === 'text-only') {
    const result = client.sendPacket(buildTextPacket(text));
    return { mode, text, result };
  }
  if (mode === 'layout-delay-text') {
    client.sendPacket(buildLayoutPacket(LAYOUT, RGB));
    await sleep(layoutDelayMs);
    const result = client.sendPacket(buildTextPacket(text));
    return { mode, text, layoutDelayMs, result };
  }
  if (mode === 'double-layout-text') {
    client.sendPacket(buildLayoutPacket(LAYOUT, RGB));
    client.sendPacket(buildLayoutPacket(LAYOUT, RGB));
    await sleep(50);
    const result = client.sendPacket(buildTextPacket(text));
    return { mode, text, result };
  }
  if (mode === 'center-then-scroll-text') {
    client.sendPacket(buildLayoutPacket('center', RGB));
    client.sendPacket(buildTextPacket('.'));
    await sleep(80);
    client.sendPacket(buildLayoutPacket(LAYOUT, RGB));
    const result = client.sendPacket(buildTextPacket(text));
    return { mode, text, result };
  }
  if (mode === 'static-center-only') {
    client.sendPacket(buildLayoutPacket('center', RGB));
    const result = client.sendPacket(buildTextPacket(text));
    return { mode, text, result };
  }
  if (mode === 'color-reset-then-scroll') {
    client.sendPacket(
      edifierPacket(0xef, [0x03, RGB[0], RGB[1], RGB[2], 0x00, 0x00, 0xff, 0xff, 0xff])
    );
    await sleep(30);
    client.sendPacket(buildLayoutPacket(LAYOUT, RGB));
    const result = client.sendPacket(buildTextPacket(text));
    return { mode, text, result };
  }
  if (mode === 'center-show-then-scroll') {
    client.sendPacket(buildLayoutPacket('center', RGB));
    client.sendPacket(buildTextPacket(text));
    await sleep(centerHoldMs);
    client.sendPacket(buildLayoutPacket(LAYOUT, RGB));
    const result = client.sendPacket(buildTextPacket(text));
    return { mode, text, centerHoldMs, result };
  }
  const result = client.sendText(text, { layout: LAYOUT, rgb: RGB });
  return { mode: 'current-sendText', text, result };
}

async function runPhase(name, client, mode, options) {
  const phaseLabel = options.phaseLabel || name.slice(0, 1);
  const lines = linesForPhase(phaseLabel);
  console.log('');
  console.log(`======== PHASE: ${name} ========`);
  console.log(`mode=${mode} gapMs=${options.gapMs} layoutDelayMs=${options.layoutDelayMs}`);
  console.log(`Watch for these exact strings on Halo:`);
  lines.forEach((line) => console.log(`  ${line}`));
  console.log('Healthy: each line enters fully from the RIGHT.');
  console.log('Split: [tail of line] on left + [head of line] on right at the same time.');
  dumpPackets(name, lines[0]);

  const observations = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    console.log(`--> send #${i + 1}: "${text}" (${mode})`);
    const outcome = await sendViaClient(client, text, mode, options);
    observations.push(outcome);
    console.log(`    written ok=${outcome.result?.success !== false}`);
    if (i < lines.length - 1) {
      console.log(`    wait ${options.gapMs}ms ... watch bar for "${lines[i + 1]}"`);
      await sleep(options.gapMs);
    }
  }
  console.log(`PHASE ${name} done. Last line on bar should be "${lines[lines.length - 1]}"`);
  return observations;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('=== Halo continuous scroll diagnostics (numbered lines) ===');
  console.log('Phase A lines start with A1/A2/A3');
  console.log('Phase B lines start with B1/B2/B3');
  console.log('Tell me which letters appeared and whether each looked split.');

  const client = new HaloClient();
  try {
    const device = client.connect();
    console.log('[halo] connected', device.product, device.vendorId + ':' + device.productId);
  } catch (error) {
    console.log('[halo] connect failed:', error.message);
    process.exitCode = 1;
    return;
  }

  const phases = [];
  if (options.phase === 'all' || options.phase === 'current') {
    phases.push(['A-current-sendText', 'current-sendText', 'A']);
  }
  if (options.phase === 'all' || options.phase === 'layout-delay') {
    phases.push(['B-layout-delay-text', 'layout-delay-text', 'B']);
  }
  if (options.phase === 'all' || options.phase === 'double-layout') {
    phases.push(['C-double-layout-text', 'double-layout-text', 'C']);
  }
  if (options.phase === 'all' || options.phase === 'center-reset') {
    phases.push(['D-center-then-scroll-text', 'center-then-scroll-text', 'D']);
  }
  if (options.phase === 'all' || options.phase === 'wide-gap') {
    const wide = { ...options, gapMs: Math.max(options.gapMs, 6000), phaseLabel: 'E' };
    console.log('');
    console.log(`(E-wide-gap uses gap=${wide.gapMs}ms + production sendText)`);
    await runPhase('E-wide-gap-sendText', client, 'current-sendText', wide);
  }
  if (options.phase === 'static' || options.phase === 'G') {
    phases.push(['G-static-center-only', 'static-center-only', 'G']);
  }
  if (options.phase === 'color-reset' || options.phase === 'F') {
    phases.push(['F-color-reset-then-scroll', 'color-reset-then-scroll', 'F']);
  }
  if (options.phase === 'center-show' || options.phase === 'H') {
    phases.push(['H-center-show-then-scroll', 'center-show-then-scroll', 'H']);
  }
  if (options.phase === 'reset-suite') {
    phases.push(['G-static-center-only', 'static-center-only', 'G']);
    phases.push(['F-color-reset-then-scroll', 'color-reset-then-scroll', 'F']);
    phases.push(['H-center-show-then-scroll', 'center-show-then-scroll', 'H']);
  }

  for (const [name, mode, label] of phases) {
    await runPhase(name, client, mode, { ...options, phaseLabel: label });
    if (options.phase === 'all') {
      console.log('Pause 2s between phases...');
      await sleep(2000);
    }
  }

  console.log('');
  console.log('=== Reply format ===');
  console.log('A (current 0EF+0E8): split yes/no — saw A1 A2 A3?');
  console.log('B (0EF delay 150ms 0E8): split yes/no — saw B1 B2 B3?');
  console.log('Optional C/D/E if you re-run with --phase=all');
  void phases;

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
