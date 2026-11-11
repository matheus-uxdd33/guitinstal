'use strict';

/**
 * Accessibility audit with axe-core.
 *
 *   node tools/audit-a11y.js <url> [width] [height]
 *
 * The axe bundle is downloaded once and injected through the DevTools
 * protocol, so the app's own Content-Security-Policy stays strict and no
 * dependency is added to the project.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8080';
const WIDTH = Number(process.argv[3] || 1440);
const HEIGHT = Number(process.argv[4] || 900);
const PORT = 9844 + (process.pid % 300);
const AXE_VERSION = '4.10.2';
const AXE_PATH = path.join(os.tmpdir(), `axe-core-${AXE_VERSION}.js`);
const AXE_URL = `https://cdn.jsdelivr.net/npm/axe-core@${AXE_VERSION}/axe.min.js`;

const CHROME_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

async function ensureAxe() {
  if (fs.existsSync(AXE_PATH)) return fs.readFileSync(AXE_PATH, 'utf8');
  const response = await fetch(AXE_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`nao foi possivel baixar o axe (${response.status})`);
  const source = await response.text();
  fs.writeFileSync(AXE_PATH, source, 'utf8');
  return source;
}

async function targetUrl() {
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
  throw new Error('Chrome nao respondeu na porta de depuracao.');
}

let messageId = 0;
function cdp(ws, method, params = {}) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout em ${method}`)), 40000);
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

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome nao encontrado.');
  const axeSource = await ensureAxe();

  const profile = path.join(os.tmpdir(), `guitinstal-a11y-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let ws;
  try {
    const wsUrl = await targetUrl();
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    await cdp(ws, 'Page.enable');
    await cdp(ws, 'Runtime.enable');
    await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: WIDTH < 768,
    });
    await cdp(ws, 'Page.navigate', { url: URL_ARG });
    await sleep(3000);

    await cdp(ws, 'Runtime.evaluate', { expression: axeSource });

    const probe = await cdp(ws, 'Runtime.evaluate', {
      expression: 'typeof axe',
      returnByValue: true,
    });
    if (probe.result.value !== 'object') {
      throw new Error(`axe nao foi injetado (typeof axe = ${probe.result.value})`);
    }

    const result = await cdp(ws, 'Runtime.evaluate', {
      expression: `axe.run(document).then(r => JSON.stringify({
        violations: r.violations.map(v => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 3).map(n => n.target.join(' ')),
        })),
        passes: r.passes ? r.passes.length : 0,
        incomplete: r.incomplete ? r.incomplete.length : 0,
      })).catch(e => JSON.stringify({ error: String(e && e.message ? e.message : e) }))`,
      awaitPromise: true,
      returnByValue: true,
    });

    if (!result.result.value) {
      const detail = await cdp(ws, 'Runtime.evaluate', {
        expression: 'JSON.stringify(window.__axeError || "sem detalhes")',
        returnByValue: true,
      });
      throw new Error(`axe nao retornou resultado: ${detail.result.value}`);
    }

    const report = JSON.parse(result.result.value);

    if (report.error) {
      throw new Error(`axe falhou na pagina: ${report.error}`);
    }
    console.log(`url: ${URL_ARG}  (${WIDTH}px)`);
    console.log(`violacoes: ${report.violations.length} | incompletas: ${report.incomplete} | regras aprovadas: ${report.passes}`);

    for (const violation of report.violations) {
      console.log(`\n  [${violation.impact}] ${violation.id} — ${violation.help} (${violation.nodes} nos)`);
      for (const target of violation.targets) console.log(`      ${target}`);
    }

    ws.close();
    const serious = report.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    process.exit(serious.length ? 1 : 0);
  } finally {
    if (ws) try { ws.close(); } catch { /* already closed */ }
    child.kill();
  }
}

main().catch((error) => {
  console.error(`ERRO: ${error.message}`);
  process.exit(2);
});
