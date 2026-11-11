'use strict';

/**
 * Spawned by the run engine (node core/prepare-tool.js <id>) so a runtime
 * install is an ordinary approved step: its output lands in the run log and a
 * failure gets the same headline treatment as any other command.
 */
const { prepareTool } = require('./runtime-install');

const id = String(process.argv[2] || '').trim();
if (!id) {
  console.log('usage: prepare-tool.js <tool id>');
  process.exit(2);
}

prepareTool(id, { onLine: (line) => console.log(line) })
  .then((result) => console.log(`installed ${result.id} -> ${result.dir}`))
  .catch((error) => {
    console.log(`error: ${error.message}`);
    process.exit(1);
  });
