'use strict';
// Command-line tools ScanDeck calls (Homebrew: jpeg-xl, imagemagick; macOS: sips). An app started from
// Finder doesn't get the shell's PATH, so look in the usual places first.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', ...(process.env.PATH || '').split(':').filter(Boolean)];
const cache = new Map();

function tool(name) {
  if (name.includes('/')) return fs.existsSync(name) ? name : null;          // a path, e.g. probe/ovdetect
  if (!cache.has(name)) cache.set(name, DIRS.map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) || null);
  return cache.get(name);
}

/** Run a tool; rejects with its stderr. */
function run(name, args, opts = {}) {
  const bin = tool(name);
  if (!bin) return Promise.reject(new Error(`${name} not found (brew install ${name === 'cjxl' || name === 'djxl' ? 'jpeg-xl' : name === 'magick' ? 'imagemagick' : name})`));
  return new Promise((resolve, reject) => execFile(bin, args, { maxBuffer: 1 << 26, ...opts }, (err, stdout, stderr) => {
    if (err) reject(new Error(`${name}: ${String(stderr || err.message).trim().split('\n').pop()}`));
    else resolve(String(stdout));
  }));
}

module.exports = { tool, run };
