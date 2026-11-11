'use strict';

/**
 * Runtime adapter check.
 *
 * The catalog says what can be installed; this file proves that every adapter
 * in core/runtime-install.js is backed by a catalog entry, a published
 * checksum, no administrator requirement and a version command that exists.
 *
 * Offline by default: it reads the code and the catalog. With --live it also
 * asks each vendor for its current release and prints the URL, the version and
 * the digest it would verify, which is the only way to know that a resolver
 * still matches the page it reads.
 *
 *   node tools/runtime-adapters-check.js
 *   node tools/runtime-adapters-check.js --live node uv
 */

const catalog = require('../core/engine/catalog');
const { TOOLBOX, adapterIds, describe } = require('../core/runtime-install');

const args = process.argv.slice(2);
const live = args.includes('--live');
const wanted = args.filter((item) => !item.startsWith('--'));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

console.log('Runtime adapter check');
console.log('---------------------');

const ids = Object.keys(TOOLBOX);
record('there is at least one adapter', ids.length > 0, ids.join(', '));

for (const id of ids) {
  const tool = TOOLBOX[id];
  const entry = catalog.runtime(id);
  record(`${id}: has a catalog entry`, Boolean(entry), entry ? entry.label : 'missing from catalog.json');
  if (entry) {
    record(`${id}: catalog says implemented`, entry.status === 'implemented', `status ${entry.status}`);
    // A managed install needs a verification story: the vendor's digest, or a
    // digest this build pins for one exact release (reported as pinned, never
    // as published).
    record(
      `${id}: checksum is published or pinned`,
      Boolean(entry.checksum?.published || entry.checksum?.pinned),
      `${entry.checksum?.algorithm || 'none'}${entry.checksum?.pinned && !entry.checksum?.published ? ' (pinned)' : ''}`
    );
    record(`${id}: never needs administrator rights`, entry.requiresAdmin === false, `requiresAdmin ${entry.requiresAdmin}`);
    record(
      `${id}: has a windows x64 build`,
      catalog.platformLevel(entry, 'win32', 'x64') === 'full',
      catalog.platformLevel(entry, 'win32', 'x64')
    );
  }
  record(`${id}: resolver is a function`, typeof tool.resolve === 'function', '');
  record(`${id}: installer is a function`, typeof tool.install === 'function', '');
  record(`${id}: has a verification command`, Array.isArray(tool.verifyArgs) && tool.verifyArgs.length > 0, (tool.verifyArgs || []).join(' '));
  record(`${id}: has a binary name`, Boolean(tool.bin), tool.bin || '');
  record(`${id}: describes its destination`, Boolean(describe(id)?.destination), describe(id)?.destination || '');
  const needs = tool.needs || [];
  for (const dep of needs) {
    record(`${id}: dependency ${dep} is an adapter`, Boolean(TOOLBOX[dep]), dep);
  }
  if (tool.provides) {
    for (const extra of tool.provides) {
      record(`${id}: provides catalog runtime ${extra}`, Boolean(catalog.runtime(extra)), extra);
    }
  }
}

// Every runtime the app says it can install has to be one the catalog knows,
// and the reverse must not promise an installer that does not exist.
const adapters = adapterIds();
for (const id of adapters) {
  record(`adapter id ${id} exists in the catalog`, Boolean(catalog.runtime(id)), id);
}
const implementedManaged = catalog.runtimes().filter((item) => item.status === 'implemented' && item.installMode === 'managed');
for (const item of implementedManaged) {
  record(`${item.id}: implemented in the catalog means an adapter exists`, adapters.includes(item.id), adapters.includes(item.id) ? '' : 'no adapter in runtime-install.js');
}

async function main() {
  if (!live) {
    console.log('---------------------');
    const failed = results.filter((item) => !item.ok);
    console.log(`${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exit(1);
    return;
  }

  console.log('\nLive release resolution');
  console.log('---------------------');
  const targets = wanted.length ? wanted : ids;
  for (const id of targets) {
    const tool = TOOLBOX[id];
    if (!tool) {
      record(`live ${id}`, false, 'no adapter');
      continue;
    }
    try {
      const meta = await tool.resolve();
      const digest = String(meta.sha256 || '');
      const ok = /^[0-9a-f]{64}$/.test(digest) && /^https:\/\//.test(meta.url || '') && Boolean(meta.file);
      record(
        `live ${id}`,
        ok,
        ok ? `${meta.version || 'latest'} ${meta.file} sha256 ${digest.slice(0, 16)}…` : JSON.stringify(meta)
      );
      if (ok) console.log(`      ${meta.url}`);
    } catch (error) {
      record(`live ${id}`, false, error.message);
    }
  }
  const failed = results.filter((item) => !item.ok);
  console.log('---------------------');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
