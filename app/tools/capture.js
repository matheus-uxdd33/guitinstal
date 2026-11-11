'use strict';

/**
 * Captura telas em larguras exatas e audita overflow horizontal.
 *
 *   node tools/capture.js <url> <saida> [largura] [altura] [seletor] [clique] [campo=valor]
 *
 * Usa o Chrome DevTools Protocol com emulacao de dispositivo: no Windows o
 * Chrome headless nunca abre uma janela com menos de 500px, entao sem
 * `Emulation.setDeviceMetricsOverride` nao existe como validar 390px de
 * verdade. Nao precisa de nenhuma dependencia.
 *
 * Com `seletor`, a captura vira um recorte exato daquele elemento e imprime a
 * geometria dele (x, y, altura, larguras de filho) em vez da tela inteira.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8080';
const OUTPUT = process.argv[3] || 'screenshot.png';
const WIDTH = Number(process.argv[4] || 1440);
const HEIGHT = Number(process.argv[5] || 900);
const SELECTOR = process.argv[6] || '';
const CLICK = process.argv[7] || '';
const TYPE = process.argv[8] || '';
const PORT = 9444 + (process.pid % 500);

const CHROME_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) || null;
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
    const timer = setTimeout(() => reject(new Error(`timeout em ${method}`)), 30000);
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
  const viewWidth = document.documentElement.clientWidth;
  const offenders = [];
  const clipped = [];
  const inHidden = (el) => {
    let node = el;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.transform !== 'none' && style.position === 'fixed') return true;
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      node = node.parentElement;
    }
    return false;
  };
  const clipAncestor = (el, rect) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'hidden' || style.overflowX === 'clip' || style.overflowX === 'auto' || style.overflowX === 'scroll') {
        const box = node.getBoundingClientRect();
        if (rect.right > box.right + 1 || rect.left < box.left - 1) return node;
      }
      node = node.parentElement;
    }
    return null;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (inHidden(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right <= viewWidth + 1) continue;
    const clipper = clipAncestor(el, rect);
    if (clipper) {
      clipped.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 50),
        by: clipper.id || clipper.className,
        right: Math.round(rect.right),
      });
      continue;
    }
    offenders.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 50),
      id: el.id || '',
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      text: (el.textContent || '').trim().slice(0, 36),
    });
  }
  return {
    docWidth: document.documentElement.scrollWidth,
    viewWidth,
    offenders: offenders.slice(0, 12),
    total: offenders.length,
    clipped: clipped.length,
    clippedSample: clipped.slice(0, 3),
  };
})()`;

function geometryExpression(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true, selector: ${JSON.stringify(selector)} };
    const rect = el.getBoundingClientRect();
    const box = {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const children = [...el.children].map((child) => {
      const r = child.getBoundingClientRect();
      const style = getComputedStyle(child);
      return {
        tag: child.tagName.toLowerCase(),
        cls: (typeof child.className === 'string' ? child.className : '').split(' ')[0],
        display: style.display,
        left: Math.round(r.left + window.scrollX),
        top: Math.round(r.top + window.scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });
    return { box, children, visible: box.height > 0 && getComputedStyle(el).display !== 'none' };
  })()`;
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome nao encontrado.');

  const profile = path.join(os.tmpdir(), `guitinstal-capture-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true });

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
    await sleep(3500);

    if (TYPE) {
      const split = TYPE.indexOf('=');
      const typed = await cdp(ws, 'Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(
          TYPE.slice(0, split)
        )}); if (!el) return 'NOT FOUND'; el.value = ${JSON.stringify(TYPE.slice(split + 1))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.id || ${JSON.stringify(TYPE.slice(0, split))}; })()`,
        returnByValue: true,
      });
      console.log(`typed       : ${typed.result.value}`);
      await sleep(400);
    }

    if (CLICK) {
      const clicked = await cdp(ws, 'Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(CLICK)}); if (!el) return 'NAO ENCONTRADO'; el.click(); return el.textContent.trim().slice(0, 30) || el.id; })()`,
        returnByValue: true,
      });
      console.log(`clique      : ${clicked.result.value}`);
      await sleep(2600);
    }

    const audit = await cdp(ws, 'Runtime.evaluate', { expression: AUDIT_EXPRESSION, returnByValue: true });
    const info = audit.result.value;

    const params = { format: 'png', captureBeyondViewport: false };
    if (SELECTOR) {
      const geometry = await cdp(ws, 'Runtime.evaluate', { expression: geometryExpression(SELECTOR), returnByValue: true });
      const geo = geometry.result.value;
      if (geo.missing) throw new Error(`Seletor nao encontrado: ${geo.selector}`);
      params.captureBeyondViewport = true;
      params.clip = { x: geo.box.x, y: geo.box.y, width: geo.box.width, height: geo.box.height, scale: 1 };
      await cdp(ws, 'Runtime.evaluate', { expression: `window.scrollTo(0, 0)`, returnByValue: true });
      await sleep(200);

      console.log(`selector    : ${SELECTOR}`);
      console.log(`box         : ${geo.box.width}x${geo.box.height} em y=${geo.box.y}`);
      for (const child of geo.children) {
        console.log(`   <${child.tag}.${child.cls}> ${child.display.padEnd(6)} ${child.width}x${child.height}  x=${child.left} y=${child.top}`);
      }
    }

    const shot = await cdp(ws, 'Page.captureScreenshot', params);
    fs.writeFileSync(path.resolve(OUTPUT), Buffer.from(shot.data, 'base64'));

    console.log(`viewport    : ${info.viewWidth}px`);
    console.log(`scrollWidth : ${info.docWidth}px`);
    console.log(`overflow    : ${info.docWidth > info.viewWidth ? 'SIM (problema)' : 'nao'}`);
    console.log(`fora da tela: ${info.total} (recortados pelo container: ${info.clipped})`);
    for (const item of info.offenders) {
      console.log(`   <${item.tag}${item.id ? '#' + item.id : ''}${item.cls ? '.' + item.cls.split(' ')[0] : ''}> right=${item.right} w=${item.width} "${item.text}"`);
    }
    console.log(`captura     : ${path.resolve(OUTPUT)}`);

    ws.close();
    process.exit(info.docWidth > info.viewWidth ? 1 : 0);
  } finally {
    if (ws) try { ws.close(); } catch { /* already closed */ }
    child.kill();
  }
}

main().catch((error) => {
  console.error(`ERRO: ${error.message}`);
  process.exit(2);
});
