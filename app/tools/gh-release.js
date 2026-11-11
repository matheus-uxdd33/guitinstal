'use strict';

/**
 * Publishes the electron-builder output as a GitHub Release, which is the only
 * host that can serve a 121 MB installer: Vercel caps a static file at 100 MB.
 *
 *   node tools/gh-release.js --token-file C:/path/token.json [options]
 *
 * Options
 *   --token-file <path>  JSON { token } or plain text, from the device flow.
 *   --app-token          use the token the app already saved (Windows DPAPI);
 *                        sign in under Settings > GitHub first, paste nothing.
 *   --owner <login>      defaults to the authenticated user
 *   --repo <name>        repository that holds the binaries (default: guitinstal)
 *   --tag <name>         release tag (default: v<version from package.json>)
 *   --create-repo        create the repository when it does not exist
 *   --publish            turn the draft into a public release
 *   --verify             download every asset back and re-check its sha256
 *   --dry-run            show what would happen, change nothing
 *
 * The token is read from disk and only ever sent to api.github.com /
 * uploads.github.com over TLS. It is never printed, logged or written into the
 * repository, so it cannot end up inside an app bundle.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const argv = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1] || '';
};
const has = (name) => argv.includes(`--${name}`);

const appDir = path.join(__dirname, '..');
// electron-builder runs from a copy on C: when the Z: drive locks the old
// binaries, so the installers are not always under app/dist.
const distDir = path.resolve(flag('dist', path.join(appDir, 'dist')));
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));

const dryRun = has('dry-run');
const publish = has('publish');

function readToken() {
  const file = flag('token-file') || process.env.GUIT_RELEASE_TOKEN_FILE || '';
  const inline = process.env.GUIT_RELEASE_TOKEN || '';
  if (inline) return inline;
  // Same store the app uses: the token never leaves this machine and never has
  // to be copied into a file or a chat window to publish a release.
  if (has('app-token')) {
    const token = require('../core/store').getSettings().githubToken;
    if (!token) {
      throw new Error(
        'No GitHub token is saved in the app yet. Open GUITinstal > Settings > GitHub, sign in, then run this again.'
      );
    }
    return token;
  }
  if (!file) {
    throw new Error(
      'No token. Pass --token-file <path> (JSON with a "token" or "access_token" key) or set GUIT_RELEASE_TOKEN. ' +
        'Get one by signing in to GitHub in the app (Settings > GitHub) and pointing the file at a copy of that token.'
    );
  }
  if (!fs.existsSync(file)) throw new Error(`Token file not found: ${file}`);
  const raw = fs.readFileSync(file, 'utf8').trim();
  try {
    const parsed = JSON.parse(raw);
    const token = parsed.token || parsed.access_token || '';
    if (!token) throw new Error('no token key');
    return token;
  } catch {
    // a plain-text file holding only the token is accepted too
    return /^github_pat_[A-Za-z0-9_]{20,}$|^[A-Za-z0-9_-]{40}$/.test(raw) ? raw : '';
  }
}

function request(method, url, { headers = {}, body = null, raw = false, follow = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method,
        port: 443,
        headers,
      },
      (res) => {
        // Release assets answer with a 302 to a signed object host; the token
        // must not be carried onto that host.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && follow < 5) {
          res.resume();
          return resolve(
            request('GET', new URL(res.headers.location, url).href, {
              headers: { 'User-Agent': 'guitinstal-release-tool', Accept: 'application/octet-stream' },
              raw,
              follow: follow + 1,
            })
          );
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            const err = new Error(`${method} ${target.pathname} -> ${res.statusCode}: ${buf.toString('utf8').slice(0, 400)}`);
            err.status = res.statusCode;
            return reject(err);
          }
          resolve({ status: res.statusCode, headers: res.headers, text: raw ? buf : buf.toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function api(method, apiPath, body) {
  const url = apiPath.startsWith('http') ? apiPath : `https://api.github.com${apiPath}`;
  return request(method, url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'guitinstal-release-tool',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
    },
    body,
  });
}

function json(method, apiPath, body) {
  return api(method, apiPath, body ? JSON.stringify(body) : null).then((res) => JSON.parse(res.text || 'null'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sizeLabel(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The binaries this release ships, in the order the site lists them. */
