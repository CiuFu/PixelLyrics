// M5.2: Halo HID auto-reconnect tests (mock device; no real hardware).
// Usage: node tests/test_halo_reconnect.js
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { HaloClient, HaloDeviceError } = require(path.join(
  __dirname,
  '..',
  'src',
  'halo',
  'device'
));
const { buildTextPacket } = require(path.join(
  __dirname,
  '..',
  'src',
  'halo',
  'packets'
));
const { LyricPipeline } = require(path.join(
  __dirname,
  '..',
  'src',
  'pipeline',
  'lyric-pipeline'
));

function createMockHid() {
  const state = {
    present: true,
    failWrite: false,
    openCount: 0,
    writeCount: 0
  };
  const hid = {
    state,
    devices(vid, pid) {
      if (!state.present) return [];
      return [
        {
          path: 'mock-halo-path',
          vendor_id: 0x2d99,
          product_id: 0xa106,
          product_string: '花再 Halo PixelBar',
          manufacturer_string: 'Jieli',
          interface_number: 4,
          usage_page: 0xff14,
          usage: 1,
          vendorId: 0x2d99,
          productId: 0xa106,
          interface: 4,
          usagePage: 0xff14
        }
      ];
    },
    HID: class MockHID {
      constructor(devicePath) {
        if (!state.present) throw new Error('device not present');
        this.path = devicePath;
        state.openCount += 1;
      }
      write(data) {
        state.writeCount += 1;
        if (state.failWrite || !state.present) return -1;
        return data.length;
      }
      close() {}
    }
  };
  return hid;
}

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok  - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

async function main() {
  await test('disconnect on write failure enters waiting/reconnect', async () => {
    const hid = createMockHid();
    const logs = [];
    const client = new HaloClient({
      hid,
      reconnectIntervalMs: 30,
      onStatus: (evt) => logs.push(evt.message)
    });
    client.connect();
    assert.equal(client.isConnected(), true);
    hid.state.failWrite = true;
    assert.throws(() => client.sendPacket(buildTextPacket('测试')), HaloDeviceError);
    assert.equal(client.isConnected(), false);
    assert.ok(['waiting', 'reconnecting'].includes(client.state));
    assert.ok(logs.some((m) => m.includes('[halo] disconnected')));
    client.stopReconnect();
  });

  await test('reconnect finds device and reports success', async () => {
    const hid = createMockHid();
    const logs = [];
    const reconnects = [];
    const client = new HaloClient({
      hid,
      reconnectIntervalMs: 25,
      onStatus: (evt) => logs.push(evt.message),
      onReconnect: (device) => reconnects.push(device)
    });
    client.connect();
    hid.state.failWrite = true;
    hid.state.present = false;
    assert.throws(() => client.sendPacket(buildTextPacket('A')));
    // Device comes back
    hid.state.present = true;
    hid.state.failWrite = false;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(client.isConnected(), true);
    assert.ok(logs.some((m) => m.includes('[halo] reconnect success')));
    assert.ok(logs.some((m) => m.includes('[halo] reconnect attempt')));
    assert.equal(reconnects.length >= 1, true);
    client.stopReconnect();
  });

  await test('reconnect failed logs when device still absent', async () => {
    const hid = createMockHid();
    const logs = [];
    const client = new HaloClient({
      hid,
      reconnectIntervalMs: 20,
      onStatus: (evt) => logs.push(evt.message)
    });
    client.connect();
    hid.state.failWrite = true;
    hid.state.present = false;
    assert.throws(() => client.sendPacket(buildTextPacket('A')));
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(client.isConnected(), false);
    assert.ok(logs.some((m) => m.includes('[halo] reconnect failed')));
    client.stopReconnect();
  });

  await test('pipeline can send lyric again after reconnect', async () => {
    const hid = createMockHid();
    const client = new HaloClient({
      hid,
      reconnectIntervalMs: 20,
      onStatus: () => {}
    });
    const sent = [];
    const pipeline = new LyricPipeline({
      haloClient: client,
      dedupeWindowMs: 0,
      onSent: (info) => sent.push(info.text),
      onStatus: () => {},
      onEvent: () => {}
    });

    // Connected send
    const first = await pipeline.handleLyric({ text: '连接时歌词' });
    assert.equal(first.action, 'sent');

    // Disconnect
    hid.state.failWrite = true;
    hid.state.present = false;
    pipeline.currentDisplayedText = '';
    const failSend = await pipeline.handleLyric({ text: '断开时歌词' });
    assert.equal(failSend.action, 'error');

    // Device returns
    hid.state.present = true;
    hid.state.failWrite = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(client.isConnected(), true);

    const restored = await pipeline.handleLyric({ text: '重连后歌词' });
    assert.equal(restored.action, 'sent');
    assert.ok(sent.includes('重连后歌词'));
    client.stopReconnect();
  });

  await test('getStatus exposes connection state', async () => {
    const hid = createMockHid();
    const client = new HaloClient({ hid, reconnectIntervalMs: 30 });
    const status0 = client.getStatus();
    assert.equal(status0.connected, false);
    client.connect();
    const status1 = client.getStatus();
    assert.equal(status1.connected, true);
    assert.equal(status1.state, 'connected');
    client.disconnect();
  });

  console.log('');
  console.log(`Result: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});
