'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { defaultWorkspace, ensureDir, userDataDir } = require('./paths');
const secrets = require('./secret-store');

const DEFAULTS = Object.freeze({
  workspace: defaultWorkspace(),
  githubToken: '',
  githubUser: '',
  githubAvatar: '',
  githubScope: '',
  githubCheckedAt: '',
  theme: 'dark',
  shallowClone: true,
  autoApproveLowRisk: false,
  confirmBeforeRemove: true,
});

// config.json must never hold the token. It lives in the operating system's
// protected store and, between reads, in this process's memory only.
let tokenCache = null;
let tokenNote = '';
let plainTokenSwept = false;

function currentToken() {
  if (tokenCache === null) {
    const result = secrets.load();
    tokenCache = result.token;
    tokenNote = result.detail;
  }
  return tokenCache;
}

/**
 * Versions before 1.0 wrote the token straight into config.json. The first read
 * moves it into protected storage and rewrites the file without it.
 */
function sweepPlainToken(value) {
  if (plainTokenSwept) return;
  plainTokenSwept = true;
  const stored = secrets.save(value);
  if (stored.stored) {
    tokenCache = value;
  } else {
    tokenNote = stored.detail;
    if (!tokenCache) tokenCache = value;
  }
  const { githubToken, ...rest } = readJson(configPath(), {});
  writeJson(configPath(), rest);
}

function tokenStatus() {
  const storage = secrets.describe();
  return {
    set: Boolean(currentToken()),
    engine: storage.engine,
    label: storage.label,
    path: storage.path,
    note: tokenNote,
  };
}

function configPath() {
  return path.join(ensureDir(userDataDir()), 'config.json');
}

function projectsPath() {
  return path.join(ensureDir(userDataDir()), 'projects.json');
}

function libraryPath() {
  return path.join(ensureDir(userDataDir()), 'library.sqlite');
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function getSettings() {
  const stored = readJson(configPath(), {});
  const { githubToken, ...rest } = stored;
  if (githubToken) sweepPlainToken(String(githubToken).trim());
  return { ...DEFAULTS, ...rest, githubToken: currentToken() };
}

function updateSettings(patch = {}) {
  const current = getSettings();
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    if (typeof value !== typeof DEFAULTS[key]) continue;
    if (key === 'workspace') {
      next.workspace = path.resolve(String(value));
      ensureDir(next.workspace);
    } else if (key === 'githubToken') {
      const value2 = String(value).trim();
      const result = secrets.save(value2);
      tokenCache = value2 || '';
      tokenNote = result.detail;
      next.githubToken = value2;
    } else {
      next[key] = value;
    }
  }
  const { githubToken, ...onDisk } = next;
  writeJson(configPath(), onDisk);
  return next;
}

function publicSettings(settings = getSettings()) {
  const { githubToken, ...rest } = settings;
  return { ...rest, githubTokenSet: Boolean(githubToken), tokenHint: githubToken ? `••••${githubToken.slice(-4)}` : '' };
}

let database = null;

function projectValues(project) {
  return {
    id: project.id,
    name: project.name || project.repo || project.id,
    fullName: project.fullName || project.name || project.id,
    directory: project.dir || '',
    status: project.status || 'installed',
    installedAt: project.installedAt || project.updatedAt || new Date().toISOString(),
    updatedAt: project.updatedAt || project.installedAt || new Date().toISOString(),
    payload: JSON.stringify(project),
  };
}

function insertProject(db, project) {
  const item = projectValues(project);
  db.prepare(`
    INSERT INTO projects (id, name, full_name, directory, status, installed_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      full_name = excluded.full_name,
      directory = excluded.directory,
      status = excluded.status,
      installed_at = excluded.installed_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    item.id,
    item.name,
    item.fullName,
    item.directory,
    item.status,
    item.installedAt,
    item.updatedAt,
    item.payload
  );
}

function migrateJsonRegistry(db) {
  const done = db.prepare("SELECT value FROM library_meta WHERE key = 'json_migrated'").get();
  if (done) return;
  const legacy = readJson(projectsPath(), []);
  const already = db.prepare('SELECT 1 FROM projects WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Array.isArray(legacy)) {
      for (const project of legacy) {
        // A record already in SQLite wins: the import must never replace newer
        // data with the copy that sat in the old registry file.
        if (project?.id && !already.get(project.id)) insertProject(db, project);
      }
    }
    db.prepare("INSERT INTO library_meta (key, value) VALUES ('json_migrated', ?)").run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getDatabase() {
  if (database) return database;
  database = new DatabaseSync(libraryPath());
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      directory TEXT NOT NULL,
      status TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_updated_at ON projects(updated_at DESC);
    CREATE TABLE IF NOT EXISTS library_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      full_name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      stars INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repo_stats (
      full_name TEXT NOT NULL,
      stars INTEGER NOT NULL,
      forks INTEGER NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS repo_stats_lookup ON repo_stats(full_name, captured_at DESC);
  `);
  migrateJsonRegistry(database);
  return database;
}