function artifacts() {
  const wanted = [
    [`GUITinstal-${pkg.version}-Setup-x64.exe`, 'setup'],
    [`GUITinstal-${pkg.version}-Portable-x64.exe`, 'portable'],
    [`GUITinstal-${pkg.version}-mac-universal.dmg`, 'universal'],
    [`GUITinstal-${pkg.version}-linux-x64.AppImage`, 'appimage'],
  ];
  return wanted
    .map(([name, kind]) => {
      const file = path.join(distDir, name);
      if (!fs.existsSync(file)) return null;
      const stat = fs.statSync(file);
      return { name, kind, file, size: stat.size, sha256: sha256(file), builtAt: stat.mtime.toISOString() };
    })
    .filter(Boolean);
}

async function ensureRepo(owner, repo) {
  try {
    const existing = await json('GET', `/repos/${owner}/${repo}`);
    return { created: false, data: existing };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (!has('create-repo')) {
    throw new Error(`Repository ${owner}/${repo} does not exist. Re-run with --create-repo to publish there.`);
  }
  if (dryRun) {
    console.log(`dry-run: would create public repository ${owner}/${repo}`);
    return { created: true, data: { full_name: `${owner}/${repo}`, html_url: `https://github.com/${owner}/${repo}` } };
  }
  // A release host for open-source binaries has to be public: that is the whole
  // point of the download page.
  const created = await json(
    'POST',
    '/user/repos',
    {
      name: repo,
      description: `${pkg.productName} installers. The app source lives in the repository linked from https://guitinstal.vercel.app`,
      private: false,
      has_issues: true,
      has_wiki: false,
      auto_init: true,
    }
  );
  console.log(`created repository ${created.full_name}`);
  return { created: true, data: created };
}

async function ensureRelease(owner, repo, tag, bodyText) {
  // GET /releases/tags/{tag} ignores drafts (their page URL carries an
  // "untagged-*" placeholder), so the list endpoint is the only lookup that
  // sees every release. Without this the tool creates a second draft and
  // uploads the binaries twice.
  const all = await json('GET', `/repos/${owner}/${repo}/releases?per_page=100`);
  let release = all.find((item) => item.tag_name === tag) || null;
  if (release) {
    if (release.draft && publish) {
      release = await json('PATCH', `/repos/${owner}/${repo}/releases/${release.id}`, { draft: false });
      console.log(`release ${tag} published`);
    }
    return release;
  }
  if (dryRun) {
    console.log(`dry-run: would create release ${tag}${publish ? ' (published)' : ' (draft)'}`);
    return { id: 0, upload_url: '', html_url: `https://github.com/${owner}/${repo}/releases/tag/${tag}`, draft: !publish };
  }
  // A tag makes the release visible in the repository list, so the ref has to
  // exist first; an orphan release is rejected.
  const refs = await json('GET', `/repos/${owner}/${repo}/git/refs/tags/${tag}`).catch(() => null);
  if (!refs) {
    const branch = (await json('GET', `/repos/${owner}/${repo}`)).default_branch || 'main';
    const head = await json('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    await json('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha: head.object.sha });
    console.log(`tagged ${tag} at ${head.object.sha.slice(0, 7)}`);
  }
  const created = await json('POST', `/repos/${owner}/${repo}/releases`, {
    tag_name: tag,
    name: `${pkg.productName} ${tag}`,
    body: bodyText,
    draft: !publish,
    prerelease: false,
  });
  console.log(`release ${tag} created as ${publish ? 'published' : 'draft'}`);
  return created;
}

async function uploadAsset(release, artifact) {
  const base = release.upload_url.replace(/\{.*$/, '');
  const url = `${base}?name=${encodeURIComponent(artifact.name)}`;
  const data = fs.readFileSync(artifact.file);
  const response = await request('POST', url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'guitinstal-release-tool',
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
    },
    body: data,
  });
  const asset = JSON.parse(response.text);
  return asset;
}

