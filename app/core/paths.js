'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const APP_NAME = 'GUITinstal';
// The version lives in exactly one place. Reading package.json here means the
// app can never display a version the build did not come from.
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Where settings, the project registry and runtime state live. */
function userDataDir() {
  // Portable setups and the installation-proof run point the whole engine at
  // another folder. The app itself never sets this, so a normal start still
  // uses %APPDATA%\GUITinstal.
  const override = String(process.env.GUITINSTAL_USER_DATA || '').trim();
  if (override) return path.resolve(override);
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, APP_NAME);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Default place where cloned repositories are stored.
 *
 * A "Repositories" folder on the Desktop is where people already keep the
 * projects they download, so it is the default the gallery scans. Machines
 * without a Desktop folder keep the old home-directory workspace.
 */
function defaultWorkspace() {
  const desktop = path.join(os.homedir(), 'Desktop');
  if (fs.existsSync(desktop)) return path.join(desktop, 'Repositories');
  return path.join(os.homedir(), 'GUITinstal-workspace');
}

function runtimeFile() {
  return path.join(userDataDir(), 'runtime.json');
}

function appRoot() {
  return path.resolve(__dirname, '..');
}

module.exports = {
  APP_NAME,
  APP_VERSION,
  appRoot,
  defaultWorkspace,
  ensureDir,
  runtimeFile,
  userDataDir,
};
