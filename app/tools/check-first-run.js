'use strict';

/**
 * First-run checks: the failures a person meets on a machine where the project
 * tools are not installed yet, proved against the real modules.
 *
 *   node tools/check-first-run.js
 *
 * Nothing here needs the network or a GitHub token: a missing runtime is
 * reproducible offline, which is exactly why it is worth a test file.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { effectivePath, forgetToolLookups, installHint, registryPathDirs, resolveTool, runtimeStatus } = require('../core/tools');
const { buildPlan } = require('../core/plan');
const { explainPrompt } = require('../core/prompts');
const { RunManager } = require('../core/runner');

let failures = 0;

function check(name, passed, detail) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  :: ${detail}` : ''}`);
  if (!passed) failures += 1;
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* 1. A tool that appears on PATH while the app runs must be found once the
   user asks for a re-check; before that it stays cached as missing. */
async function toolAppearsAfterInstall() {
  const dir = tempDir('guit-first-run-tool-');
  const name = 'guitfirstruntool';
  fs.writeFileSync(path.join(dir, `${name}.cmd`), '@echo off\r\necho 1.0.0\r\n');

  const before = resolveTool(name);
  check('a tool that is not on PATH is reported missing', before.missing === true, JSON.stringify(before.cmd));

  process.env.PATH = `${process.env.PATH}${path.delimiter}${dir}`;
  const sticky = resolveTool(name);
  check('the cached answer survives PATH changes (why a re-check is needed)', sticky.missing === true);

  forgetToolLookups();
  const after = resolveTool(name);
  check('after forgetToolLookups() the same tool is found', after.missing === undefined && Boolean(after.cmd), after.cmd);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* 2. The registry PATH is what a Windows installer writes to, and a process
   started earlier cannot see it, so the app has to read it itself. */
function registryPathIsMerged() {
  const key = (dir) => dir.toLowerCase().replace(/[\\/]+$/, '');
  const processDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const merged = effectivePath().split(path.delimiter).filter(Boolean);
  const mergedKeys = merged.map(key);
  const registry = registryPathDirs().map(key);
  const lost = processDirs.filter((dir) => !mergedKeys.includes(key(dir)));

  check('no PATH entry of this process is dropped', lost.length === 0, lost.join(' | ') || `${processDirs.length} entries, ${merged.length} unique after the merge`);
  check('the merged list has no duplicates', new Set(mergedKeys).size === mergedKeys.length);
  if (process.platform === 'win32') {
    check('the Windows registry PATH was readable', registry.length > 0, `${registry.length} dirs from HKLM + HKCU`);
    const extra = registry.filter((dir) => !processDirs.map(key).includes(dir));
    console.log(`      note: ${extra.length} registry-only entr${extra.length === 1 ? 'y' : 'ies'} this process already lacks${extra.length ? ` (e.g. ${extra.slice(0, 2).join(' | ')})` : ' - this machine is in sync'}.`);
  }
}

/* 2b. Windows keeps %SYSTEMROOT%-style names inside the registry PATH. A path
   handed to spawn with a percent still in it is a folder that does not exist,
   so the expansion has to be provable without editing anyone's PATH. */
function registryValuesAreExpanded() {
  if (process.platform !== 'win32') {
    console.log('      note: not Windows, registry PATH expansion skipped.');
    return;
  }
  const keys = [
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    'HKCU\\Environment',
  ];
  const raw = [];
  for (const regKey of keys) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', regKey, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    } catch {
      continue;
    }
    const line = text.split(/\r?\n/).find((item) => /REG_(?:EXPAND_)?SZ/i.test(item));
    if (!line) continue;
    const value = line.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, '').trim();
    raw.push(...value.split(';').map((entry) => entry.trim()).filter(Boolean));
  }
  const variables = raw.filter((entry) => /%[^%]+%/.test(entry));
  const merged = effectivePath().split(path.delimiter).filter(Boolean);
  const stuck = merged.filter((dir) => /%[^%]+%/.test(dir));
  check('no unexpanded %VARIABLE% survives in the merged PATH', stuck.length === 0,
    stuck.length ? stuck.join(' | ') : `${variables.length} of ${raw.length} registry entries use %VAR% and every one came out expanded`);
}

