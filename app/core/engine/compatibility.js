'use strict';

const catalog = require('./catalog');
const requirements = require('./requirements');

/**
 * The compatibility engine.
 *
 * A repository can be perfectly fine and still be impossible to install on the
 * machine in front of the user. This module answers one question per runtime:
 * can it live here, and if not, who has to do something about it.
 *
 * The verdicts are deliberately narrow. "installable" means GUITinstal can do
 * it by itself, with an adapter that exists in this build. "guided" means a
 * human has to install it from the official page. "blocked" means it cannot
 * work here at all, and pretending otherwise would be a lie the user finds out
 * about later.
 *
 * A catalog entry is not proof of an installer: a runtime marked "managed" in
 * the catalog only becomes "installable" when `adapters` names a real adapter
 * for it. That rule is what keeps a promise in a JSON file from becoming a
 * button that does nothing.
 */

const VERDICTS = ['ready', 'installable', 'guided', 'partial', 'bundled', 'blocked'];
// The five verdicts of a whole project, in the words the interface uses.
const PROJECT_VERDICTS = ['ready', 'installable', 'guided', 'partial', 'blocked', 'unknown'];

function currentPlatform() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return { platform: process.platform, arch };
}

function normaliseAdapters(adapters) {
  if (adapters === null || adapters === undefined) return null;
  return new Set([...adapters].map((id) => String(id).toLowerCase()));
}

/**
 * @param {string} id runtime id
 * @param {{platform?: string, arch?: string, adapters?: Iterable<string>|null}} context
 */
function check(id, context = {}) {
  const item = catalog.runtime(id);
  if (!item) {
    return {
      id,
      label: id,
      support: 'none',
      verdict: 'blocked',
      installMode: 'none',
      requiresAdmin: false,
      requiresReboot: false,
      reason: `"${id}" is not in the installation catalog.`,
    };
  }

  const { platform, arch } = { ...currentPlatform(), ...context };
  const adapters = normaliseAdapters(context.adapters);
  const support = catalog.platformLevel(item, platform, arch);
  const hasAdapter = adapters === null || adapters.has(item.id);
  const base = {
    id: item.id,
    label: item.label,
    ecosystem: item.ecosystem,
    support,
    installMode: item.installMode,
    status: item.status,
    requiresAdmin: item.requiresAdmin,
    requiresReboot: item.requiresReboot,
    officialSource: item.officialSource,
    destination: item.destination,
    platform,
    arch,
    adapter: hasAdapter && item.installMode === 'managed',
  };

  if (support === 'none') {
    return {
      ...base,
      verdict: 'blocked',
      reason: `${item.label} has no official ${platform} ${arch} build, so this project cannot run here.`,
    };
  }

  if (support === 'partial') {
    return {
      ...base,
      verdict: 'partial',
      reason: `${item.label} has a partial ${platform} ${arch} build. Some projects may not work.`,
    };
  }

  if (item.installMode === 'bundled' || item.installMode === 'builtin') {
    return {
      ...base,
      verdict: 'bundled',
      reason: `${item.label} comes with ${(item.needs || []).join(', ') || 'its host tool'}.`,
    };
  }

  if (item.installMode === 'guided' || item.status === 'external') {
    return {
      ...base,
      verdict: 'guided',
      reason:
        item.reason ||
        `${item.label} has to be installed from the official page before this project can run.`,
    };
  }

  if (item.requiresAdmin) {
    return {
      ...base,
      verdict: 'guided',
      reason: `${item.label} needs administrator rights, and GUITinstal never asks for them by itself.`,
    };
  }

  if (!item.checksum?.published) {
    return {
      ...base,
      verdict: 'guided',
      reason: `${item.label} does not publish a checksum, so GUITinstal cannot verify what it downloads.`,
    };
  }

  if (!hasAdapter) {
    return {
      ...base,
      verdict: 'guided',
      reason: `${item.label} has no automated installer in this build yet. Install it from ${item.officialSource} and GUITinstal will pick it up.`,
    };
  }

  return {
    ...base,
    verdict: 'installable',
    reason: `GUITinstal can install ${item.label} on this machine and check what it downloads.`,
  };
}

/**
 * The compatibility of a whole stack.
 *
 * @param {string} stackId
 * @param {{platform?: string, arch?: string, available?: Iterable<string>, adapters?: Iterable<string>|null, packageManager?: string}} context
 */
function forStack(stackId, context = {}) {
  const { available = [], packageManager = '', ...rest } = context;
  const present = new Set([...available]);
  const definition = catalog.stack(stackId);
  if (!definition) {
    return {
      stack: stackId,
      known: false,
      verdict: 'blocked',
      runtimes: [],
      blockers: [`"${stackId}" is not a stack the engine knows.`],
    };
  }

  const ids = requirements.forStack(stackId, { packageManager });
  const runtimes = ids.map((id) => ({ ...check(id, rest), available: present.has(id) }));
  const blockers = runtimes.filter((item) => item.verdict === 'blocked');
  const partial = runtimes.filter((item) => item.verdict === 'partial');
  const guided = runtimes.filter((item) => item.verdict === 'guided' && !item.available);

  let verdict = 'supported';
  if (blockers.length) verdict = 'blocked';
  else if (partial.length) verdict = 'partial';
  else if (guided.length) verdict = 'guided';

  return {
    stack: stackId,
    label: definition.label,
    known: true,
    verdict,
    runtimes,
    blockers: blockers.map((item) => item.reason),
    warnings: [
      ...partial.map((item) => item.reason),
      ...guided.map((item) => item.reason),
    ],
  };
}

