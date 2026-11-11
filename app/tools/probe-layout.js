'use strict';

/**
 * Overlap probe: checks that no visible content sits under the fixed sidebar.
 *
 *   node tools/probe-layout.js [url] [width] [height]
 *
 * Headless Chrome over the DevTools protocol, no dependencies.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8080';
const WIDTH = Number(process.argv[3] || 1440);
const HEIGHT = Number(process.argv[4] || 900);
const CONTENT = process.argv[5] || '.main';
// A fresh port and profile per run: Chrome refuses to bind the debug port when
// it attaches to an instance that already owns that profile.
const PORT = 9400 + (process.pid % 300);

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

async function webSocketUrl() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome is starting */
    }
    await sleep(250);
  }
  throw new Error('Chrome nao respondeu na porta de depuracao.');
}

function cdp(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout em ${method}`)), 20000);
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

const PROBE = `(() => {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return { error: 'sem .sidebar na pagina' };
  const sb = sidebar.getBoundingClientRect();
  const sidebarVisible = getComputedStyle(sidebar).transform !== 'none' || sb.left >= 0;
  const offenders = [];
  for (const el of document.querySelectorAll("${CONTENT} *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right <= sb.right) continue;
    const overlaps = r.left < sb.right && sb.left < r.right && r.top < sb.bottom && sb.top < r.bottom;
    if (!overlaps) continue;
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.visibility === 'hidden') continue;
    offenders.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 44),
      left: Math.round(r.left),
      coveredBy: Math.round(sb.right - r.left),
      text: (el.textContent || '').trim().slice(0, 42),
    });
  }
  const brandEl = document.querySelector('.brand');
  const nameEl = document.querySelector('.brand-name');
  const brand = brandEl ? {
    clientWidth: brandEl.clientWidth,
    scrollWidth: brandEl.scrollWidth,
    nameShown: nameEl ? Math.round(nameEl.getBoundingClientRect().width) : null,
    nameNeeds: nameEl ? nameEl.scrollWidth : null,
    fontSize: getComputedStyle(brandEl).fontSize,
  } : null;
  const marks = [];
  for (const el of document.querySelectorAll('.brand-mark, .cta-symbol, .mini-mark')) {
    const r = el.getBoundingClientRect();
    marks.push({
      cls: String(el.className || '').slice(0, 30),
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      squashed: Math.abs(r.width - r.height) > 1,
    });
  }
  return {
    viewport: [innerWidth, innerHeight],
    sidebar: { left: Math.round(sb.left), right: Math.round(sb.right), visible: sidebarVisible },
    mainMarginLeft: getComputedStyle(document.querySelector("${CONTENT}")).marginLeft,
    squashedMarks: marks.filter((mark) => mark.squashed),
    brand,
    marks,
    offenders: offenders.slice(0, 8),
    total: offenders.length,
  };
})()`;

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome nao encontrado.');

  const profile = path.join(os.tmpdir(), `guitinstal-probe-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-allow-origins=*',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      URL_ARG,
    ],
    { stdio: 'ignore' },
  );

  try {
    const ws = new WebSocket(await webSocketUrl());
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    await cdp(ws, 1, 'Runtime.enable');
    await sleep(1500);
    const result = await cdp(ws, 2, 'Runtime.evaluate', { expression: PROBE, returnByValue: true });
    console.log(JSON.stringify(result.result.value, null, 2));
    ws.close();
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error('ERRO:', error.message);
  process.exit(1);
});
