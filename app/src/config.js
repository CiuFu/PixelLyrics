// App-wide constants for PixelLyrics.
// Token root is unified: Electron userData == %APPDATA%/pixellyrics
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 19228;
const BRIDGE_MARKER = 'PIXELLYRICS_SODA_LYRICS_BRIDGE_V1';
const BRIDGE_TOKEN_FILE = 'pixellyrics-bridge-token';

const HALO = {
  vendorId: 0x2d99,
  productId: 0xa106,
  interfaceNumber: 4,
  usagePage: 0xff14,
  usage: 0x01,
  packetLength: 64,
  productHints: ['halo', 'pixelbar']
};

function bridgeTokenPath(userDataPath) {
  return path.join(userDataPath, BRIDGE_TOKEN_FILE);
}

// Single source of truth for CLI + Electron (non-Electron fallback).
// Electron should still prefer app.getPath('userData'), which is the same folder
// for package.json name "pixellyrics".
function resolveUserDataPath() {
  const roaming =
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'pixellyrics');
}

// Pre-M4.5 CLI storage under app/.pixellyrics-data — warn only, do not use.
function legacyUserDataPath(appRoot) {
  return path.join(appRoot || path.join(__dirname, '..'), '.pixellyrics-data');
}

function readLegacyBridgeToken(appRoot) {
  const tokenPath = bridgeTokenPath(legacyUserDataPath(appRoot));
  try {
    if (!fs.existsSync(tokenPath)) return null;
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function warnLegacyToken(appRoot, log = console.warn) {
  const legacyToken = readLegacyBridgeToken(appRoot);
  if (!legacyToken) return { legacy: false, token: null };
  const unified = resolveUserDataPath();
  log(
    `[pixellyrics] 检测到旧 bridge token（不再使用）: ${bridgeTokenPath(
      legacyUserDataPath(appRoot)
    )}\n` +
      `  统一 userDataPath = ${unified}\n` +
      `  请勿再使用 app/.pixellyrics-data；asar 注入必须与统一 token 一致。`
  );
  return { legacy: true, token: legacyToken, unifiedUserDataPath: unified };
}

module.exports = {
  BRIDGE_HOST,
  BRIDGE_PORT,
  BRIDGE_MARKER,
  BRIDGE_TOKEN_FILE,
  HALO,
  bridgeTokenPath,
  resolveUserDataPath,
  legacyUserDataPath,
  readLegacyBridgeToken,
  warnLegacyToken
};
