'use strict';

const SUPPORTED_HOSTS = new Set(['github.com', 'www.github.com']);

/**
 * Parses a GitHub repository reference from the many shapes a user may paste.
 * Accepted: https://github.com/owner/repo(.git), with trailing path segments
 * (/tree/main, /issues, ...), the bare host form, git@github.com:owner/repo.git
 * and the GitHub CLI form owner/repo.
 *
 * Only github.com is accepted: the app clones from GitHub, nothing else.
 */
function parseRepoUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { ok: false, error: 'Paste the URL of a GitHub repository.' };
  }

  // Links copied out of a browser, a README or a chat reply almost always
  // carry tracking parameters or an anchor: strip them before parsing, because
  // "?utm_source=..." is part of the URL, never part of the repository name.
  const target = raw.replace(/[?#].*$/, '').replace(/\s+/g, '');

  let owner = '';
  let repo = '';

  const sshMatch = target.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const hostMatch = target.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  const shortMatch = target.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);

  if (sshMatch) {
    owner = sshMatch[1];
    repo = sshMatch[2];
  } else if (hostMatch) {
    const segments = hostMatch[1].split('/').filter(Boolean);
    if (segments.length < 2) {
      return { ok: false, error: 'The URL needs the format github.com/you/project.' };
    }
    owner = segments[0];
    repo = segments[1];
  } else if (shortMatch) {
    owner = shortMatch[1];
    repo = shortMatch[2];
  } else {
    return {
      ok: false,
      error: 'Invalid URL. Use a GitHub link, for example github.com/you/project.',
    };
  }

  repo = repo.replace(/\.git$/i, '');

  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return { ok: false, error: 'The URL contains characters that are not valid for an owner or a project name.' };
  }

  // owner/repo go straight into the request path, so a bare "." or ".." would
  // be resolved as a directory jump before it ever reaches GitHub.
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return { ok: false, error: 'The URL must point to github.com/you/project.' };
  }

  return {
    ok: true,
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/** Validates a directory name so a repository name is always filesystem-safe. */
function safeDirName(repo) {
  const cleaned = String(repo).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return cleaned || 'project';
}

/** Validates an npm script name before it reaches a command line. */
function isSafeScriptName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9:._-]{1,64}$/.test(name);
}

module.exports = { parseRepoUrl, safeDirName, isSafeScriptName, SUPPORTED_HOSTS };