/**
 * The compatibility of one repository's requirements, as the plan builder and
 * the interface use it.
 *
 * Every runtime ends in exactly one state:
 *   ready     - it is on this machine
 *   prepare   - it is missing and an adapter in this build can install it
 *   guide     - it is missing and a human has to install it (official page attached)
 *   blocked   - it cannot work on this platform at all
 *
 * The project verdict follows from those states, so the plan can refuse a
 * blocked project instead of writing steps that are known to fail.
 */
function forProject(options = {}) {
  const context = { ...currentPlatform(), ...options };
  const adapters = normaliseAdapters(options.adapters);
  const stackId = String(options.stack || '');
  const definition = catalog.stack(stackId);
  const known = Boolean(definition);
  const ids = known
    ? requirements.forStack(stackId, { packageManager: options.packageManager || '' })
    : [...new Set(options.runtimes || [])];
  if (!ids.length) {
    return {
      stack: stackId,
      label: definition?.label || '',
      known,
      platform: context.platform,
      arch: context.arch,
      verdict: known ? 'ready' : 'unknown',
      summary: known
        ? `${definition.label} needs no runtime GUITinstal has to check.`
        : 'This repository has no manifest GUITinstal can read, so there is nothing to check.',
      runtimes: [],
      requirements: [],
      missing: [],
      prepare: [],
      guide: [],
      blocked: [],
      reasons: [],
    };
  }

  const reported = new Set((options.available || []).map((id) => String(id).toLowerCase()));
  const resolved = new Map();
  const isPresent = (id) => {
    if (resolved.has(id)) return resolved.get(id);
    resolved.set(id, false); // guards a dependency loop
    let value = reported.has(id);
    if (!value) {
      const item = catalog.runtime(id);
      if (item && (item.installMode === 'bundled' || item.installMode === 'builtin')) {
        value = (item.needs || []).every(isPresent);
      }
    }
    resolved.set(id, value);
    return value;
  };

  const runtimes = ids.map((id) => {
    const verdict = check(id, { platform: context.platform, arch: context.arch, adapters });
    const available = isPresent(id);
    let state = 'blocked';
    if (available) state = 'ready';
    else if (verdict.verdict === 'installable') state = 'prepare';
    else if (verdict.verdict === 'blocked') state = 'blocked';
    // A bundled runtime (npm, pip, venv, compose) is never a separate manual
    // step: its host is what has to be installed, and the host carries it.
    else if (verdict.verdict === 'bundled') state = 'bundled';
    else state = 'guide';
    return { ...verdict, available, state };
  });

  const blocked = runtimes.filter((item) => item.state === 'blocked');
  const partial = runtimes.filter((item) => !item.available && item.support === 'partial');
  const guide = runtimes.filter((item) => item.state === 'guide');
  const prepare = runtimes.filter((item) => item.state === 'prepare');
  const missing = runtimes.filter((item) => item.state !== 'ready' && item.state !== 'bundled');

  let verdict = 'ready';
  if (blocked.length) verdict = 'blocked';
  else if (partial.length) verdict = 'partial';
  else if (guide.length) verdict = 'guided';
  else if (prepare.length) verdict = 'installable';

  const reasons = [
    ...blocked.map((item) => item.reason),
    ...partial.map((item) => item.reason),
    ...guide.map((item) => `${item.label}: ${item.reason} Official page: ${item.officialSource}`),
  ];

  return {
    stack: stackId,
    label: definition?.label || '',
    known,
    platform: context.platform,
    arch: context.arch,
    verdict,
    summary: summarise({ verdict, definition, runtimes, prepare, guide, blocked, missing }),
    runtimes,
    requirements: ids,
    missing: missing.map((item) => item.id),
    prepare: prepare.map((item) => item.id),
    guide: guide.map((item) => ({
      id: item.id,
      label: item.label,
      url: item.officialSource,
      reason: item.reason,
    })),
    blocked: blocked.map((item) => ({ id: item.id, label: item.label, reason: item.reason })),
    reasons,
  };
}

function summarise({ verdict, definition, runtimes, prepare, guide, blocked, missing }) {
  const label = definition?.label || 'This project';
  if (verdict === 'blocked') {
    return `${label} cannot be installed on this machine: ${blocked.map((item) => item.label).join(', ')} ${
      blocked.length === 1 ? 'has' : 'have'
    } no build for this operating system.`;
  }
  if (verdict === 'partial') {
    return `${label} can only be partly installed on this machine: ${runtimes
      .filter((item) => !item.available && item.support === 'partial')
      .map((item) => item.label)
      .join(', ')} ships an incomplete build for this processor.`;
  }
  if (verdict === 'guided') {
    return `${label} needs a manual step before it can run: ${guide
      .map((item) => item.label)
      .join(', ')} must be installed from the official page.`;
  }
  if (verdict === 'installable') {
    return `${label} is ready to install: GUITinstal prepares ${prepare
      .map((item) => item.label)
      .join(', ')} from the official source and verifies the download.`;
  }
  return missing.length
    ? `${label} needs ${missing.map((item) => item.label).join(', ')}, which is not ready yet.`
    : `Everything ${label} needs is already on this machine.`;
}

/** How the whole catalog looks on one platform. */
function forCatalog(context = {}) {
  const { platform, arch } = { ...currentPlatform(), ...context };
  const adapters = normaliseAdapters(context.adapters);
  const runtimes = catalog.runtimes().map((item) => check(item.id, { platform, arch, adapters }));
  const count = (verdict) => runtimes.filter((item) => item.verdict === verdict).length;
  return {
    platform,
    arch,
    total: runtimes.length,
    installable: count('installable'),
    guided: count('guided'),
    bundled: count('bundled'),
    partial: count('partial'),
    blocked: count('blocked'),
    runtimes,
  };
}

module.exports = {
  PROJECT_VERDICTS,
  VERDICTS,
  check,
  currentPlatform,
  forCatalog,
  forProject,
  forStack,
};
