'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runIsolated() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guitinstal-launch-'));
  const result = spawnSync(process.execPath, [__filename, '--worker'], {
    env: {
      ...process.env,
      GUITINSTAL_TEST_ROOT: tempRoot,
      GUITINSTAL_USER_DATA: path.join(tempRoot, 'data'),
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
}

async function runWorker() {
  const tempRoot = process.env.GUITINSTAL_TEST_ROOT;
  const projectDir = path.join(tempRoot, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  const { upsertProject, getProject } = require('../core/store');
  const { routes } = require('../server/api');
  const launch = routes.find((route) => route.method === 'POST' && route.path.test('/api/projects/smoke/launch'));
  const stop = routes.find((route) => route.method === 'POST' && route.path.test('/api/projects/smoke/stop'));
  const server = [
    "const http = require('node:http');",
    "const server = http.createServer((_request, response) => response.end('GUITinstal launch test'));",
    "server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));",
  ].join(' ');
  upsertProject({
    id: 'smoke',
    name: 'launch-smoke',
    fullName: 'test/launch-smoke',
    dir: projectDir,
    stack: 'node',
    launch: { cmd: process.execPath, args: ['-e', server], command: 'node -e <smoke server>' },
  });

  let started = false;
  try {
    const result = await launch.handler({}, ['smoke']);
    started = true;
    assert.equal(result.ok, true);
    assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
    const response = await fetch(result.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'GUITinstal launch test');
    assert.equal(getProject('smoke').status, 'running');
    console.log('ok   Run starts a local project and records its reachable URL');

    const stopped = await stop.handler({}, ['smoke']);
    started = false;
    assert.equal(stopped.ok, true);
    assert.equal(getProject('smoke').status, 'installed');
    console.log('ok   Stop terminates the project and restores its library state');
    console.log('\nProject launch self-test: 2/2 checks passed');
  } finally {
    if (started) await stop.handler({}, ['smoke']).catch(() => {});
  }
}

if (process.argv[2] === '--worker') {
  runWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  try {
    runIsolated();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
