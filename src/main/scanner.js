'use strict';
// The Epson V370 through probe/icprobe (Apple ImageCaptureCore + Epson's ICA driver).
//
// icprobe opens its own scanner session for each command, and two sessions fight over the device
// (errors -9925/-9926), so every command here runs one at a time. A scan is never killed: cancel()
// sends SIGINT, which icprobe turns into cancelScan + a clean session close. An Epson ICA session
// interrupted mid-scan can stay busy until the scanner is power-cycled.
//
// Mock mode (--mock) answers every command without the scanner and writes a synthetic gradient
// TIFF (ImageMagick) of the right size, so the UI can be built and tested with the scanner unplugged.
const { spawn, execFile } = require('node:child_process');
const tools = require('./tools');
const fs = require('node:fs');
const path = require('node:path');

const DRIVER_PLIST = '/Library/Image Capture/Devices/EPSON Scanner.app/Contents/Info';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function driverVersion() {
  return new Promise((resolve) => execFile('defaults', ['read', DRIVER_PLIST, 'CFBundleShortVersionString'],
    (err, out) => resolve(err ? null : String(out).trim())));
}

class Scanner {
  constructor({ probe, mock = false, mockSample = null }) {
    this.probe = probe;
    this.mock = mock;
    this.mockSample = mockSample;     // a real full-glass scan the mock "scans" for a prescan, so detection has something to find
    this.chain = Promise.resolve();
    this.current = null;        // running icprobe child
    this.busyWith = null;       // 'scan' | 'calibration' | null; calibration runs its own icprobe processes
    this.mockAbort = false;
  }

  get busy() { return !!this.busyWith; }

  withLock(fn) { const run = this.chain.then(fn, fn); this.chain = run.catch(() => {}); return run; }

