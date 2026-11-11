'use strict';

/**
 * Prints what the engine is, what it covers and what it still owes.
 *
 * The report is built from the configuration and from the running application,
 * so it cannot claim more than the code does. When the catalog and the app
 * disagree, the disagreement is printed as a problem instead of being hidden.
 *
 *   node tools/engine-report.js            print the report
 *   node tools/engine-report.js --write    also write it to Reports/
 */

const fs = require('node:fs');
const path = require('node:path');

const engine = require('../core/engine');
const catalog = require('../core/engine/catalog');
const compatibility = require('../core/engine/compatibility');
const policy = require('../core/engine/policy');
const projectType = require('../core/engine/project-type');
const workflow = require('../core/engine/workflow');

const MARKS = { implemented: 'x', partial: '~', planned: '.', catalogued: '.', external: '-' };

function line(char = '-', count = 78) {
  return char.repeat(count);
}

function table(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[index] ?? '').length))
  );
  const render = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ');
  return [render(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(render)].join('\n');
}

function buildReport() {
  const summary = engine.summary();
  const context = compatibility.currentPlatform();
  const lines = [];

  lines.push(`# GUITinstal Universal Engine - configuration report`);
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Engine: ${summary.engine} ${summary.version}`);
  lines.push(`- Catalog digest: \`${summary.digest}\``);
  lines.push(`- Platform: ${context.platform} ${context.arch}`);
  lines.push('');

  lines.push('## Coverage');
  lines.push('');
  lines.push(
    table(
      ['Area', 'Total', 'Implemented', 'Partial', 'Planned'],
      [
        [
          'Runtime catalog',
          summary.runtimes.total,
          summary.runtimes.implemented,
          summary.runtimes.catalogued,
          summary.runtimes.external,
        ],
        ['Workflow steps', summary.workflow.total, summary.workflow.implemented, summary.workflow.partial, summary.workflow.planned],
        ['Engine modules', summary.modules.total, summary.modules.implemented, summary.modules.partial, summary.modules.planned],
        ['Security rules', summary.security.total, summary.security.implemented, 0, summary.security.open],
      ]
    )
  );
  lines.push('');

  lines.push('## Runtime catalog');
  lines.push('');
  lines.push(
    table(
      ['Runtime', 'Ecosystem', 'Mode', 'Status', 'Win x64', 'Win arm64', 'Linux x64', 'macOS arm64'],
      catalog.runtimes().map((item) => [
        item.label,
        item.ecosystem,
        item.installMode,
        item.status,
        item.platforms?.win32?.x64 || '-',
        item.platforms?.win32?.arm64 || '-',
        item.platforms?.linux?.x64 || '-',
        item.platforms?.darwin?.arm64 || '-',
      ])
    )
  );
  lines.push('');
  lines.push('Mode: managed = GUITstal downloads and verifies it. guided = the official page, installed by hand.');
  lines.push('bundled = it arrives with another runtime. builtin = it is part of one.');
  lines.push('');

  lines.push('## Workflow');
  lines.push('');
  lines.push(
    table(
      ['#', 'Step', 'Owner', 'Status', 'Note'],
      workflow.steps().map((item) => [item.order, item.title, item.owner, item.status, item.note])
    )
  );
  lines.push('');

  lines.push('## Engine modules');
  lines.push('');
  lines.push(
    table(
      ['Module', 'Owner', 'Status', 'Note'],
      workflow.modules().map((item) => [item.label, item.owner, item.status, item.note])
    )
  );
  lines.push('');

  lines.push('## Project categories');
  lines.push('');
  lines.push(
    table(
      ['Category', 'Launch model', 'Actions'],
      Object.entries(projectType.TYPES).map(([id, item]) => [item.label, item.launchModel, item.actions.join(', ')])
    )
  );
  lines.push('');

  lines.push('## Security rules');
  lines.push('');
  lines.push(
    table(
      ['Rule', 'Enforced by', 'Status', 'Detail'],
      policy.security().map((item) => [item.rule, item.enforcedBy, item.status, item.detail])
    )
  );
  lines.push('');

  lines.push('## Platforms');
  lines.push('');
  lines.push(
    table(
      ['Platform', 'Status', 'Installer', 'Detail'],
      policy.platforms().map((item) => [item.label, item.status, item.installer || '-', item.detail])
    )
  );
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const problems = [];
  const catalogResult = engine.validate();
  problems.push(...catalogResult.problems);

  const live = await engine.validateLive();
  problems.push(...live.problems);

  const report = buildReport();
  console.log(report);

  console.log(line('='));
  if (problems.length) {
    console.log(`${problems.length} problems found:`);
    for (const item of problems) {
      console.log(`  [${item.level}] ${item.id}: ${item.message}`);
    }
  } else {
    console.log('No problems found: the catalog and the application agree.');
  }

  if (process.argv.includes('--write')) {
    const folder = path.join(__dirname, '..', '..', 'Reports');
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.join(folder, `ENGINE-REPORT-${stamp}.md`);
    const body = `${report}\n\n---\n\n## Problems\n\n${
      problems.length
        ? problems.map((item) => `- **[${item.level}]** \`${item.id}\`: ${item.message}`).join('\n')
        : 'None. The catalog and the application agree.'
    }\n`;
    fs.writeFileSync(file, body, 'utf8');
    console.log('');
    console.log(`Report written to ${file}`);
  }

  const errors = problems.filter((item) => item.level === 'error');
  process.exit(errors.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
