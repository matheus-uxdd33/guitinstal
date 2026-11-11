'use strict';

/**
 * Installation matrix: drives the real analyze -> plan -> approve -> execute
 * flow over a list of repositories and reports what actually happened on this
 * machine, step by step.
 *
 *   node server/main.js
 *   node tools/install-matrix.js
 *   node tools/install-matrix.js pypa/sampleproject
 *   node tools/install-matrix.js --deadline 600 --json report.json
 *
 * Launch steps are skipped: this matrix measures installation, and a project
 * dev server would keep running and hold a port.
 */

const fs = require('node:fs');

const { runtimeFile } = require('../core/paths');
const { detectPrompt } = require('../core/prompts');

const DEFAULT_REPOS = [
  { repo: 'pypa/sampleproject', label: 'Python, clean project' },
  { repo: 'pallets/flask', label: 'Python, web framework' },
  { repo: 'sindresorhus/is', label: 'Node, first install' },
  { repo: 'sindresorhus/is', label: 'Node, re-install on dirty tree' },
  { repo: 'expressjs/express', label: 'Node, large dependency tree' },
  { repo: 'charmbracelet/glamour', label: 'Go module' },
  { repo: 'laravel/laravel', label: 'PHP, composer absent here' },
  { repo: 'BurntSushi/ripgrep', label: 'Rust, cargo absent here' },
  { repo: 'docker/awesome-compose', label: 'Compose files, no root manifest' },
  { repo: 'octocat/Hello-World', label: 'No manifest at all' },
];

/**
 * A prompt is classified with the same rule the app uses (core/prompts), so
 * the matrix measures the product instead of inventing its own guess.
 */

function parseArgs(argv) {
  const options = { deadline: 420, json: '', answer: null, repos: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--deadline') options.deadline = Number(argv[++i]) || options.deadline;
    else if (arg === '--json') options.json = argv[++i] || '';
    else if (arg === '--answer') options.answer = argv[++i] ?? '';
    else if (!arg.startsWith('--')) options.repos.push(arg);
  }
  if (!options.repos.length) {
    options.repos = DEFAULT_REPOS.map((item) => ({ ...item }));
  } else {
    options.repos = options.repos.map((repo) => ({ repo, label: 'given on the command line' }));
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(), 'utf8'));
  } catch {
    throw new Error('GUITinstal is not running. Start it with "node server/main.js" first.');
  }
}

async function call(base, token, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'X-Guit-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${method} ${route} -> ${response.status}`);
  return payload;
}

function classifyOutput(lines) {
  const text = lines.join('\n');
  const interactive = Boolean(detectPrompt(lines));
  const missingTool = /ENOENT|not recognized|was not found|No such file or directory|is not installed/i.test(text);
  const network = /could not resolve|Failed to fetch|ETIMEDOUT|network|Connection refused/i.test(text);
  return { interactive, missingTool, network };
}

function interestingLines(step) {
  const lines = (step.output || []).map((line) => line.text);
  const tail = lines.slice(-6);
  const prompt = lines.filter((line) => detectPrompt([line])).slice(0, 3);
  return [...new Set([...prompt, ...tail])];
}

