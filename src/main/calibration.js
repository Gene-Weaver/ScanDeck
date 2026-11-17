'use strict';
// Calibration = validation runs: validation/run_validation_tests.mjs scans a dpi × bit-depth grid over
// one area and writes each run to <outRoot>/<yyyy-mm-dd_HHMMSS>_<area>/ with summary.json and previews.
// The app lists those runs for the gallery and can start a new one. The runner is a plain Node script,
// started here with Electron's own Node (ELECTRON_RUN_AS_NODE), so it also works from a terminal.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

function listRuns(outRoot) {
  let dirs = [];
  try { dirs = fs.readdirSync(outRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const runs = [];
  for (const name of dirs) {
    const dir = path.join(outRoot, name);
    try {
      const { meta, results } = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
      let compression = null;
      try { compression = JSON.parse(fs.readFileSync(path.join(dir, 'compression.json'), 'utf8')); } catch { /* not tested */ }
      runs.push({
        id: name, dir, meta, results, compression,
        ok: results.filter((r) => r.status === 'OK').length, total: results.length,
        finished: !!meta.finished,
      });
    } catch { /* not a run folder, or a run that never got to its first summary */ }
  }
  return runs.sort((a, b) => b.id.localeCompare(a.id));
}

/** CLI value for the runner's --area option. */
function areaArg(area) {
  if (!area || area.mode === 'full') return 'full';
  const w = Number(area.wCm) || 10, h = Number(area.hCm) || w;
  return w === h ? `${w}cm` : `${w}x${h}cm`;
}

class Calibration {
  constructor({ runner, compressor, outRoot, scanner }) {
    this.runner = runner;
    this.compressor = compressor;
    this.compressChild = null;
    this.outRoot = outRoot;
    this.scanner = scanner;
    this.child = null;
    this.stopping = false;
  }

  get running() { return !!this.child; }

  runs() { return listRuns(this.outRoot); }

  /** Lossless-format test on a run's 1200 dpi 16-bit scan (validation/compression_test.mjs). No scanner needed. */
  compress(id, { onLine, onExit }) {
    if (this.compressChild) throw new Error('A compression test is already running.');
    if (!/^[\w.-]+$/.test(id) || !fs.existsSync(path.join(this.outRoot, id, 'scan_1200dpi_16bit.tiff'))) throw new Error('This run has no 1200 dpi 16-bit scan.');
    const child = spawn(process.execPath, [this.compressor, '--run', id], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.compressChild = child;
    const lines = (b) => String(b).split('\n').filter(Boolean).forEach(onLine);
    child.stdout.on('data', lines); child.stderr.on('data', lines);
    child.on('close', (code) => { this.compressChild = null; onExit({ code, id }); });
    return { started: true };
  }

  start({ area, dpis, bits, corrections = true, compression = true, mock }, { onLine, onExit }) {
    if (this.child) throw new Error('A calibration run is already going.');
    if (this.scanner.busy) throw new Error(`The scanner is busy (${this.scanner.busyWith}).`);
    if (mock) throw new Error('Calibration scans need the real scanner (turn off mock mode).');
    const args = [this.runner, '--area', areaArg(area), '--dpi', dpis.join(','), '--bits', bits.join(','), '--out', this.outRoot];
    if (!corrections) args.push('--no-corrections');
    if (!compression) args.push('--no-compression');
    this.scanner.busyWith = 'calibration';
    this.stopping = false;
    const child = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let pending = '';
    const feed = (b) => {
      pending += b;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) { onLine(pending.slice(0, i)); pending = pending.slice(i + 1); }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('close', (code) => {
      if (pending) onLine(pending);
      this.child = null;
      this.scanner.busyWith = null;
      onExit({ code, stopped: this.stopping });
    });
    return { started: true, args: args.slice(1) };
  }

  /** The runner finishes the scan in progress, then stops (its own Ctrl-C handling). */
  stop() {
    if (!this.child) return false;
    this.stopping = true;
    this.child.kill('SIGINT');
    return true;
  }
}

/** Remove a run folder (to the Trash when a trash function is given). */
async function removeRun(outRoot, id, trash) {
  const dir = path.join(outRoot, id);
  if (path.dirname(dir) !== path.resolve(outRoot) || !fs.existsSync(path.join(dir, 'summary.json'))) throw new Error(`Not a calibration run: ${id}`);
  if (trash) await trash(dir); else await fsp.rm(dir, { recursive: true });
}

module.exports = { Calibration, listRuns, areaArg, removeRun };
