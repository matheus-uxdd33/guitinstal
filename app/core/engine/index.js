'use strict';

/**
 * GUITinstal Universal Engine.
 *
 * This is the configuration layer of the engine: the runtime catalog, the
 * requirements of each stack, the project categories, the compatibility rules,
 * the sixteen step workflow and the policies that hold the app to its promise.
 *
 * Nothing here changes how the app installs anything. It is the map of what
 * the engine is meant to be, kept next to the code so the two can be compared.
 * The comparison is the point: every entry that says "planned" is a promise
 * the code has not kept yet.
 */

const catalog = require('./catalog');
const compatibility = require('./compatibility');
const policy = require('./policy');
const projectType = require('./project-type');
const requirements = require('./requirements');
const workflow = require('./workflow');

/** The whole configuration, as one object. */
function config() {
  return {
    engine: catalog.engine(),
    ecosystems: catalog.ecosystems(),
    catalog: catalog.runtimes(),
    stacks: catalog.stacks(),
    projectTypes: projectType.TYPES,
    workflow: workflow.steps(),
    modules: workflow.modules(),
    policy: {
      security: policy.security(),
      resources: policy.resources(),
      platforms: policy.platforms(),
    },
    digest: catalog.digest(),
  };
}

/** How far along the engine is, counted from the catalog and the workflow. */
function summary() {
  const runtimes = catalog.runtimes();
  const count = (list, key, value) => list.filter((item) => item[key] === value).length;

  const modules = workflow.modules();
  const steps = workflow.steps();

  return {
    engine: catalog.engine().name,
    version: catalog.engine().specVersion,
    digest: catalog.digest(),
    runtimes: {
      total: runtimes.length,
      implemented: count(runtimes, 'status', 'implemented'),
      catalogued: count(runtimes, 'status', 'catalogued'),
      external: count(runtimes, 'status', 'external'),
      managed: count(runtimes, 'installMode', 'managed'),
      guided: count(runtimes, 'installMode', 'guided'),
      bundled: count(runtimes, 'installMode', 'bundled'),
      builtin: count(runtimes, 'installMode', 'builtin'),
    },
    workflow: {
      total: steps.length,
      implemented: count(steps, 'status', 'implemented'),
      partial: count(steps, 'status', 'partial'),
      planned: count(steps, 'status', 'planned'),
      gaps: workflow.gaps(),
    },
    modules: {
      total: modules.length,
      implemented: count(modules, 'status', 'implemented'),
      partial: count(modules, 'status', 'partial'),
      planned: count(modules, 'status', 'planned'),
    },
    projectTypes: Object.keys(projectType.TYPES).filter((id) => id !== 'unknown').length,
    security: {
      total: policy.security().length,
      implemented: count(policy.security(), 'status', 'implemented'),
      open: policy.openRules().length,
    },
  };
}

/**
 * What this machine can do right now.
 *
 * The catalog says what is possible in general. This says what is possible
 * here, with the tools that are actually installed.
 */
async function capabilities() {
  const { runtimeStatus } = require('../tools');
  const { supportedIds } = require('../runtime-install');

  const status = await runtimeStatus();
  const available = status.filter((item) => item.available).map((item) => item.id);
  const managed = supportedIds();
  const context = compatibility.currentPlatform();

  return {
    platform: context.platform,
    arch: context.arch,
    available,
    missing: status.filter((item) => !item.available).map((item) => item.id),
    managed,
    installableHere: catalog.managedOn(context.platform, context.arch).map((item) => item.id),
    guidedHere: catalog.guidedOn(context.platform, context.arch).map((item) => item.id),
    compatibility: compatibility.forCatalog(context),
  };
}

/**
 * Checks the catalog against itself.
 *
 * @returns {{ok: boolean, problems: Array<object>}}
 */
function validate() {
  return catalog.validate();
}

/**
 * Checks the catalog against the running application.
 *
 * A runtime the app installs but the catalog does not know is a hole in the
 * configuration. A catalog entry the app cannot install is a promise it has
 * not kept. Both are worth saying out loud.
 */
async function validateLive() {
  const result = catalog.validate();
  const problems = [...result.problems];

  const { supportedIds } = require('../runtime-install');
  const { runtimeStatus } = require('../tools');

  const managed = supportedIds();
  const status = await runtimeStatus();

  for (const id of managed) {
    if (!catalog.runtime(id)) {
      problems.push({
        level: 'error',
        id,
        message: 'the app can install this runtime but the catalog does not know it',
      });
      continue;
    }
    const item = catalog.runtime(id);
    if (item.status !== 'implemented') {
      problems.push({
        level: 'error',
        id,
        message: `the app can install it, but the catalog says "${item.status}"`,
      });
    }
  }

  for (const runtime of status) {
    if (!catalog.runtime(runtime.id)) {
      problems.push({
        level: 'warning',
        id: runtime.id,
        message: 'the app probes this runtime but the catalog does not know it',
      });
    }
  }

  const errors = problems.filter((item) => item.level === 'error');
  return { ok: errors.length === 0, problems };
}

module.exports = {
  capabilities,
  catalog,
  compatibility,
  config,
  policy,
  projectType,
  requirements,
  summary,
  validate,
  validateLive,
  workflow,
};
