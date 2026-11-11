'use strict';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const CACHE_TTL = { repo: 5 * MINUTE, tree: 10 * MINUTE, file: 10 * MINUTE, search: 3 * MINUTE, commits: 2 * MINUTE };
const CACHE_MAX = 80;

const cache = new Map();
const buckets = { core: blank(), search: blank() };

function blank() {
  return { remaining: null, reset: 0, blockedUntil: 0 };
}

function bucketFor(url) {
  return url.startsWith(`${API}/search`) ? buckets.search : buckets.core;
}

function noteLimit(url, response) {
  const bucket = bucketFor(url);
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining !== null && Number.isFinite(Number(remaining))) bucket.remaining = Number(remaining);
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset) bucket.reset = Number(reset) * SECOND;
  // Secondary limits answer with retry-after in seconds instead of a reset stamp.
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) bucket.blockedUntil = Date.now() + Number(retryAfter) * SECOND;
}

function minutesUntil(at) {
  return Math.max(1, Math.ceil((at - Date.now()) / MINUTE));
}

function waitMessage(bucket) {
  if (bucket.blockedUntil > Date.now()) return `about ${minutesUntil(bucket.blockedUntil)} min`;
  if (bucket.remaining === 0 && bucket.reset > Date.now()) return `about ${minutesUntil(bucket.reset)} min`;
  return 'a few minutes';
}

/**
 * Fails before spending a request that GitHub has already told us it will
 * refuse. One free slot is kept so a reset that happened server-side still
 * lets the app recover without a restart.
 */
function checkLimit(url) {
  const bucket = bucketFor(url);
  if (bucket.blockedUntil > Date.now()) {
    throw new Error(`GitHub is rate limiting this device. Try again in ${waitMessage(bucket)}.`);
  }
  if (bucket.remaining === 0 && bucket.reset > Date.now()) {
    throw new Error(
      `The GitHub API limit is used up. Try again in ${waitMessage(bucket)} or add a personal token in Settings to raise it from 60 to 5000 requests per hour.`
    );
  }
}

function headers(token) {
  const base = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'GUITinstal/1.0 (+desktop app)',
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

async function request(url, token, { method = 'GET' } = {}) {
  checkLimit(url);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: headers(token),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('The GitHub request timed out. Check your connection.');
    }
    throw new Error(`Could not reach GitHub: ${error.message}`);
  }

  noteLimit(url, response);

  if (response.status === 403 || response.status === 429) {
    const bucket = bucketFor(url);
    if (bucket.remaining === 0 || response.status === 429 || bucket.blockedUntil > Date.now()) {
      throw new Error(
        `The GitHub API limit is used up. Try again in ${waitMessage(bucket)} or add a personal token in Settings to raise it from 60 to 5000 requests per hour.`
      );
    }
    throw new Error('GitHub refused this request (403). Check your token or try again later.');
  }

  if (response.status === 404) {
    const error = new Error('Repository not found on GitHub. Check the owner and the name.');
    error.status = 404;
    throw error;
  }

  if (response.status === 409) {
    throw new Error('This repository is empty (no commits), so there is nothing to analyze.');
  }

  if (response.status === 422) {
    throw new Error('GitHub refused this repository. Check that the name is correct.');
  }

  if (response.status === 401) {
    // A revoked or expired OAuth token answers 401 on every call, so the app
    // says what to do about it instead of repeating "GitHub answered 401".
    const error = new Error('GitHub rejected the saved token. It has expired or been revoked - sign in again in Settings.');
    error.code = 'token-invalid';
    throw error;
  }

  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} ${response.statusText}.`);
  }

  return response;
}

/**
 * Small TTL cache so repeated screens in one session do not burn the 60
 * requests/hour that an anonymous device gets. Errors are never cached.
 */
async function cachedJson(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = await load();
  if (cache.size >= CACHE_MAX) {
    for (const [stale, entry] of cache) if (entry.expires <= Date.now()) cache.delete(stale);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  cache.set(key, { value, expires: Date.now() + ttl });
  return value;
}

/** Repository metadata: description, stars, license, default branch, size. */
async function fetchRepo(owner, repo, token) {
  const url = `${API}/repos/${owner}/${repo}`;
  return cachedJson(url, CACHE_TTL.repo, async () => {
    const data = await (await request(url, token)).json();
    return {
      owner: data.owner?.login || owner,
      name: data.name || repo,
      fullName: data.full_name || `${owner}/${repo}`,
      description: data.description || '',
      url: data.html_url,
      cloneUrl: data.clone_url,
      stars: data.stargazers_count ?? 0,
      forks: data.forks_count ?? 0,
      openIssues: data.open_issues_count ?? 0,
      language: data.language || '',
      license: data.license?.spdx_id || '',
      topics: Array.isArray(data.topics) ? data.topics : [],
      defaultBranch: data.default_branch || 'main',
      sizeKb: data.size ?? 0,
      isArchived: Boolean(data.archived),
      isFork: Boolean(data.fork),
      pushedAt: data.pushed_at || '',
      createdAt: data.created_at || '',
      homepage: data.homepage || '',
      ownerAvatar: data.owner?.avatar_url || '',
    };
  });
}

/** Full recursive file tree of a branch, used for stack detection. */
async function fetchTree(owner, repo, ref, token) {
  const url = `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  return cachedJson(url, CACHE_TTL.tree, async () => {
    const data = await (await request(url, token)).json();
    const entries = (data.tree || [])
      .filter((node) => node.type === 'blob')
      .map((node) => ({ path: node.path, size: node.size || 0 }));
    return { entries, truncated: Boolean(data.truncated), sha: data.sha || '' };
  });
}

