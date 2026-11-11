'use strict';

const { execFile } = require('node:child_process');
const { resolveTool } = require('./tools');

/** Runs git with an argument array (never through a shell). */
function git(args, cwd, { timeout = 30000 } = {}) {
  const tool = resolveTool('git');
  return new Promise((resolve) => {
    execFile(
      tool.cmd,
      tool.args.concat(args),
      { cwd, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? (error ? 1 : 0),
          stdout: (stdout || '').trim(),
          stderr: (stderr || error?.message || '').trim(),
          failed: Boolean(error),
        });
      }
    );
  });
}

async function isGitRepo(dir) {
  const result = await git(['rev-parse', '--is-inside-work-tree'], dir, { timeout: 8000 });
  return !result.failed && result.stdout === 'true';
}

async function currentBranch(dir) {
  const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, { timeout: 8000 });
  return result.failed ? '' : result.stdout;
}

async function localHead(dir) {
  const result = await git(['rev-parse', 'HEAD'], dir, { timeout: 8000 });
  return result.failed ? '' : result.stdout;
}

/** SHA of the remote branch head, without touching the local working tree. */
async function remoteHead(dir) {
  const result = await git(['ls-remote', 'origin', 'HEAD'], dir, { timeout: 20000 });
  if (result.failed) return '';
  const first = result.stdout.split('\n')[0] || '';
  return first.split(/\s+/)[0] || '';
}

/** Fast-forward pull. Never creates a merge commit. */
async function pull(dir) {
  return git(['pull', '--ff-only'], dir, { timeout: 120000 });
}

module.exports = { currentBranch, git, isGitRepo, localHead, pull, remoteHead };