function decodeProject(row) {
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

function listProjects() {
  return getDatabase()
    .prepare('SELECT payload FROM projects ORDER BY updated_at DESC, installed_at DESC, rowid DESC')
    .all()
    .map(decodeProject)
    .filter(Boolean);
}

function getProject(id) {
  const row = getDatabase().prepare('SELECT payload FROM projects WHERE id = ?').get(id);
  return row ? decodeProject(row) : null;
}

function upsertProject(project) {
  const previous = getProject(project.id);
  const next = previous ? { ...previous, ...project } : project;
  insertProject(getDatabase(), next);
  return next;
}

function removeProject(id) {
  return getDatabase().prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

function libraryStatus() {
  const db = getDatabase();
  return {
    engine: 'SQLite',
    path: libraryPath(),
    projects: db.prepare('SELECT COUNT(*) AS count FROM projects').get().count,
    legacyBackup: fs.existsSync(projectsPath()) ? projectsPath() : '',
  };
}

/* ------------------------------------------------------------------ */
/* favourites and popularity history                                   */
/* ------------------------------------------------------------------ */

function listFavorites() {
  return getDatabase()
    .prepare('SELECT * FROM favorites ORDER BY added_at DESC')
    .all()
    .map((row) => ({
      fullName: row.full_name,
      owner: row.owner,
      name: row.name,
      url: row.url,
      description: row.description,
      language: row.language,
      avatarUrl: row.avatar_url,
      stars: row.stars,
      addedAt: row.added_at,
    }));
}

function addFavorite(repo) {
  getDatabase()
    .prepare(`
      INSERT INTO favorites (full_name, owner, name, url, description, language, avatar_url, stars, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(full_name) DO UPDATE SET
        stars = excluded.stars,
        description = excluded.description,
        avatar_url = excluded.avatar_url
    `)
    .run(
      repo.fullName,
      repo.owner || '',
      repo.name || '',
      repo.url || `https://github.com/${repo.fullName}`,
      repo.description || '',
      repo.language || '',
      repo.avatarUrl || repo.ownerAvatar || '',
      Number(repo.stars) || 0,
      new Date().toISOString()
    );
  return listFavorites().find((item) => item.fullName === repo.fullName);
}

function removeFavorite(fullName) {
  return getDatabase().prepare('DELETE FROM favorites WHERE full_name = ?').run(fullName).changes > 0;
}

/**
 * Stores the metrics seen for a search page. "Trending" is a claim about
 * change, so it can only be made from two of these snapshots; the first visit
 * to the app can honestly say Popular, nothing more.
 */
function recordRepoStats(items) {
  const db = getDatabase();
  const insert = db.prepare('INSERT INTO repo_stats (full_name, stars, forks, captured_at) VALUES (?, ?, ?, ?)');
  const now = new Date().toISOString();
  for (const item of items || []) {
    if (!item?.fullName) continue;
    insert.run(item.fullName, Number(item.stars) || 0, Number(item.forks) || 0, now);
  }
  // One week of history is enough to judge growth, and the table must not grow
  // forever on a machine that browses daily.
  db.prepare('DELETE FROM repo_stats WHERE captured_at < ?').run(new Date(Date.now() - 7 * 86400000).toISOString());
}

/**
 * Star growth between the first and the last time THIS machine saw a
 * repository. "Trending" is a claim about change, so it needs both ends of a
 * period; one sighting proves nothing and is reported as Popular.
 */
function growthByRepo(limit = 60) {
  const db = getDatabase();
  const groups = db
    .prepare(
      `
    SELECT full_name AS fullName, COUNT(*) AS samples,
           MIN(captured_at) AS firstAt, MAX(captured_at) AS lastAt
    FROM repo_stats GROUP BY full_name
    ORDER BY lastAt DESC LIMIT ?
    `
    )
    .all(limit);
  const starAt = db.prepare('SELECT stars FROM repo_stats WHERE full_name = ? AND captured_at = ? LIMIT 1');
  return groups
    .filter((group) => group.samples >= 2)
    .map((group) => {
      const before = starAt.get(group.fullName, group.firstAt)?.stars ?? 0;
      const after = starAt.get(group.fullName, group.lastAt)?.stars ?? 0;
      return {
        fullName: group.fullName,
        growth: after - before,
        stars: after,
        samples: group.samples,
        spanHours: (Date.parse(group.lastAt) - Date.parse(group.firstAt)) / 3600000,
      };
    });
}

module.exports = {
  DEFAULTS,
  addFavorite,
  getProject,
  getSettings,
  growthByRepo,
  listFavorites,
  recordRepoStats,
  removeFavorite,
  tokenStatus,
  libraryStatus,
  listProjects,
  publicSettings,
  removeProject,
  updateSettings,
  upsertProject,
};
