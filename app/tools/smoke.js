'use strict';

/**
 * Smoke test: exercises the real flow end to end against a running server.
 *
 *   node server/main.js          (in one terminal)
 *   node tools/smoke.js          (in another)
 *
 * Optional argument: the repository to install (default: sindresorhus/is).
 */

const fs = require('node:fs');
const path = require('node:path');

const { runtimeFile } = require('../core/paths');

const REPO = process.argv[2] || 'sindresorhus/is';

function runtime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(), 'utf8'));
  } catch {
    throw new Error('GUITinstal nao esta em execucao. Rode "node server/main.js" primeiro.');
  }
}

async function call(base, token, route, { method = 'GET', body, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { 'X-Guit-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `${method} ${route} -> ${response.status}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(300);
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { url, token } = runtime();
  console.log(`Servidor : ${url}`);
  console.log(`Repositorio: ${REPO}\n`);

  const state = await call(url, token, '/api/state');
  console.log(`Workspace: ${state.workspace}`);
  console.log(`Runtimes : ${state.runtimes.filter((r) => r.available).map((r) => r.id).join(', ')}`);

  console.log('\n[1/4] analisando repositorio...');
  const analysis = await call(url, token, '/api/analyze', { method: 'POST', body: { url: REPO } });
  console.log(`      ${analysis.repo.fullName} -> ${analysis.plan.stack.label}`);
  console.log(`      plano: ${analysis.plan.steps.map((step) => step.id).join(' > ')}`);

  console.log('\n[2/4] iniciando execucao...');
  let run = await call(url, token, '/api/runs', { method: 'POST', body: { planId: analysis.planId } });

  console.log('\n[3/4] aprovando e executando cada passo:');
  const seen = new Set();
  const deadline = Date.now() + 8 * 60 * 1000;

  while (Date.now() < deadline) {
    for (const step of run.steps) {
      const key = `${step.id}:${step.status}`;
      if (!seen.has(key)) {
        seen.add(key);
        const marker = { done: 'ok', failed: 'FALHOU', skipped: 'pulado', running: 'rodando' }[step.status] || step.status;
        console.log(`      [${marker}] ${step.title} :: ${step.command}`);
        if (step.error) console.log(`              ${step.error}`);
      }
    }

    if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') break;

    const pending = run.steps.find((step) => step.status === 'awaiting-approval');
    if (pending) {
      run = await call(url, token, `/api/runs/${run.id}/approve`, { method: 'POST', body: { stepId: pending.id } });
      continue;
    }

    await sleep(400);
    run = await call(url, token, `/api/runs/${run.id}`);
  }

  console.log(`\n      status final: ${run.status}`);

  console.log('\n[4/4] conferindo o registro de projetos...');
  // The registration happens in the server right after the run ends, so give
  // it a moment before concluding that the project is missing.
  let project = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const finalState = await call(url, token, '/api/state');
    project = finalState.projects.find((item) => item.fullName === analysis.repo.fullName);
    if (project) break;
    await sleep(400);
  }
  if (project) {
    console.log(`      registrado: ${project.fullName} (${project.stackLabel}) em ${project.dir}`);
    console.log(`      branch=${project.branch || '-'} commit=${project.lastCommit || '-'}`);
  } else {
    console.log('      projeto nao registrado (o clone pode ter falhado)');
  }

  const failed = run.status !== 'done';
  console.log(`\n${failed ? 'FALHOU' : 'OK'}: smoke test ${failed ? 'nao passou' : 'passou'}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nERRO: ${error.message}`);
  process.exit(1);
});
