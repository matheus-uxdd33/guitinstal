'use strict';

/**
 * Copies the inline SVG symbol library from index.html into download.html so
 * both pages share one icon set. Run after editing icons.
 */

const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const source = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const targetFile = path.join(dir, 'download.html');

const match = source.match(/<svg class="svg-library"[\s\S]*?<\/svg>/);
if (!match) {
  console.error('index.html nao tem o bloco <svg class="svg-library">');
  process.exit(1);
}

const target = fs.readFileSync(targetFile, 'utf8');
if (!target.includes('<!--ICONS-->')) {
  console.error('download.html perdeu a marca <!--ICONS-->');
  process.exit(1);
}

fs.writeFileSync(targetFile, target.replace('<!--ICONS-->', match[0]));
console.log(`simbolos copiados para download.html (${match[0].length} chars)`);
