'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The installation catalog: every runtime GUITinstal knows about, how it can
 * reach a machine, and how far that has actually been built.
 *
 * The catalog is data, and this file is the only place that reads it. The rest
 * of the engine asks questions here instead of keeping a second copy of the
 * truth, so a new runtime is one JSON entry rather than three edits in three
 * files.
 */

const CATALOG_FILE = path.join(__dirname, 'catalog.json');

const INSTALL_MODES = ['managed', 'guided', 'bundled', 'builtin'];
const STATUSES = ['implemented', 'catalogued', 'external'];
const PLATFORM_LEVELS = ['full', 'partial', 'none', 'external'];
const PLATFORMS = ['win32', 'darwin', 'linux'];
const ARCHITECTURES = ['x64', 'arm64'];

const REQUIRED_FIELDS = [
  'id',
  'label',
  'ecosystem',
  'summary',
  'versions',
  'officialSource',
  'download',
  'platforms',
  'installerFormat',
  'checksum',
  'signature',
  'destination',
  'versionCommand',
  'verification',
  'uninstall',
  'installMode',
  'requiresAdmin',
  'requiresReboot',
  'needs',
  'status',
];

let cached = null;

/** The parsed catalog. Read once: it never changes while the app runs. */
function raw() {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  }
  return cached;
}

/** Fingerprint of the catalog file, so a report can prove which data it read. */
function digest() {
  return crypto.createHash('sha256').update(fs.readFileSync(CATALOG_FILE)).digest('hex');
}

function engine() {
  return raw().engine;
}

function ecosystems() {
  return raw().ecosystems;
}

function runtimes() {
  return raw().runtimes;
}

function runtime(id) {
  const wanted = String(id || '').trim().toLowerCase();
  return raw().runtimes.find((item) => item.id === wanted) || null;
}

function stacks() {
  return raw().stacks;
}

function stack(id) {
  return raw().stacks[String(id || '').trim().toLowerCase()] || null;
}

function forEcosystem(id) {
  const wanted = String(id || '').trim().toLowerCase();
  return raw().runtimes.filter((item) => item.ecosystem === wanted);
}

function platformLevel(item, platform, arch) {
  const entry = item.platforms?.[platform];
  if (!entry) return 'none';
  return entry[arch] || 'none';
}

/** Runtimes the vendor ships for this operating system and processor. */
function forPlatform(platform, arch) {
  return raw().runtimes.filter((item) => platformLevel(item, platform, arch) !== 'none');
}

/**
 * Runtimes GUITstal can download, verify and install by itself on this
 * platform. Anything else is a guided install or comes from outside.
 */
function managedOn(platform, arch) {
  return forPlatform(platform, arch).filter(
    (item) => item.installMode === 'managed' && platformLevel(item, platform, arch) === 'full'
  );
}

/** Runtimes that only a human can install, with the official page to do it. */
function guidedOn(platform, arch) {
  return forPlatform(platform, arch).filter((item) => item.installMode === 'guided');
}

function installableNow(platform, arch) {
  return raw().runtimes.filter((item) => item.status === 'implemented');
}

/**
 * Checks the catalog against itself.
 *
 * This is the guard that keeps the promise "make it work before claiming it
 * works" honest at the data level: every runtime must carry the fields the
 * engine needs, every dependency must exist, and nothing may be marked as a
 * managed install without a checksum to verify it against — published by the
 * vendor, or pinned by this build with a visible warning.
 *
 * @returns {{ ok: boolean, problems: Array<{ level: string, id: string, message: string }> }}
 */