async function replaceAsset(release, artifact) {
  const existing = (release.assets || []).find((asset) => asset.name === artifact.name);
  if (existing) {
    if (existing.size === artifact.size && existing.digest === `sha256:${artifact.sha256}`) {
      console.log(`  ${artifact.name}: already uploaded, unchanged`);
      return existing;
    }
    await json('DELETE', existing.url.replace('https://api.github.com', ''));
    console.log(`  ${artifact.name}: replaced the previous build`);
  }
  const asset = await uploadAsset(release, artifact);
  console.log(`  ${asset.name}: ${sizeLabel(artifact.size)} uploaded`);
  return asset;
}

/** Download a published asset back and prove the bytes match the local build. */
async function verifyAsset(asset, artifact) {
  // A draft asset is only reachable through the API asset endpoint: the public
  // browser_download_url answers 404 until the release is published.
  const response = await request('GET', asset.url, {
    raw: true,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'guitinstal-verify',
      Accept: 'application/octet-stream',
    },
  });
  const remote = response.text;
  if (Buffer.isBuffer(remote)) {
    const digest = crypto.createHash('sha256').update(remote).digest('hex');
    const ok = digest === artifact.sha256 && remote.length === artifact.size;
    console.log(
      `  ${asset.name}: downloaded ${sizeLabel(remote.length)} sha256 ${digest.slice(0, 16)}… ${ok ? 'MATCHES the local build' : 'DOES NOT MATCH'}`
    );
    return ok;
  }
  console.log(`  ${asset.name}: verification returned no bytes`);
  return false;
}

async function main() {
  const list = artifacts();
  if (!list.length) {
    throw new Error(`No installers in ${distDir}. Run npm run dist first.`);
  }
  for (const item of list) {
    console.log(`${item.name}  ${sizeLabel(item.size)}  sha256 ${item.sha256.slice(0, 16)}…  built ${item.builtAt}`);
  }

  const me = await json('GET', '/user');
  const owner = flag('owner', me.login);
  const repo = flag('repo', 'guitinstal');
  const tag = flag('tag', `v${pkg.version}`);
  console.log(`signed in as ${me.login} -> publishing to ${owner}/${repo} @ ${tag}`);

  if (dryRun) {
    console.log('dry-run: nothing was created or uploaded');
    return;
  }

  const { data: repoData } = await ensureRepo(owner, repo);
  const notesFile = flag('notes-file');
  const notes = notesFile
    ? fs.readFileSync(notesFile, 'utf8').trim()
    : [
        `## ${pkg.productName} ${pkg.version}`,
        '',
        '- Windows: NSIS setup and portable `.exe` (x64).',
        '- macOS: universal `.dmg` for Intel and Apple silicon.',
        '- Linux: x86_64 `.AppImage`.',
        '',
        'SHA-256 checksums are listed on https://guitinstal.vercel.app',
      ].join('\n');

  const release = await ensureRelease(owner, repo, tag, notes);
  const uploaded = [];
  for (const artifact of list) {
    if (dryRun) {
      console.log(`dry-run: would upload ${artifact.name}`);
      continue;
    }
    uploaded.push({ artifact, asset: await replaceAsset(release, artifact) });
  }

  if (publish && release.draft) {
    const fresh = await json('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`);
    await json('PATCH', `/repos/${owner}/${repo}/releases/${fresh.id}`, { draft: false });
    console.log('release published');
  }

  const finalRelease = await ensureRelease(owner, repo, tag, '');
  console.log('');
  console.log(`release page   ${finalRelease.html_url}`);
  const base = `https://github.com/${owner}/${repo}/releases/download/${tag}`;
  console.log(`download base  ${base}`);
  for (const item of uploaded) {
    console.log(`  ${item.asset.name} -> ${base}/${item.asset.name}`);
  }

  let allOk = true;
  if (has('verify')) {
    console.log('');
    console.log('downloading each file back to prove the host serves the exact bytes');
    for (const { artifact, asset } of uploaded) allOk = (await verifyAsset(asset, artifact)) && allOk;
    console.log(allOk ? 'verified: every asset matches the local build' : 'NOT verified');
  }

  if (!dryRun && uploaded.length) {
    console.log('');
    console.log(`next: node tools/make-site-release.js --base ${base}`);
  }
}

const token = (() => {
  try {
    return readToken();
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(1);
  }
})();

main().catch((error) => {
  console.error(`FAILED: ${String(error.message || error)}`);
  process.exit(1);
});
