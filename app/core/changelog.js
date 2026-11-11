'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The product changelog, read the way the app and the release command both
 * need it: the newest entry only, split into its sections.
 *
 * CHANGELOG.md is the single source. The website reads site/releases.json for
 * the same version and notes, and `npm run release` refuses to prepare a
 * release while the two disagree.
 */

const CHANGELOG_FILE = path.join(__dirname, '..', 'CHANGELOG.md');
const PACKAGE_FILE = path.join(__dirname, '..', 'package.json');

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8')).version || '';
  } catch {
    return '';
  }
}

function read() {
  try {
    return fs.readFileSync(CHANGELOG_FILE, 'utf8');
  } catch {
    return '';
  }
}

/** Splits the changelog into `## [version] - date` blocks. */
function blocks(text) {
  const list = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const head = line.match(/^##\s+\[([^\]]+)\]\s*(?:-\s*(\S+))?\s*$/);
    if (head) {
      current = { version: head[1].trim(), date: (head[2] || '').trim(), lines: [] };
      list.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return list;
}

/** Groups one block's `### Heading` sections and their `- item` lines. */
function sectionsOf(lines) {
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1], items: [] };
      sections.push(current);
      continue;
    }
    const item = line.match(/^[-*]\s+(.+?)\s*$/);
    if (item && current) {
      current.items.push(item[1]);
      continue;
    }
    // A bullet in this file wraps onto indented lines; they belong to the same
    // item, otherwise the notes reach the interface cut in half.
    const continuation = line.match(/^\s{2,}(\S.*?)\s*$/);
    if (continuation && current && current.items.length) {
      current.items[current.items.length - 1] += ` ${continuation[1]}`;
    }
  }
  return sections.filter((section) => section.items.length);
}

/**
 * The entry for the version in package.json. A changelog that has not been
 * written yet returns the version with no sections, so the interface can say
 * plainly that there are no notes instead of inventing them.
 */
function latest() {
  const version = packageVersion();
  const block = blocks(read()).find((item) => item.version === version);
  if (!block) return { version, date: '', sections: [] };
  return { version, date: block.date, sections: sectionsOf(block.lines) };
}

module.exports = { blocks, latest, packageVersion, sectionsOf };