function validate() {
  const problems = [];
  const add = (level, id, message) => problems.push({ level, id, message });

  const data = raw();
  if (!data.engine || !Array.isArray(data.ecosystems) || !Array.isArray(data.runtimes) || !data.stacks) {
    add('error', 'catalog', 'the catalog is missing engine, ecosystems, runtimes or stacks');
    return { ok: false, problems };
  }

  const seen = new Set();
  const byId = new Map();

  for (const item of data.runtimes) {
    const id = item.id || '(no id)';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id || '')) {
      add('error', id, 'the id must be lowercase letters, digits and dashes');
    }
    if (seen.has(item.id)) add('error', id, 'the id is used more than once');
    seen.add(item.id);
    byId.set(item.id, item);

    for (const field of REQUIRED_FIELDS) {
      if (item[field] === undefined || item[field] === null || item[field] === '') {
        add('error', id, `the catalog entry is missing "${field}"`);
      }
    }

    if (!INSTALL_MODES.includes(item.installMode)) {
      add('error', id, `unknown installMode "${item.installMode}"`);
    }
    if (!STATUSES.includes(item.status)) {
      add('error', id, `unknown status "${item.status}"`);
    }
    if (!/^https:\/\//.test(item.officialSource || '')) {
      add('error', id, 'the official source must be an https link');
    }
    if (!Array.isArray(item.needs)) {
      add('error', id, 'needs must be a list');
    }
    if (!item.versionCommand?.command || !Array.isArray(item.versionCommand?.args)) {
      add('error', id, 'the version command needs a command and an argument list');
    }

    for (const platform of PLATFORMS) {
      const entry = item.platforms?.[platform];
      if (!entry) {
        add('warning', id, `the catalog says nothing about ${platform}`);
        continue;
      }
      for (const arch of ARCHITECTURES) {
        if (!PLATFORM_LEVELS.includes(entry[arch])) {
          add('error', id, `${platform}/${arch} has an unknown support level "${entry[arch]}"`);
        }
      }
    }

    // A managed install downloads a file and runs it, so the bytes need a
    // verification story: either the vendor publishes a digest, or this build
    // pins the digest of the exact release it supports. "Pinned" is the weaker
    // of the two, so it is always reported as a warning instead of staying
    // invisible.
    const verifiedBytes = Boolean(item.checksum?.published || item.checksum?.pinned);
    if (item.installMode === 'managed' && !verifiedBytes) {
      add('error', id, 'a managed install needs a published or pinned checksum');
    }
    if (item.checksum?.pinned && !item.checksum?.published) {
      add('warning', id, 'the vendor publishes no checksum, so this build pins the digest of one exact release');
    }
    if (item.installMode === 'managed' && !item.checksum?.algorithm) {
      add('error', id, 'a managed install needs a checksum algorithm');
    }
    if (item.requiresAdmin && item.installMode === 'managed') {
      add('warning', id, 'a managed install must never ask for administrator rights');
    }
    if (item.status === 'external' && !item.reason) {
      add('warning', id, 'an external runtime should explain why it is not installed here');
    }
    if (item.status === 'implemented' && item.installMode === 'managed' && !verifiedBytes) {
      add('error', id, 'an implemented managed runtime needs a published or pinned checksum');
    }
  }

  // Dependencies must exist and must not loop.
  for (const item of data.runtimes) {
    for (const need of item.needs || []) {
      if (!byId.has(need)) {
        add('error', item.id, `needs "${need}", which is not in the catalog`);
      }
    }
  }
  for (const item of data.runtimes) {
    const seenPath = new Set();
    let current = item;
    while (current) {
      if (seenPath.has(current.id)) {
        add('error', item.id, 'the dependency list loops back to itself');
        break;
      }
      seenPath.add(current.id);
      const next = (current.needs || []).map((need) => byId.get(need)).find(Boolean);
      if (!next) break;
      current = next;
    }
  }

  // Ecosystems and their runtime lists must agree in both directions.
  for (const group of data.ecosystems) {
    for (const id of group.runtimes || []) {
      const item = byId.get(id);
      if (!item) {
        add('error', group.id, `lists the runtime "${id}", which is not in the catalog`);
        continue;
      }
      if (item.ecosystem !== group.id) {
        add('error', id, `is listed under ${group.id} but declares the ecosystem ${item.ecosystem}`);
      }
    }
  }
  for (const item of data.runtimes) {
    const group = data.ecosystems.find((entry) => entry.id === item.ecosystem);
    if (!group) {
      add('error', item.id, `declares the unknown ecosystem "${item.ecosystem}"`);
      continue;
    }
    if (!(group.runtimes || []).includes(item.id)) {
      add('error', item.id, `is not listed under its ecosystem ${group.id}`);
    }
  }

  // Stacks must only name runtimes the catalog knows.
  for (const [id, definition] of Object.entries(data.stacks)) {
    for (const runtimeId of [...(definition.runtimes || []), ...(definition.packageManagers || [])]) {
      if (!byId.has(runtimeId)) {
        add('error', id, `names the runtime "${runtimeId}", which is not in the catalog`);
      }
    }
    if (!definition.label) add('error', id, 'a stack needs a label');
  }

  const errors = problems.filter((item) => item.level === 'error');
  return { ok: errors.length === 0, problems };
}

module.exports = {
  ARCHITECTURES,
  CATALOG_FILE,
  INSTALL_MODES,
  PLATFORMS,
  PLATFORM_LEVELS,
  STATUSES,
  digest,
  ecosystems,
  engine,
  forEcosystem,
  forPlatform,
  guidedOn,
  installableNow,
  managedOn,
  platformLevel,
  raw,
  runtime,
  runtimes,
  stack,
  stacks,
  validate,
};
