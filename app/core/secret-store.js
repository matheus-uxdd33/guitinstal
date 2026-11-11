'use strict';

/**
 * Where the GitHub token is allowed to live.
 *
 * config.json is plain text: anything written there can be read by any process
 * the user runs and it rides along into backups. On Windows the token is
 * therefore sealed with DPAPI (the operating system's per-user key) and stored
 * as an opaque blob that only the same user on the same machine can open.
 * Elsewhere the app keeps the token in memory for the running session and says
 * so, instead of quietly dropping it into a text file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { userDataDir, ensureDir } = require('./paths');

const ENTROPY = 'GUITinstal/github-token';
const FILE_NAME = 'github-token.dpapi';
const MARKER = 'guitinstal-protected-v1:';

function blobPath() {
  return path.join(userDataDir(), FILE_NAME);
}

/**
 * The token travels over stdin, never inside argv: a command line would show it
 * to any other process that lists them. Only the fixed entropy string is inline.
 */
const PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$in=[Console]::In.ReadToEnd().Trim()',
  '$bytes=[Text.Encoding]::UTF8.GetBytes($in)',
  `$ent=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
  '$out=[Security.Cryptography.ProtectedData]::Protect($bytes,$ent,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('; ');

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$in=[Console]::In.ReadToEnd().Trim()',
  '$blob=[Convert]::FromBase64String($in)',
  `$ent=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
  '$out=[Security.Cryptography.ProtectedData]::Unprotect($blob,$ent,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))',
].join('; ');

function runPowerShell(script, input) {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      // Piped, not inherited: PowerShell's own error text must not land in the
      // app log, where it could be mistaken for a token.
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  return String(out || '').trim();
}

/**
 * Reads the sealed file. '' means "nothing stored"; an error means a blob exists
 * that this user cannot open, so the caller should ask them to sign in again.
 */
function load() {
  if (process.platform !== 'win32') return { token: '', engine: 'memory-only', detail: '' };

  let raw;
  try {
    raw = fs.readFileSync(blobPath(), 'utf8');
  } catch {
    return { token: '', engine: 'windows-dpapi', detail: '' };
  }

  let body = String(raw).trim();
  if (!body) return { token: '', engine: 'windows-dpapi', detail: '' };
  if (body.startsWith(MARKER)) body = body.slice(MARKER.length);

  try {
    return { token: runPowerShell(UNPROTECT_SCRIPT, body).trim(), engine: 'windows-dpapi', detail: '' };
  } catch {
    // The raw failure quotes the whole command line; that is noise at best, and
    // the user only needs to know the seal is broken and to sign in again.
    return {
      token: '',
      engine: 'windows-dpapi',
      detail: 'Windows could not open the saved token. Sign in again to replace it.',
    };
  }
}

/** Stores the token. An empty value removes it. Says where it ended up. */
function save(token) {
  const value = String(token || '').trim();

  if (process.platform !== 'win32') {
    return {
      stored: Boolean(value),
      engine: 'memory-only',
      path: '',
      detail: value ? 'This system has no supported secure store, so the token lives only in this session.' : '',
    };
  }

  const file = blobPath();
  if (!value) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* a file that is already gone needs no second delete */
    }
    return { stored: false, engine: 'windows-dpapi', path: file, detail: '' };
  }

  try {
    const blob = runPowerShell(PROTECT_SCRIPT, value);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${MARKER}${blob}`, { encoding: 'utf8' });
    return { stored: true, engine: 'windows-dpapi', path: file, detail: '' };
  } catch {
    return {
      stored: false,
      engine: 'windows-dpapi',
      path: '',
      detail: 'Windows refused to protect the token. Nothing was written, so it is not saved on disk.',
    };
  }
}

/** Lets Settings tell the user how the credential is kept. */
function describe() {
  if (process.platform !== 'win32') {
    return { engine: 'memory-only', label: 'held in this session only', path: '' };
  }
  return { engine: 'windows-dpapi', label: 'Windows protected storage (this user only)', path: blobPath() };
}

module.exports = { describe, load, save };
