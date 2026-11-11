'use strict';

const catalog = require('./catalog');

/**
 * Turns a detected stack into the list of runtimes that must exist before the
 * project can be installed, and puts them in the order they have to appear.
 *
 * The order matters: Composer needs PHP, Maven needs a JDK, Cargo needs
 * rustup. A plan that asks for Composer before PHP fails in a way that looks
 * like a broken project instead of a missing runtime.
 */

/**
 * The runtimes a stack needs, dependencies included, in installation order.
 *
 * A package manager is an alternative, not a requirement: a project needs
 * npm, or pnpm, or yarn, according to the lockfile it ships. Only the one the
 * project actually uses is added, so a Node project is never told to install
 * three package managers at once.
 *
 * @param {string} stackId
 * @param {{packageManager?: string}} options the package manager the project uses
 */
function forStack(stackId, options = {}) {
  const definition = catalog.stack(stackId);
  if (!definition) return [];
  const extra = options.packageManager ? [options.packageManager] : [];
  return expand(definition.runtimes || [], extra);
}

/**
 * Adds the dependencies of every runtime, depth first, so a dependency always
 * lands before the tool that needs it.
 */
function expand(ids, extra = []) {
  const ordered = [];
  const seen = new Set();

  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const item = catalog.runtime(id);
    if (!item) return;
    for (const need of item.needs || []) visit(need);
    ordered.push(id);
  };

  for (const id of ids) visit(id);
  for (const id of extra) visit(id);
  return ordered;
}

/** A runtime as the engine describes it to the rest of the app. */
function describe(id) {
  const item = catalog.runtime(id);
  if (!item) return null;
  return {
    id: item.id,
    label: item.label,
    ecosystem: item.ecosystem,
    summary: item.summary,
    installMode: item.installMode,
    status: item.status,
    officialSource: item.officialSource,
    requiresAdmin: item.requiresAdmin,
    requiresReboot: item.requiresReboot,
    reason: item.reason || '',
  };
}

/**
 * The requirements of a stack, each one annotated with whether it is already
 * on this machine.
 *
 * @param {string} stackId
 * @param {Iterable<string>} available ids of the runtimes this machine has
 * @param {{packageManager?: string}} options the package manager the project uses
 */
function resolve(stackId, available = [], options = {}) {
  const present = new Set([...available]);
  const definition = catalog.stack(stackId);
  if (!definition) {
    return { stack: stackId, known: false, requirements: [], missing: [], packageManagers: [] };
  }

  const ids = forStack(stackId, options);
  const requirements = ids.map((id) => {
    const info = describe(id);
    return {
      ...info,
      available: present.has(id),
      // A runtime the app can install by itself becomes a plan step; a guided
      // one stays an instruction with the official page attached.
      action: present.has(id) ? 'ready' : info.installMode === 'managed' ? 'prepare' : 'guide',
    };
  });

  return {
    stack: stackId,
    label: definition.label,
    known: true,
    packageManager: options.packageManager || '',
    packageManagers: definition.packageManagers || [],
    requirements,
    missing: requirements.filter((item) => !item.available).map((item) => item.id),
    prepare: requirements.filter((item) => item.action === 'prepare').map((item) => item.id),
    guide: requirements.filter((item) => item.action === 'guide').map((item) => item.id),
  };
}

module.exports = { describe, expand, forStack, resolve };
