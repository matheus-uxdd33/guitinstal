'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { fetchUserRepos } = require('../core/github');

async function main() {
  const originalFetch = global.fetch;
  let requested;
  global.fetch = async (url, options) => {
    requested = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [
        {
          name: 'public-project',
          full_name: 'example/public-project',
          private: false,
          html_url: 'https://github.com/example/public-project',
          stargazers_count: 7,
          owner: { login: 'example', avatar_url: 'https://avatars.example/avatar.png' },
        },
        {
          name: 'private-project',
          full_name: 'example/private-project',
          private: true,
          html_url: 'https://github.com/example/private-project',
        },
      ],
    };
  };

  try {
    const result = await fetchUserRepos('example-selftest');
    const url = new URL(requested.url);
    assert.equal(url.pathname, '/users/example-selftest/repos');
    assert.equal(url.searchParams.get('type'), 'owner');
    assert.equal(url.searchParams.get('sort'), 'updated');
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(requested.options.headers.Authorization, undefined);
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].fullName, 'example/public-project');
    console.log('ok   loads public repositories and excludes private repositories');
    console.log('ok   requests the most recently updated 100 owned repositories');
  } finally {
    global.fetch = originalFetch;
  }

  await assert.rejects(() => fetchUserRepos('invalid/name'), /account name is invalid/);
  console.log('ok   rejects invalid account names before making a request');

  const originalUserData = process.env.GUITINSTAL_USER_DATA;
  const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'guitinstal-github-repos-'));
  process.env.GUITINSTAL_USER_DATA = testUserData;
  try {
    const { routes } = require('../server/api');
    const discover = routes.find((route) => route.method === 'POST' && route.path.test('/api/discover'));
    const response = await discover.handler(Readable.from([Buffer.from(JSON.stringify({ mode: 'mine' }))]));
    assert.equal(response.mode, 'mine');
    assert.equal(response.items.length, 0);
    assert.match(response.note, /Sign in with GitHub/);
    console.log('ok   asks unsigned-in users to connect before loading their repositories');
  } finally {
    if (originalUserData === undefined) delete process.env.GUITINSTAL_USER_DATA;
    else process.env.GUITINSTAL_USER_DATA = originalUserData;
    fs.rmSync(testUserData, { recursive: true, force: true });
  }
  console.log('\nGitHub repository self-test: 4/4 checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
