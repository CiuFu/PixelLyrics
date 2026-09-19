// M5.2 tray residency lifecycle tests (no Electron required).
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { createAppLifecycle } = require(path.join(
  __dirname,
  '..',
  'src',
  'app-lifecycle'
));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

function main() {
  test('start running; hide -> hidden; show -> running', () => {
    const life = createAppLifecycle();
    assert.equal(life.getState(), 'running');
    assert.equal(life.hideWindow(), 'hidden');
    assert.equal(life.showWindow(), 'running');
  });

  test('pause/resume lyrics sync flag', () => {
    const life = createAppLifecycle();
    assert.equal(life.isLyricsPaused(), false);
    life.setLyricsPaused(true);
    assert.equal(life.isLyricsPaused(), true);
    life.setLyricsPaused(false);
    assert.equal(life.isLyricsPaused(), false);
  });

  test('releasing/exited block hide/show', () => {
    const life = createAppLifecycle();
    life.beginRelease();
    assert.equal(life.getState(), 'releasing');
    assert.equal(life.hideWindow(), 'releasing');
    assert.equal(life.showWindow(), 'releasing');
    life.markExited();
    assert.equal(life.getState(), 'exited');
    assert.equal(life.hideWindow(), 'exited');
  });

  test('main.js uses close->hide, not closed->quit', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main.js'),
      'utf8'
    );
    assert.ok(src.includes("mainWindow.on('close'"));
    assert.ok(!src.includes("on('closed', app.quit)"));
    assert.ok(!src.includes('on("closed", app.quit)'));
    assert.ok(src.includes('Tray'));
    assert.ok(src.includes('createTray'));
  });

  console.log('');
  console.log(`Result: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main();