async function driveRun(base, token, planId, { deadlineMs, answer, log }) {
  let run = await call(base, token, '/api/runs', { method: 'POST', body: { planId } });
  const trail = [];
  const seen = new Set();
  const prompts = [];
  let stoppedAtPrompt = false;
  const stop = Date.now() + deadlineMs;

  while (Date.now() < stop) {
    for (const step of run.steps) {
      const key = `${step.id}:${step.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (step.status !== 'pending') {
        trail.push({ id: step.id, status: step.status, exitCode: step.exitCode, error: step.error });
        log(`      [${step.status}] ${step.id} :: ${step.command}`);
        if (step.error) log(`              ${String(step.error).split('\n')[0]}`);
      }
    }

    if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') break;

    // The step asked a question. Either answer it the way a user would, or
    // stop the run: with a real stdin the command waits forever otherwise.
    const asking = run.steps.find((step) => step.awaitingInput);
    if (asking) {
      prompts.push(asking.prompt);
      log(`      [prompt] ${asking.id} asks: ${asking.prompt}`);
      if (answer === null) {
        stoppedAtPrompt = true;
        run = await call(base, token, `/api/runs/${run.id}/cancel`, { method: 'POST', body: {} });
        break;
      }
      run = await call(base, token, `/api/runs/${run.id}/input`, { method: 'POST', body: { text: answer } });
      continue;
    }

    const current = run.steps.find((step) => step.status === 'awaiting-approval');
    if (current) {
      if (current.id === 'launch') {
        log('      [skip] launch (the matrix does not start dev servers)');
        run = await call(base, token, `/api/runs/${run.id}/skip`, { method: 'POST', body: { stepId: current.id } });
      } else {
        run = await call(base, token, `/api/runs/${run.id}/approve`, { method: 'POST', body: { stepId: current.id } });
      }
      continue;
    }

    await sleep(500);
    run = await call(base, token, `/api/runs/${run.id}`);
  }

  const timedOut = run.status !== 'done' && run.status !== 'failed' && run.status !== 'cancelled';
  if (timedOut) {
    try {
      await call(base, token, `/api/runs/${run.id}/cancel`, { method: 'POST', body: {} });
    } catch {
      /* the run may already be over */
    }
  }

  // The library entry is written by a listener that fires after the run reports
  // done, so a single read of the state always loses the race. Wait for the
  // async result: it is what tells an installed project from a registered one.
  if (run.status === 'done') {
    const grace = Date.now() + 10000;
    while (Date.now() < grace) {
      if (run.library && (run.library.ok === true || run.library.error)) break;
      await sleep(300);
      run = await call(base, token, `/api/runs/${run.id}`);
    }
  }

  return { run, trail, timedOut, prompts, stoppedAtPrompt };
}

async function testRepo(base, token, entry, options, log) {
  const { deadline: deadlineMs, answer } = options;
  const record = {
    repo: entry.repo,
    label: entry.label,
    result: 'fail',
    stack: '',
    confidence: '',
    steps: [],
    failure: '',
    category: '',
    evidence: [],
    warnings: [],
    prompts: [],
    library: null,
    durationMs: 0,
    registered: false,
  };
  const started = Date.now();
  log(`\n=== ${entry.repo} — ${entry.label}`);

  let analysis;
  try {
    analysis = await call(base, token, '/api/analyze', { method: 'POST', body: { url: entry.repo } });
  } catch (error) {
    record.failure = `analyze: ${error.message}`;
    record.category = 'analyze-error';
    record.durationMs = Date.now() - started;
    log(`      analyze failed: ${error.message}`);
    return record;
  }

  record.stack = analysis.plan.stack.label;
  record.kind = analysis.plan.kind;
  record.confidence = analysis.plan.stack.confidence;
  record.warnings = analysis.plan.preflight?.warnings || [];
  log(`      plan: ${analysis.plan.steps.map((step) => step.id).join(' > ')}`);
  for (const warning of record.warnings) log(`      note: ${warning}`);

  const { run, trail, timedOut, prompts, stoppedAtPrompt } = await driveRun(base, token, analysis.planId, {
    deadlineMs: deadlineMs * 1000,
    answer,
    log,
  });
  record.steps = trail;
  record.prompts = prompts;
  record.durationMs = Date.now() - started;
  record.result = run.status;
  record.library = run.library || null;

  if (stoppedAtPrompt) {
    record.category = 'needs-a-terminal';
    record.result = 'prompt-blocked';
    record.failure = `stopped on the question "${prompts[0]}" and cancelled instead of answering`;
    record.evidence = prompts.slice(0, 4);
    return record;
  }

  if (timedOut) {
    record.category = 'timeout';
    record.failure = `no terminal state within ${deadlineMs}s`;
    return record;
  }

  if (run.status === 'done') {
    const state = await call(base, token, '/api/state');
    record.registered = state.projects.some((item) => item.fullName === analysis.repo.fullName);
    if (record.library && record.library.ok === false) {
      record.category = 'library-write-failed';
      record.failure = `installed on disk but the library entry failed: ${record.library.error}`;
      record.evidence = [String(record.library.error), `attempts ${record.library.attempts}`];
    }
    return record;
  }

  const failedStep = run.steps.find((step) => step.status === 'failed');
  if (failedStep) {
    const lines = interestingLines(failedStep);
    const kind = classifyOutput([...lines, String(failedStep.error || '')]);
    record.failure = `${failedStep.id} -> ${String(failedStep.error || '').split('\n')[0]} (exit ${failedStep.exitCode})`;
    record.category = kind.interactive
      ? 'needs-a-terminal'
      : kind.missingTool
        ? 'missing-runtime'
        : kind.network
          ? 'network'
          : 'command-failed';
    record.evidence = lines.slice(0, 8);
  } else {
    record.category = 'unknown';
    record.failure = `run ended as ${run.status} without a failed step`;
  }
  return record;
}

function summary(records) {
  const count = (test) => records.filter(test).length;
  return [
    `done ${count((item) => item.result === 'done')}`,
    `failed ${count((item) => item.result === 'failed')}`,
    `prompt-blocked ${count((item) => item.result === 'prompt-blocked')}`,
    `timeout ${count((item) => item.category === 'timeout')}`,
    `answered prompts ${records.reduce((total, item) => total + item.prompts.length, 0)}`,
    `registered ${count((item) => item.registered)}`,
    `library writes failed ${count((item) => item.library && item.library.ok === false)}`,
  ].join(' | ');
}

function table(records) {
  const rows = records.map((item) => ({
    repo: item.repo,
    stack: item.stack || '-',
    result: item.result,
    category: item.category || '-',
    prompts: item.prompts.length,
    steps: item.steps.map((step) => `${step.id}:${step.status}`).join(' '),
    seconds: Math.round(item.durationMs / 1000),
    library: item.library ? `${item.library.ok ? 'ok' : 'FAILED'}:${item.library.attempts}${item.library.error ? ` ${item.library.error}` : ''}` : '-',
    registered: item.registered ? 'yes' : 'no',
  }));
  const headers = Object.keys(rows[0] || {});
  const widths = headers.map((key) => Math.max(key.length, ...rows.map((row) => String(row[key]).length)));
  const line = (values) => values.map((value, index) => String(value).padEnd(widths[index])).join('  ').trimEnd();
  const dashes = line(widths.map((width) => '-'.repeat(width)));
  return [line(headers), dashes, ...rows.map((row) => line(headers.map((key) => row[key])))].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { url: base, token } = runtime();
  const state = await call(base, token, '/api/state');
  console.log(`Server    : ${base}`);
  console.log(`Workspace : ${state.workspace}`);
  console.log(`Runtimes  : ${state.runtimes.filter((item) => item.available).map((item) => item.id).join(', ')}`);
  console.log(`Repos     : ${options.repos.length}, ${options.deadline}s each`);
  console.log(`Prompts   : ${options.answer === null ? 'no answer (cancel the run)' : `auto-answer "${options.answer}"`}`);

  const records = [];
  for (const entry of options.repos) {
    const record = await testRepo(base, token, entry, options, (text) => console.log(text));
    records.push(record);
    for (const line of record.evidence) console.log(`              | ${line}`);
  }

  console.log(`\n${table(records)}`);
  console.log(`\nTotal: ${summary(records)}`);

  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify({ workspace: state.workspace, generatedAt: new Date().toISOString(), records }, null, 2));
    console.log(`Report written to ${options.json}`);
  }

  // Only touch projects that live in this workspace, so a registry entry from
  // another folder is never unregistered by a matrix run.
  const registered = await call(base, token, '/api/state');
  const tested = new Set(records.map((item) => item.repo.toLowerCase()));
  const leftovers = registered.projects.filter(
    (item) => item.workspace === state.workspace && tested.has(`${item.owner}/${item.repo}`.toLowerCase())
  );
  for (const item of leftovers) {
    await call(base, token, `/api/projects/${item.id}`, { method: 'DELETE' });
    console.log(`Unregistered ${item.fullName}`);
  }

  const hardFailures = records.filter((item) => item.result !== 'done').length;
  process.exit(hardFailures ? 2 : 0);
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});
