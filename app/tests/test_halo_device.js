// Halo HID device tests / CLI. Safe without hardware; never throws uncaught.
// Usage:
//   node tests/test_halo_device.js
//   node tests/test_halo_device.js --text="你好PixelLyrics"
//   npm run test:halo-device -- --text="你好PixelLyrics"
'use strict';

const path = require('node:path');
const {
  HaloDeviceError,
  enumerateHaloDevices,
  listAllHidDevices,
  HaloClient
} = require(path.join(__dirname, '..', 'src', 'halo', 'device'));
const {
  VENDOR_ID,
  PRODUCT_ID,
  INTERFACE_NUMBER,
  CONTROL_USAGE_PAGE,
  CONTROL_USAGE
} = require(path.join(__dirname, '..', 'src', 'halo', 'constants'));

function parseArgs(argv) {
  const options = { text: null, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--text=')) {
      options.text = arg.slice('--text='.length);
    } else if (arg === '--text') {
      // allow "--text 你好" form
      const index = argv.indexOf(arg);
      if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
        options.text = argv[index + 1];
      }
    }
  }
  return options;
}

function printHelp() {
  console.log(`Halo device test CLI

Required device filter (from halo_core.py):
  VID ${`0x${VENDOR_ID.toString(16)}`} PID ${`0x${PRODUCT_ID.toString(16)}`}
  interface ${INTERFACE_NUMBER}
  usage page ${`0x${CONTROL_USAGE_PAGE.toString(16)}`} usage ${CONTROL_USAGE}
  product name contains "halo" or "pixelbar"

Commands:
  node tests/test_halo_device.js
    List HID devices and probe for Halo PixelBar (no write).

  node tests/test_halo_device.js --text="你好PixelLyrics"
    If Halo is present: send 0xEF layout (scroll_right_to_left) then 0xE8 text.

  npm run test:halo-device -- --text="你好PixelLyrics"
`);
}

function formatDeviceLine(label, device, index) {
  return (
    `  [${index}] ${label}\n` +
    `      product     : ${device.product || '(empty)'}\n` +
    `      manufacturer: ${device.manufacturer || '(empty)'}\n` +
    `      vendorId    : ${`0x${Number(device.vendorId || 0).toString(16)}`}\n` +
    `      productId   : ${`0x${Number(device.productId || 0).toString(16)}`}\n` +
    `      interface   : ${device.interfaceNumber}\n` +
    `      usagePage   : ${`0x${Number(device.usagePage || 0).toString(16)}`}\n` +
    `      usage       : ${device.usage}\n` +
    `      path        : ${device.path}`
  );
}

function runProbe() {
  console.log('=== Halo PixelBar device probe ===');
  console.log(
    `Filter: VID=0x${VENDOR_ID.toString(16)} PID=0x${PRODUCT_ID.toString(16)} ` +
      `iface=${INTERFACE_NUMBER} usagePage=0x${CONTROL_USAGE_PAGE.toString(16)} ` +
      `usage=${CONTROL_USAGE}`
  );
  console.log('');

  let allDevices = [];
  try {
    allDevices = listAllHidDevices();
  } catch (error) {
    console.log(`HID listing failed (will still try filtered enumerate): ${error.message}`);
  }

  console.log(`All HID interfaces on this machine: ${allDevices.length}`);
  if (!allDevices.length) {
    console.log('  (none reported by node-hid)');
  } else {
    const interesting = allDevices.filter((device) => {
      const vid = Number(device.vendorId || 0);
      const product = String(device.product || '').toLowerCase();
      return vid === VENDOR_ID || product.includes('halo') || product.includes('edifier') || product.includes('pixel');
    });
    const show = interesting.length ? interesting : allDevices.slice(0, 20);
    console.log(
      interesting.length
        ? `Showing Halo/EDIFIER-related or matching HID entries (${show.length}):`
        : `Showing first ${show.length} HID entries (no Halo-related name/VID matched):`
    );
    show.forEach((device, index) => {
      console.log(formatDeviceLine('hid', device, index));
    });
    if (!interesting.length && allDevices.length > show.length) {
      console.log(`  ... ${allDevices.length - show.length} more omitted`);
    }
  }

  console.log('');
  console.log('Strict Halo filter result:');
  let haloDevices = [];
  try {
    haloDevices = enumerateHaloDevices();
  } catch (error) {
    console.log(`  enumerate error: ${error.message}`);
    return { haloDevices: [], enumerateError: error };
  }

  if (!haloDevices.length) {
    console.log('  (empty) No Halo PixelBar control interface matched.');
    console.log('  Connect the device via a data-capable USB cable and re-run.');
  } else {
    haloDevices.forEach((device, index) => {
      console.log(formatDeviceLine('HALO', device, index));
    });
  }
  return { haloDevices, enumerateError: null };
}

function runSendText(text) {
  console.log('');
  console.log(`=== Halo sendText ===`);
  console.log(`text   : ${text}`);
  console.log('layout : scroll_right_to_left (default)');
  console.log('order  : 0xEF layout packet, then 0xE8 text packet');
  console.log('');

  const client = new HaloClient();
  try {
    const info = client.connect();
    console.log('connected:');
    console.log(
      `  ${info.product} | ${info.vendorId}:${info.productId} | ` +
        `iface ${info.interfaceNumber} | usage ${info.usagePage}/${info.usage}`
    );
    const result = client.sendText(text, { layout: 'scroll_right_to_left' });
    console.log('send result:');
    console.log(`  success : ${result.success}`);
    console.log(`  written : ${JSON.stringify(result.written)}`);
    console.log(`  layout  : ${result.layout}`);
    console.log(`  text    : ${result.text}`);
    return { ok: true, result };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const name = error && error.name ? error.name : 'Error';
    console.log(`send failed (${name}): ${message}`);
    if (!(error instanceof HaloDeviceError) && !/HID|Halo|not found|openable/i.test(message)) {
      console.log('Unexpected error type; stack:');
      console.log(error.stack || message);
    }
    return { ok: false, error };
  } finally {
    try {
      client.disconnect();
    } catch {
      // ignore
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }

  let exitCode = 0;
  try {
    const probe = runProbe();
    if (options.text != null && options.text !== '') {
      const send = runSendText(options.text);
      if (!send.ok) exitCode = 1;
    } else if (probe.enumerateError) {
      exitCode = 1;
    } else if (!probe.haloDevices.length) {
      console.log('');
      console.log('Probe-only mode: no device write performed.');
      console.log('Pass --text="..." to attempt a real send when Halo is connected.');
    }
  } catch (error) {
    // Never crash the process on unexpected failures.
    console.log(`Unhandled test error: ${error.message}`);
    console.log(error.stack || '');
    exitCode = 1;
  }

  console.log('');
  console.log(`Done. exitCode=${exitCode}`);
  return exitCode;
}

process.exitCode = main();
