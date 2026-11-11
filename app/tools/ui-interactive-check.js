'use strict';

/**
 * Proves the interactive-terminal path in the real UI: it drives the app in
 * Chrome, approves the install of a repository that stops and asks a question,
 * screenshots the answer box, types the answer and screenshots the result.
 *
 *   node server/main.js
 *   node tools/ui-interactive-check.js [owner/repo] [answer]
 *
 * Screenshots land in the OS temp folder; the tool prints the geometry of the
 * answer box so the layout claim is measurable, not a vibe.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runtimeFile } = require('../core/paths');

const REPO = process.argv[2] || 'sindresorhus/is';
const ANSWER = process.argv.length > 3 ? process.argv[3] : 'y';
const OUT_DIR = path.join(os.tmpdir(), 'guitinstal-interactive-check');
const WIDTH = 1280;
const HEIGHT = 900;
const PORT = 9700 + (process.pid % 200);

const CHROME_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error('Chrome not found.');
  return found;
}

function runtime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(), 'utf8'));
  } catch {
    throw new Error('GUITinstal is not running. Start it with "node server/main.js" first.');
  }
}

async function debugTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* still starting */
    }
    await sleep(250);
  }
  throw new Error('Chrome did not answer on the debugging port.');
}

let messageId = 0;
function cdp(ws, method, params = {}) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout in ${method}`)), 60000);
    const handler = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', handler);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await cdp(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result?.value;
}

async function screenshot(ws, selector, file) {
  const geometry = await evaluate(
    ws,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; })()`
  );
  if (!geometry) {
    console.log(`   (selector ${selector} not present)`);
    return null;
  }
  await evaluate(ws, 'window.scrollTo(0, 0)');
  await sleep(150);
  const shot = await cdp(ws, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { ...geometry, scale: 1 },
  });
  const target = path.join(OUT_DIR, file);
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  console.log(`   ${file}  ${geometry.width}x${geometry.height} em y=${geometry.y} -> ${target}`);
  return geometry;
}

/** Waits until the expression returns something truthy, or gives up. */
async function waitFor(ws, expression, seconds, label) {
  const stop = Date.now() + seconds * 1000;
  while (Date.now() < stop) {
    const value = await evaluate(ws, expression);
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`timed out after ${seconds}s waiting for ${label}`);
}

const STEP_STATE = `(() => {
  const step = [...document.querySelectorAll('.plan-step')].find((el) => el.querySelector('.answer-input'));
  if (!step) return null;
  const input = step.querySelector('.answer-input');
  const button = step.querySelector('[data-run-action="answer"]');
  const ask = step.querySelector('.step-answer-ask');
  const box = step.getBoundingClientRect();
  const row = step.querySelector('.step-answer-row').getBoundingClientRect();
  return {
    question: (step.querySelector('.step-command') || {}).textContent,
    ask: ask ? ask.textContent : '',
    placeholder: input.getAttribute('aria-label'),
    stepClass: step.className,
    box: { width: Math.round(box.width), height: Math.round(box.height) },
    input: { width: Math.round(row.width), left: Math.round(row.left), top: Math.round(row.top + window.scrollY) },
    button: button ? button.textContent.trim() : '',
    focus: document.activeElement === input,
  };
})()`;