/** Raw file content (package.json, pyproject.toml, pom.xml, ...). */
async function fetchFile(owner, repo, ref, filePath) {
  const url = `${RAW}/${owner}/${repo}/${encodeURIComponent(ref)}/${filePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  return cachedJson(url, CACHE_TTL.file, async () => {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GUITinstal/1.0 (+desktop app)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 200000) return null;
    return text;
  });
}

/**
 * The GitHub account a token belongs to. Only GitHub can answer this, so the
 * app never guesses a username out of the token itself. Not cached: signing out
 * and signing back in has to show a different account at once.
 */
async function fetchViewer(token) {
  if (!token) throw new Error('No GitHub token is saved on this machine yet.');
  const data = await (await request(`${API}/user`, token)).json();
  return {
    login: data.login || '',
    name: data.name || '',
    avatarUrl: data.avatar_url || '',
    htmlUrl: data.html_url || '',
    type: data.type || 'User',
    publicRepos: Number.isFinite(data.public_repos) ? data.public_repos : null,
  };
}

/** Repository search used by the Discover screen. */
async function searchRepos(query, token, { sort = 'stars', page = 1 } = {}) {
  const params = new URLSearchParams({
    q: query,
    sort,
    order: 'desc',
    per_page: '18',
    page: String(page),
  });
  const url = `${API}/search/repositories?${params}`;
  return cachedJson(url, CACHE_TTL.search, async () => {
    const data = await (await request(url, token)).json();
    return {
      total: data.total_count ?? 0,
      items: (data.items || []).map((item) => ({
        owner: item.owner?.login || '',
        name: item.name,
        fullName: item.full_name,
        description: item.description || '',
        url: item.html_url,
        stars: item.stargazers_count ?? 0,
        forks: item.forks_count ?? 0,
        ownerAvatar: item.owner?.avatar_url || '',
        pushedAt: item.pushed_at || '',
        language: item.language || '',
        license: item.license?.spdx_id || '',
        updatedAt: item.updated_at || '',
        topics: Array.isArray(item.topics) ? item.topics.slice(0, 5) : [],
      })),
    };
  });
}

/** Commits of a branch, used to detect available updates. */
async function fetchCommits(owner, repo, ref, token) {
  const url = `${API}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=10`;
  return cachedJson(url, CACHE_TTL.commits, async () => {
    const data = await (await request(url, token)).json();
    return (data || []).map((commit) => ({
      sha: commit.sha.slice(0, 7),
      message: (commit.commit?.message || '').split('\n')[0],
      author: commit.commit?.author?.name || '',
      date: commit.commit?.author?.date || '',
      url: commit.html_url,
    }));
  });
}

/**
 * Browsing without a typed search box. These are real GitHub search queries,
 * not a curated list: "popular" orders by stars, "recent" by the last update
 * inside a rolling seven-day window. Whatever the API returns is what shows.
 */
async function browseRepos({ mode = 'popular', language = '', token = '' } = {}) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const qualifier = language ? ` language:${language.replace(/[^A-Za-z0-9.#+-]/g, '')}` : '';
  const query = mode === 'recent' ? `stars:>50 pushed:>=${since}${qualifier}` : `stars:>500${qualifier}`;
  const sort = mode === 'recent' ? 'updated' : 'stars';
  return searchRepos(query, token, { sort });
}

/** Topics broad enough that a random draw still lands on a project worth installing. */
const RANDOM_TOPICS = [
  'cli', 'devtools', 'selfhosted', 'productivity', 'automation', 'api', 'web', 'bot',
  'editor', 'database', 'security', 'visualization', 'machine-learning', 'game',
  'framework', 'compiler', 'terminal', 'monitoring', 'education', 'scraping',
];

function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * A random slice of public GitHub, for the "Surprise me" mode. GitHub has no
 * random endpoint, so the randomness is in the query itself - a topic, a star
 * floor and a page drawn each time - and the page is shuffled on the way out.
 * Every card is a real repository the API returned; nothing here is curated.
 */
async function randomRepos({ language = '', token = '' } = {}) {
  const topic = RANDOM_TOPICS[Math.floor(Math.random() * RANDOM_TOPICS.length)];
  const floor = [25, 100, 500, 2000][Math.floor(Math.random() * 4)];
  const since = new Date(Date.now() - 540 * 86400000).toISOString().slice(0, 10);
  const qualifiers = [`topic:${topic}`, `stars:>=${floor}`, 'archived:false', `pushed:>=${since}`];
  if (language) qualifiers.push(`language:"${language.replace(/[^A-Za-z0-9.#+-]/g, '')}"`);
  const result = await searchRepos(qualifiers.join(' '), token, {
    sort: 'updated',
    page: 1 + Math.floor(Math.random() * 3),
  });
  return { ...result, items: shuffled(result.items) };
}

module.exports = {
  browseRepos,
  fetchCommits,
  fetchFile,
  fetchRepo,
  fetchTree,
  fetchViewer,
  randomRepos,
  searchRepos,
};
