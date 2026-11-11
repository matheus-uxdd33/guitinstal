'use strict';

/**
 * Layout audit: finds elements that overflow the viewport horizontally.
 *
 *   node tools/audit-layout.js [url] [width] [height]
 *
 * Uses the Chrome DevTools Protocol over Node's built-in WebSocket, so it
 * needs no dependencies.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8080';
const WIDTH = Number(process.argv[3] || 390);
const HEIGHT = Number(process.argv[4] || 844);
const PORT = 9333;

const CHROME_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targetUrl() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome is still starting */
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

const AUDIT_EXPRESSION = `(() => {
  const docWidth = document.documentElement.scrollWidth;
  const viewWidth = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right > viewWidth + 1 || rect.left < -1) {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' && rect.right <= viewWidth + 1) continue;
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 60)) || '',
        id: el.id || '',
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }
  return { docWidth, viewWidth, offenders: offenders.slice(0, 20), total: offenders.length };
})()`;

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome nao encontrado.');

  const profile = path.join(os.tmpdir(), 'guitinstal-audit-profile');
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
      URL_ARG,
    ],
    { stdio: 'ignore', detached: false }
  );

  try {
    const wsUrl = await targetUrl();
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    await cdp(ws, 1, 'Page.enable');
    await sleep(2500);

    const result = await cdp(ws, 2, 'Runtime.evaluate', {
      expression: AUDIT_EXPRESSION,
      returnByValue: true,
    });

    const audit = result.result.value;
    console.log(`viewport      : ${audit.viewWidth}px`);
    console.log(`scrollWidth   : ${audit.docWidth}px`);
    console.log(`overflow      : ${audit.docWidth > audit.viewWidth ? 'SIM' : 'nao'}`);
    console.log(`elementos fora: ${audit.total}`);

    for (const item of audit.offenders) {
      console.log(
        `  <${item.tag}${item.id ? '#' + item.id : ''}${item.cls ? '.' + item.cls.split(' ').join('.') : ''}> ` +
          `left=${item.left} right=${item.right} w=${item.width} "${item.text}"`
      );
    }

    const errors = await cdp(ws, 3, 'Runtime.evaluate', {
      expression: 'JSON.stringify(window.__auditErrors || [])',
      returnByValue: true,
    });
    if (errors.result.value && errors.result.value !== '[]') {
      console.log(`erros de console: ${errors.result.value}`);
    }

    ws.close();
    process.exit(audit.docWidth > audit.viewWidth ? 1 : 0);
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(`ERRO: ${error.message}`);
  process.exit(2);
});
