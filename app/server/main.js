'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');

const { APP_NAME, APP_VERSION, appRoot, ensureDir, runtimeFile, userDataDir } = require('../core/paths');
const { getSettings } = require('../core/store');
const { json, readJsonBody, registerProject, runs } = require('./api');

const UI_DIR = path.join(appRoot(), 'ui');
const TOKEN = crypto.randomBytes(24).toString('hex');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
}

/** The server only answers to requests coming from this machine. */
function hostAllowed(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  return allowed.includes(host);
}

function tokenAllowed(req, url) {
  const header = req.headers['x-guit-token'];
  if (header && header === TOKEN) return true;
  const query = url.searchParams.get('token');
  return Boolean(query && query === TOKEN);
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(UI_DIR, relative);

  if (!target.startsWith(UI_DIR)) {
    json(res, 403, { error: 'Access denied.' });
    return;
  }

  let content;
  try {
    content = fs.readFileSync(target);
  } catch {
    json(res, 404, { error: 'File not found.' });
    return;
  }

  const ext = path.extname(target).toLowerCase();
  if (ext === '.html') {
    const html = content.toString('utf8').replaceAll('__GUIT_TOKEN__', TOKEN);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(content);
}

function streamRun(req, res, runId) {
  const run = runs.get(runId);
  if (!run) {
    json(res, 404, { error: 'Run not found.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (snapshot) => {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  };

  const unsubscribe = runs.subscribe(runId, write);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  const streamMatch = pathname.match(/^\/api\/runs\/([\w-]+)\/stream$/);
  if (streamMatch) {
    if (!tokenAllowed(req, url)) {
      json(res, 403, { error: 'Invalid token.' });
      return;
    }
    streamRun(req, res, streamMatch[1]);
    return;
  }

  if (!pathname.startsWith('/api/')) {
    await serveStatic(req, res, pathname);
    return;
  }

  if (!tokenAllowed(req, url)) {
    json(res, 403, { error: 'Missing or invalid session token.' });
    return;
  }

  const route = apiRoutes.find((item) => item.method === req.method && item.path.test(pathname));
  if (!route) {
    json(res, 404, { error: 'Route not found.' });
    return;
  }

  const params = pathname.match(route.path).slice(1);
  try {
    const result = await route.handler(req, params);
    json(res, 200, result);
  } catch (error) {
    json(res, 400, { error: error.message || 'Unexpected error.' });
  }
}

/* routes are loaded lazily so api.js stays free of HTTP concerns */
const apiRoutes = require('./api').routes;

/* ------------------------------------------------------------------ */
/* browser window                                                      */
/* ------------------------------------------------------------------ */

function findBrowser() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (process.env['ProgramFiles(x86)']) {
    candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/** Opens the interface as a standalone window (no browser chrome). */
function openAppWindow(url) {
  const browser = findBrowser();
  const profile = path.join(ensureDir(userDataDir()), 'browser-profile');
  ensureDir(profile);

  if (browser) {
    const child = spawn(
      browser,
      [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        '--window-size=1440,900',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false }
    );
    child.unref();
    return { mode: 'app-window', browser: path.basename(browser) };
  }

  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { mode: 'browser', browser: 'system default' };
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1200, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(), 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  ensureDir(userDataDir());
  const shouldOpen = process.argv.includes('--open');

  // The workspace must exist before any clone runs from it.
  try {
    ensureDir(getSettings().workspace);
  } catch {
    /* the folder is created again on the next run */
  }

  const existing = await readRuntime();
  if (existing?.pid && existing.port) {
    let alive = false;
    try {
      process.kill(existing.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && (await portInUse(existing.port))) {
      const url = `http://127.0.0.1:${existing.port}`;
      console.log(`[GUITinstal] Already running at ${url}`);
      if (shouldOpen) openAppWindow(url);
      return;
    }
  }

  const server = http.createServer((req, res) => {
    securityHeaders(res);
    const port = server.address()?.port;
    if (!hostAllowed(req, port)) {
      json(res, 403, { error: 'Host not allowed.' });
      return;
    }
    handle(req, res).catch((error) => {
      json(res, 500, { error: error.message || 'Internal error.' });
    });
  });

  // Long-lived idle connections: the UI polls and keeps an SSE stream open.
  // The 5s default would make the browser reconnect constantly.
  server.keepAliveTimeout = 30000;
  server.headersTimeout = 35000;
  server.requestTimeout = 0;

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}`;
    fs.writeFileSync(
      runtimeFile(),
      JSON.stringify({ pid: process.pid, port, url, token: TOKEN, startedAt: new Date().toISOString() }, null, 2)
    );

    console.log(`${APP_NAME} ${APP_VERSION}`);
    console.log(`Interface: ${url}`);
    console.log(`App data: ${userDataDir()}`);

    if (shouldOpen) {
      const info = openAppWindow(url);
      console.log(`Window opened (${info.browser}, ${info.mode} mode).`);
    }
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('GUITinstal failed to start:', error);
  process.exit(1);
});
