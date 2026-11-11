'use strict';

/**
 * Audit harness: runs the real analyzer against a list of repositories and
 * prints what the installer would actually do. Read-only: nothing executes.
 *
 *   node server/main.js        (in one terminal)
 *   node tools/audit-plans.js   (in another)
 */

const fs = require('node:fs');

const { runtimeFile } = require('../core/paths');

const REPOS = [
  'sindresorhus/is',
  'octocat/Hello-World',
  'pallets/flask',
  'docker/awesome-compose',
  'go-gitea/gitea',
  'supabase/supabase',
  'cli/cli',
  'home-assistant/core',
];

const LINE = '-'.repeat(70);

function runtime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(), 'utf8'));
  } catch {
    throw new Error('GUITinstal nao esta em execucao. Rode "node server/main.js" primeiro.');
  }
}

async function analyze({ url, token }, repo) {
  const response = await fetch(`${url}/api/analyze`, {
    method: 'POST',
    headers: { 'X-Guit-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: repo }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${repo} -> ${response.status}`);
  return payload;
}

async function main() {
  const rt = runtime();
  const state = await (await fetch(`${rt.url}/api/state`, { headers: { 'X-Guit-Token': rt.token } })).json();
  const missing = state.runtimes.filter((r) => !r.available).map((r) => r.id);
  console.log(`Ausentes nesta maquina: ${missing.join(', ') || 'nenhum'}\n`);

  for (const repo of REPOS) {
    console.log(LINE);
    try {
      const a = await analyze(rt, repo);
      const plan = a.plan;
      const launch = plan.steps.find((s) => s.id === 'launch');
      console.log(`${repo}  [${a.repo.language || '-'}${a.detection.truncated ? ' | TRUNCATED' : ''}]`);
      console.log(`  stack        : ${plan.stack.id} (${plan.stack.confidence}) ${plan.stack.markers.join(', ')}`);
      console.log(`  steps        : ${plan.steps.map((s) => s.id).join(' > ')}`);
      console.log(`  launch cmd   : ${launch ? launch.command : 'NONE'}`);
      console.log(`  requires     : ${plan.requiredRuntimes.join(', ')}`);
      console.log(`  missing here : ${plan.requiredRuntimes.filter((id) => missing.includes(id)).join(', ') || '-'}`);
      console.log(`  dir          : ${plan.directory}`);
      console.log(`  files seen   : ${a.detection.fileCount}`);
    } catch (error) {
      console.log(`${repo}  ERRO: ${error.message}`);
    }
  }
  console.log(LINE);
}

main().catch((error) => {
  console.error(`ERRO: ${error.message}`);
  process.exit(1);
});