async function main() {
  const chrome = findChrome();
  const { url: appUrl } = runtime();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const profile = path.join(os.tmpdir(), `guitinstal-interactive-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });

  const { spawn } = require('node:child_process');
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let ws;
  let failed = '';
  try {
    const wsUrl = await debugTarget();
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    await cdp(ws, 'Page.enable');
    await cdp(ws, 'Runtime.enable');
    await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

    await cdp(ws, 'Page.navigate', { url: appUrl });
    await sleep(2500);

    console.log(`App      : ${appUrl}`);
    console.log(`Repo     : ${REPO}`);
    console.log(`Answer   : "${ANSWER}"\n`);

    console.log('[1/5] typing the repository and analyzing');
    await evaluate(
      ws,
      `(() => { const i = document.querySelector('#repoUrl'); i.value = ${JSON.stringify(REPO)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
    );
    await evaluate(ws, `document.querySelector('#analyzeButton').click()`);
    await waitFor(ws, `document.querySelector('#approveAll') ? true : ''`, 60, 'the plan to appear');

    console.log('[2/5] approving every step');
    await evaluate(ws, `document.querySelector('#approveAll').click()`);
    await sleep(1500);
    console.log(`   run status: ${await evaluate(ws, `(() => { const s = document.querySelector('#runStatus'); const t = document.querySelector('.toast'); return (s ? s.textContent : 'no pill') + (t ? ' | toast: ' + t.textContent.trim() : ''); })()`)}`);

    console.log('[3/5] waiting for the command to ask a question');
    const state = await waitFor(ws, STEP_STATE, 180, 'the answer box');
    console.log(`   command  : ${String(state.question).trim()}`);
    console.log(`   ask text : ${state.ask}`);
    console.log(`   box      : ${state.box.width}x${state.box.height}, input ${state.input.width}px wide, focused=${state.focus}`);
    console.log(`   button   : "${state.button}"`);
    await screenshot(ws, '.plan-step.running', 'before-answer.png');

    console.log('[4/5] typing the answer and sending it');
    await evaluate(ws, `document.querySelector('.answer-input').focus()`);
    await cdp(ws, 'Input.insertText', { text: ANSWER });
    const typed = await evaluate(ws, `document.querySelector('.answer-input').value`);
    console.log(`   field now holds: "${typed}"`);
    await evaluate(ws, `document.querySelector('.plan-step [data-run-action="answer"]').click()`);

    console.log('[5/5] waiting for the step to finish');
    const finished = await waitFor(
      ws,
      `(() => {
        const step = [...document.querySelectorAll('.plan-step')].find((el) => el.querySelector('.step-command') && ${JSON.stringify(state.question)} === el.querySelector('.step-command').textContent);
        if (!step) return null;
        const pill = step.querySelector('.status-pill');
        const text = pill ? pill.textContent : '';
        return /concluído|done|falhou|failed/.test(text) ? text : null;
      })()`,
      180,
      'the install step to end'
    );
    console.log(`   step status: ${finished}`);
    await screenshot(ws, '#planList', 'after-answer.png');
    await screenshot(ws, '#consoleBody', 'console.png');

    const answered = await evaluate(
      ws,
      `(() => { const line = [...document.querySelectorAll('.log-line.stdin')].map((l) => l.textContent.trim()); return line.join(' | '); })()`
    );
    console.log(`   console echo of what was typed: "${answered}"`);

    if (!/concluído|done/.test(String(finished))) failed = `step ended as ${finished}`;
  } catch (error) {
    failed = error.message;
    if (ws) {
      const diagnostics = await evaluate(
        ws,
        `(() => [...document.querySelectorAll('.plan-step')].map((el) => {
          const pill = el.querySelector('.status-pill');
          const title = el.querySelector('.step-title');
          return (title ? title.textContent.trim() : el.className) + ' -> ' + (pill ? pill.textContent.trim() : 'no pill');
        }).join(' | '))()`
      ).catch(() => '');
      console.log(`   steps: ${diagnostics || '(none)'}`);
    }
    await screenshot(ws, '#planList', 'error.png').catch(() => {});
  } finally {
    if (ws) try { ws.close(); } catch { /* already closed */ }
    child.kill();
    await sleep(1200);
    // Chrome keeps the profile folder for a moment after it is killed.
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* leftover temp folder, the OS cleans it */
    }
  }

  if (failed) {
    console.log(`\nFAIL: ${failed}`);
    process.exit(1);
  }
  console.log(`\nPASS: the app asked, the UI answered, the command continued. Screenshots in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(2);
});
