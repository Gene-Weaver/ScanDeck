'use strict';
// Color-fringing check, run on every scan so a bad one can be retaken right away.
//
// The V370's red, green and blue sensor lines sit a few rows apart; the driver re-aligns them assuming the
// head moves steadily. Where the head stutters they land out of register and horizontal edges turn into
// red/green/purple stripes. For every band of rows this measures how far red and blue sit above or below
// green (cross-correlating vertical gradients, sub-pixel), converts it to µm on the leaf, and compares it with
// the scan's own median. Measured 2026-11-12: good scans 6–8 µm RMS with ≤ 3 bad bands; stuttered scans
// 32–64 µm RMS with 15–68 bad bands.
const { execFile } = require('node:child_process');
const { tool } = require('./tools');

const BAND = 24;           // rows per band
const K = 4;               // largest shift tried, in rows
const MAX_COLS = 1000;     // columns are subsampled (shifts are vertical, so rows stay at full resolution)
const BAD_UM = 15;         // a band this far off its scan's median is a fringe
const MIN_ENERGY = 2;      // mean squared vertical gradient per pixel for a band to count (skip empty glass)

function readRgb(file, w, h) {
  const cols = Math.min(w, MAX_COLS);
  return new Promise((resolve, reject) => execFile(tool('magick'), [file, '-sample', `${cols}x${h}!`, '-depth', '8', 'rgb:-'],
    { encoding: 'buffer', maxBuffer: cols * h * 3 + 1024 }, (err, out) => (err ? reject(err) : resolve({ buf: out, cols }))));
}

/** Per-band vertical shift of red and blue relative to green, in rows (+ = lower). Pure; exported for tests. */
function bandShifts(buf, w, h) {
  const n = h - 1;
  const grad = (c) => {
    const d = new Float32Array(n * w);
    for (let y = 0; y < n; y++) for (let x = 0; x < w; x++) d[y * w + x] = buf[((y + 1) * w + x) * 3 + c] - buf[(y * w + x) * 3 + c];
    return d;
  };
  const dR = grad(0), dG = grad(1), dB = grad(2);
  const rows = n - 2 * K, nb = Math.floor(rows / BAND);
  const shiftsFor = (dC) => {
    const out = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      const c = new Float64Array(2 * K + 1);
      for (let r = b * BAND; r < (b + 1) * BAND; r++) {
        const g = (r + K) * w;
        for (let k = -K; k <= K; k++) {
          const o = (r + K + k) * w;
          let s = 0;
          for (let x = 0; x < w; x++) s += dG[g + x] * dC[o + x];
          c[k + K] += s;
        }
      }
      let best = 0;
      for (let i = 1; i < c.length; i++) if (c[i] > c[best]) best = i;
      let frac = 0;
      if (best > 0 && best < 2 * K) { const den = c[best - 1] - 2 * c[best] + c[best + 1]; if (den) frac = (0.5 * (c[best - 1] - c[best + 1])) / den; }
      out[b] = best - K + frac;
    }
    return out;
  };
  const energy = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let r = b * BAND; r < (b + 1) * BAND; r++) { const g = (r + K) * w; for (let x = 0; x < w; x++) s += dG[g + x] * dG[g + x]; }
    energy[b] = s / (BAND * w);
  }
  return { r: shiftsFor(dR), b: shiftsFor(dB), energy, nb };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Verdict from band shifts: ok, warn (a few bad bands) or bad (retake), with where the bad rows are. */
function judge({ r, b, energy, nb }, { dpi, height }) {
  const idx = [...Array(nb).keys()].filter((i) => energy[i] >= MIN_ENERGY);
  if (idx.length < 10) return { verdict: 'unknown', reason: 'too little detail to measure', bands: nb };
  const mr = median(idx.map((i) => r[i])), mb = median(idx.map((i) => b[i]));
  const um = (i) => Math.hypot(r[i] - mr, b[i] - mb) / dpi * 25400;
  const devs = idx.map((i) => ({ i, um: um(i) }));
  const bad = devs.filter((d) => d.um > BAD_UM);
  const rms = Math.sqrt(devs.reduce((s, d) => s + d.um * d.um, 0) / devs.length);
  const worst = Math.max(...devs.map((d) => d.um));
  // merge bad bands into row ranges (fractions of the image height, for drawing; mm from the scan's top edge)
  const ranges = [];
  for (const d of bad) {
    const y0 = d.i * BAND + K, y1 = y0 + BAND;
    const last = ranges[ranges.length - 1];
    if (last && y0 - last.y1 <= BAND * 2) last.y1 = y1; else ranges.push({ y0, y1 });
  }
  const frac = bad.length / devs.length;
  const verdict = rms > 15 || (bad.length >= 6 && frac >= 0.02) ? 'bad' : bad.length >= 3 ? 'warn' : 'ok';
  return {
    verdict, rmsUm: +rms.toFixed(1), worstUm: Math.round(worst), badBands: bad.length, bands: devs.length,
    ranges: ranges.map(({ y0, y1 }) => ({ from: +(y0 / height).toFixed(4), to: +(y1 / height).toFixed(4), mm: [+(y0 / dpi * 25.4).toFixed(1), +(y1 / dpi * 25.4).toFixed(1)] })),
  };
}

async function checkFringe(file, { width, height, dpi }) {
  const t0 = Date.now();
  const { buf, cols } = await readRgb(file, width, height);
  const res = judge(bandShifts(buf, cols, height), { dpi, height });
  return { ...res, ms: Date.now() - t0 };
}

module.exports = { checkFringe, bandShifts, judge };
