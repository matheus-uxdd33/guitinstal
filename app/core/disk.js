'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Free space information for the drive that holds a given path.
 * Used to warn before an install fills the user's disk.
 */
function diskInfo(targetPath) {
  try {
    const existing = fs.existsSync(targetPath) ? targetPath : path.dirname(path.resolve(targetPath));
    const stats = fs.statfsSync(existing);
    const blockSize = stats.bsize || 4096;
    return {
      path: existing,
      freeMb: Math.floor((stats.bavail * blockSize) / (1024 * 1024)),
      totalMb: Math.floor((stats.blocks * blockSize) / (1024 * 1024)),
    };
  } catch {
    return { path: targetPath, freeMb: null, totalMb: null };
  }
}

const BLOCK = 300; // MB below which an install is refused
const WARN = 1024; // MB below which the plan carries a warning

/**
 * @returns {{level: 'ok'|'warn'|'block', freeMb: number|null, message: string}}
 */
function checkDiskSpace(targetPath) {
  const disk = diskInfo(targetPath);

  if (disk.freeMb === null) {
    return { level: 'ok', freeMb: null, message: '' };
  }
  if (disk.freeMb < BLOCK) {
    return {
      level: 'block',
      freeMb: disk.freeMb,
      message: `Only ${disk.freeMb} MB free on ${disk.path}. Free up space before installing: npm and Docker can download hundreds of megabytes.`,
    };
  }
  if (disk.freeMb < WARN) {
    return {
      level: 'warn',
      freeMb: disk.freeMb,
      message: `Only ${disk.freeMb} MB free on ${disk.path}. The install may fill the disk.`,
    };
  }
  return { level: 'ok', freeMb: disk.freeMb, message: '' };
}

module.exports = { checkDiskSpace, diskInfo };