  /** Run icprobe; resolves { code, json, lines }. Only short commands get a kill timeout, never scans. */
  run(args, { onLine = null, timeoutMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.probe)) return reject(new Error(`icprobe not built: run "npm run probe:build" (${this.probe})`));
      const child = spawn(this.probe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.current = child;
      let out = '', pending = '';
      const lines = [];
      const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => {
        pending += b;
        let i;
        while ((i = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, i); pending = pending.slice(i + 1);
          lines.push(line);
          if (onLine) onLine(line);
        }
      });
      child.on('error', (e) => { clearTimeout(timer); this.current = null; reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.current = null;
        let json = null;
        try { json = out.trim() ? JSON.parse(out) : null; } catch { /* reported by the caller */ }
        resolve({ code, json, lines });
      });
    });
  }

  async status() {
    if (this.busyWith) return { connected: true, busy: this.busyWith, mock: this.mock };
    if (this.mock) return { connected: true, mock: true, name: 'Mock V370', driver: 'mock' };
    return this.withLock(async () => {
      const [{ code, json }, driver] = await Promise.all([this.run(['list'], { timeoutMs: 30000 }), driverVersion()]);
      const devices = json?.devices || [];
      if (!driver) return { connected: false, driver: null, error: 'Epson ICA driver not installed' };
      if (!devices.length) return { connected: false, driver, error: code === 2 ? 'Scanner not found: is it plugged in and switched on?' : `icprobe exit ${code}` };
      return { connected: true, driver, name: devices[0].name };
    });
  }

  async caps() {
    if (this.mock) return { mock: true, functionalUnits: [{ type: 'flatbed', supportedBitDepths: [1, 8, 16], physicalSize: { w: 8.5, h: 11.7 }, nativeXResolution: 4800, preferredResolutions: [150, 300, 600, 1200, 2400, 4800], vendorFeatures: [] }] };
    if (this.busyWith) throw new Error(`The scanner is busy (${this.busyWith}).`);
    return this.withLock(async () => {
      const { code, json } = await this.run(['caps'], { timeoutMs: 60000 });
      if (!json) throw new Error(`Couldn't read the scanner's capabilities (icprobe exit ${code}).`);
      return { ...json, driver: await driverVersion() };
    });
  }

  /**
   * One scan into dir/name.tiff. area = { full: true } or { x, y, w, h } in inches from the glass corner.
   * Resolves { report, file, cancelled }. onProgress(pct) as the driver reports it.
   */
  scan({ dpi, bits, area, dir, name, onProgress = () => {}, onFile = () => {} }) {
    if (this.busyWith) return Promise.reject(new Error(`The scanner is busy (${this.busyWith}).`));
    this.busyWith = 'scan';
    const job = this.withLock(async () => {
      fs.mkdirSync(dir, { recursive: true });
      if (this.mock) return this.mockScan({ dpi, bits, area, dir, name, onProgress, onFile });
      const areaArg = area.full ? 'full' : [area.x || 0, area.y || 0, area.w, area.h].map((v) => Number(v).toFixed(5)).join(',');
      const { code, json, lines } = await this.run(
        ['scan', '--dpi', String(dpi), '--bits', String(bits), '--area', areaArg, '--out', dir, '--name', name],
        { onLine: (line) => {
          const m = /progress (\d+)%/.exec(line); if (m) onProgress(Number(m[1]));
          // The file is complete several seconds before icprobe exits (the head still has to drive home).
          const f = /^file: (.+)$/.exec(line); if (f && fs.existsSync(f[1])) onFile(f[1]);
        } });
      const report = json || {};
      const listed = (report.files || []).find((f) => fs.existsSync(f));
      const fallback = fs.readdirSync(dir).find((f) => f.startsWith(name) && /\.tiff?$/i.test(f));   // didScanToURL can fail to fire (macOS 15+)
      const file = listed || (fallback ? path.join(dir, fallback) : null);
      if (!file && !report.cancelled) {
        const why = report.scanError || report.error || lines.filter((l) => /error|fail|timed out/i.test(l)).pop() || `icprobe exit ${code}`;
        throw new Error(`Scan failed: ${why}`);
      }
      return { report, file, cancelled: !!report.cancelled };
    });
    return job.finally(() => { this.busyWith = null; });
  }

  cancel() {
    if (this.mock) { this.mockAbort = true; return true; }
    if (this.current && this.busyWith === 'scan') { this.current.kill('SIGINT'); return true; }
    return false;
  }

  async mockScan({ dpi, bits, area, dir, name, onProgress, onFile = () => {} }) {
    const wIn = area.full ? 8.5 : area.w, hIn = area.full ? 11.7 : area.h;
    const w = Math.round(wIn * dpi), h = Math.round(hIn * dpi);
    const seconds = Math.min(12, 1.5 + h * 0.0012);
    this.mockAbort = false;
    const t0 = Date.now();
    for (let p = 0; p <= 100; p += 10) {
      if (this.mockAbort) return { report: { cancelled: true }, file: null, cancelled: true };
      onProgress(p);
      await sleep((seconds * 1000) / 11);
    }
    const file = path.join(dir, `${name}.tiff`);
    const fromSample = area.full && this.mockSample && fs.existsSync(this.mockSample);
    await tools.run('magick', fromSample
      ? [this.mockSample, '-resize', `${w}x${h}!`, '-depth', String(bits), '-units', 'PixelsPerInch', '-density', String(dpi), '-compress', 'LZW', file]
      : ['-size', `${w}x${h}`, 'gradient:#0f3d38-#dff4f0', '-depth', String(bits), '-units', 'PixelsPerInch', '-density', String(dpi), '-compress', 'LZW', file]);
    onFile(file);                       // like the real scanner: the file is there before the head is home
    await sleep(1500);
    if (!fs.existsSync(file)) throw new Error('Scan failed: the scan file disappeared before the scanner finished');
    const accepted = { dpi, bitDepth: bits, pixelDataType: 2, scanArea: [0, 0, wIn, hIn], documentUTI: 'public.tiff', vendorFeatures: [] };
    return { report: { mock: true, requested: { dpi, bits }, accepted, scanSeconds: (Date.now() - t0) / 1000, files: [file], device: { name: 'Mock V370' } }, file, cancelled: false };
  }
}

module.exports = { Scanner, driverVersion };