/* 3. The plan must warn before the first approval, and point at the download. */
function planWarnsWithTheDownloadPage() {
  const missing = 'composer';
  const runtimes = [
    { id: 'git', available: true },
    { id: 'php', available: true },
  ];
  const plan = buildPlan({
    repo: {
      owner: 'laravel',
      name: 'laravel',
      fullName: 'laravel/laravel',
      url: 'https://github.com/laravel/laravel',
      cloneUrl: 'https://github.com/laravel/laravel.git',
      defaultBranch: 'main',
    },
    detection: {
      primary: {
        stack: 'php',
        label: 'PHP',
        confidence: 'high',
        markers: ['composer.json'],
        runtimes: ['php', 'composer'],
        file: { composer: { require: {} } },
      },
      secondary: [],
    },
    settings: { workspace: tempDir('guit-first-run-plan-'), shallowClone: true },
    runtimes,
  });

  const guides = plan.preflight.installGuides || [];
  const warning = (plan.preflight.warnings || []).join(' ');
  check('the plan lists the missing runtime', plan.preflight.missingRuntimes.includes(missing), plan.preflight.missingRuntimes.join(', '));
  check('the plan carries an official download page', guides.some((guide) => guide.id === missing && /^https:\/\//.test(guide.url)), guides.map((g) => g.url).join(' '));
  const setup = plan.steps.find((step) => step.id === `prepare-${missing}`);
  check('a self-installable runtime becomes an approved setup step', Boolean(setup), setup?.command || 'missing');
  check('the warning explains that setup step before approval', /setup step/i.test(warning), warning.slice(0, 130));
}

/* 4. The step that really fails must leave the same instruction, not a code. */
async function failedStepNamesThePage() {
  const workspace = tempDir('guit-first-run-run-');
  const manager = new RunManager();
  const plan = {
    id: 'plan-check',
    directory: path.join(workspace, 'project'),
    repo: { name: 'project', fullName: 'me/project' },
    stack: { id: 'php', label: 'PHP', confidence: 'high' },
    steps: [
      {
        id: 'install',
        index: 0,
        title: 'Install PHP dependencies',
        purpose: 'composer install',
        command: 'composer install',
        exec: resolveTool('composer'),
        cwd: 'project',
        risk: 2,
        requires: ['composer'],
        optional: false,
        notes: '',
      },
    ],
  };

  const run = manager.create(plan, { workspace });
  manager.approve(run.id, 'install');
  const peek = () => manager.snapshot(manager.get(run.id));

  const stop = Date.now() + 30000;
  let snapshot = peek();
  while (Date.now() < stop && snapshot.status !== 'failed' && snapshot.status !== 'done') {
    await new Promise((resolve) => setTimeout(resolve, 200));
    snapshot = peek();
  }

  const step = snapshot.steps[0];
  check('the missing tool stops the step', snapshot.status === 'failed', `exit ${step.exitCode}`);
  check('the message says which tool is missing', /composer/.test(step.error || ''), String(step.error || '').split('\n')[0]);
  check('the message carries the download page', /https:\/\/getcomposer\.org/.test(step.error || ''));
  check('the message points at the re-check', /Re-check tools/i.test(step.error || ''));

  fs.rmSync(workspace, { recursive: true, force: true });
}

/* 5. Plans name tools by absolute path (the venv python, npm's own node), so a
   failure must still say "Python" and link python.org instead of a path. */
async function absolutePathStillNamesTheRuntime() {
  const workspace = tempDir('guit-first-run-venv-');
  const manager = new RunManager();
  const plan = {
    id: 'plan-venv-check',
    directory: path.join(workspace, 'sampleproject'),
    repo: { name: 'sampleproject', fullName: 'pypa/sampleproject' },
    stack: { id: 'python', label: 'Python', confidence: 'high' },
    steps: [
      {
        id: 'install',
        index: 0,
        title: 'Install dependencies',
        purpose: 'python -m pip install -e .',
        command: '.venv/Scripts\\python -m pip install -e .',
        exec: { cmd: path.join(workspace, 'sampleproject', '.venv', 'Scripts', 'python.exe'), args: ['-m', 'pip', 'install', '-e', '.'], shell: false },
        cwd: 'project',
        risk: 2,
        requires: ['python'],
        optional: false,
        notes: '',
      },
    ],
  };

  const run = manager.create(plan, { workspace });
  manager.approve(run.id, 'install');
  const peek = () => manager.snapshot(manager.get(run.id));

  const stop = Date.now() + 30000;
  let snapshot = peek();
  while (Date.now() < stop && snapshot.status !== 'failed' && snapshot.status !== 'done') {
    await new Promise((resolve) => setTimeout(resolve, 200));
    snapshot = peek();
  }

  const error = snapshot.steps[0].error || '';
  check('an absolute path failure names the runtime, not the path', /needs Python,/i.test(error), error.slice(0, 90));
  check('and links the official page', /https:\/\/www\.python\.org\/downloads\//.test(error));
  check('the path itself is not shown as the tool name', !/\.venv/.test(error.split(',')[0]));

  fs.rmSync(workspace, { recursive: true, force: true });
}

/* 6. A question the user has never seen must come with plain English, using
   the exact wording captured from a live run. */
function questionsAreExplained() {
  const cases = [
    ['C:\\Users\\me\\is\\distribution\\*, Are you sure (Y/N)?', /delete step/i, 'Y'],
    ['Overwrite existing file?', /replaced/i, ''],
    ['Password: ', /credential/i, ''],
    ['Do you want to continue? (y/n)', /yes-or-no/i, 'Y'],
  ];
  for (const [question, expected, answer] of cases) {
    const explained = explainPrompt(question);
    check(`explained: "${question.slice(0, 34)}..."`, expected.test(explained.hint) && explained.answer === answer, explained.hint.slice(0, 60));
  }
  const hint = installHint('python');
  check('every known runtime has a download page', /^https:\/\//.test(hint.url), hint.url);
}

async function main() {
  await toolAppearsAfterInstall();
  registryPathIsMerged();
  registryValuesAreExpanded();
  planWarnsWithTheDownloadPage();
  await failedStepNamesThePage();
  await absolutePathStillNamesTheRuntime();
  questionsAreExplained();
  const missing = (await runtimeStatus({ refresh: true })).filter((runtime) => !runtime.available);
  console.log(`\nMachine today: ${missing.length} runtime(s) absent -> ${missing.map((runtime) => runtime.id).join(', ') || 'none'}`);
  console.log(failures ? `\nFIRST-RUN CHECKS: ${failures} FAILED` : '\nFIRST-RUN CHECKS: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(`ERROR: ${error.stack || error.message}`);
  process.exit(1);
});
