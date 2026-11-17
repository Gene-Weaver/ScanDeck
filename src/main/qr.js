'use strict';
// The QR code on the petiole label, and its clean copy on the archival image (2026-11-17).
//
// Reading: the archival detector's Barcode and Label boxes on the whole scan (the pass save.js already runs for the
// plant crop) say where the code may be (candidates()); the scan is cropped at each in turn, with a margin, and the
// crop goes to probe/qrtool (Vision) until one reads.
// A reader given the whole scan misses small codes; the crop is what makes them decode.
// Writing: when the code equals the leaf ID, a freshly generated code (Core Image, via qrtool) for the leaf ID and
// side (<ID>_t / <ID>_b), with that text below it, is laid onto the archival image below the ruler. Only the archival product
// gets it; the plant crop and the leaf are cut from the untouched pixels.
const fs = require('node:fs');
const fsp = fs.promises;
const { run } = require('./tools');

const TILE = { widthCm: 2, belowRulerCm: 2, fromEdgeCm: 1, quietModules: 2 };
const SCORES = { barcode: 0.15, ruler: 0.1 };
const FONTS = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc'];

/** The best box of one archival class ({ label, score, x1, y1, x2, y2 } in px), or null. */
function pick(boxes, label, min) {
  return (boxes || []).filter((b) => b.label === label && b.score >= min).sort((a, b) => b.score - a.score)[0] || null;
}

/**
 * Where the QR code may be, best guess first (at most 6): confident Barcode boxes; weak Barcode boxes lying on a Label
 * (the Barcode score swings with how the scan is framed: 0.5–0.7 on a tight scan, 0.04 on a full-width one, while
 * the Label box around the petiole label stays high); the Label boxes themselves; other weak Barcode boxes.
 * Each is { label, score, x1, y1, x2, y2, margin } with margin = how much to grow the crop, as a fraction of its long side.
 */
function candidates(boxes) {
  const by = (l, min) => (boxes || []).filter((b) => b.label === l && b.score >= min).sort((a, b) => b.score - a.score);
  const touch = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const barcodes = by('Barcode', 0.02), labels = by('Label', SCORES.barcode);
  const out = [];
  const add = (b, margin) => { if (!out.some((o) => o.x1 === b.x1 && o.y1 === b.y1 && o.label === b.label)) out.push({ ...b, margin }); };
  for (const b of barcodes) if (b.score >= SCORES.barcode) add(b, 0.6);
  for (const b of barcodes) if (labels.some((l) => touch(b, l))) add(b, 0.6);
  for (const l of labels) add(l, 0.15);
  for (const b of barcodes) if (b.score >= 0.05) add(b, 0.6);
  return out.slice(0, 6);
}

/** Top-left corner for a w × h px tile on a width × height px image at `dpi`: below the ruler, near the image edge the ruler is on. Null if it cannot go below the ruler. */
function place({ ruler, w, h, width, height, dpi }) {
  const cm = dpi / 2.54;
  if (w > width || h > height) return null;
  const onLeft = (ruler.x1 + ruler.x2) / 2 < width / 2;
  const x = Math.max(0, onLeft ? Math.round(TILE.fromEdgeCm * cm) : width - Math.round(TILE.fromEdgeCm * cm) - w);
  let y = Math.round(ruler.y2 + TILE.belowRulerCm * cm);
  if (y + h > height) y = height - h;                         // short image: as far below the ruler as it fits
  if (y < ruler.y2) return null;
  return { x, y };
}

/**
 * The ruler on the scan, in scan px: { score, x1, y1, x2, y2, from }. On the scan itself the detector often misses the
 * ruler (it fills too much of the frame), so the prescan's box is preferred: this side's own, else a confident box on
 * the scan, else the top side's mirrored (a bottom side scanned without a prescan), else a weak box on the scan.
 * `prescanRuler` = { score, cm: [x1, y1, x2, y2] on the glass, mirrored? }; `area` = the scan area in inches.
 */
function findRuler({ prescanRuler, area, boxes, dpi, width, height }) {
  let pre = null;
  if (prescanRuler?.cm && area) {
    const ox = area.full ? 0 : Number(area.x) || 0, oy = area.full ? 0 : Number(area.y) || 0, px = (cm, o) => (cm / 2.54 - o) * dpi;
    const [a, b, c, d] = prescanRuler.cm;
    const r = { score: prescanRuler.score, x1: Math.max(0, px(a, ox)), y1: Math.max(0, px(b, oy)), x2: Math.min(width, px(c, ox)), y2: Math.min(height, px(d, oy)) };
    if (r.x2 - r.x1 > 4 && r.y2 - r.y1 > 4) pre = { ...r, from: prescanRuler.mirrored ? 'top side prescan, mirrored' : 'prescan' };
  }
  const sure = pick(boxes, 'Ruler', 0.5), weak = pick(boxes, 'Ruler', SCORES.ruler);
  if (pre && !prescanRuler.mirrored) return pre;
  if (sure) return { ...sure, from: 'scan' };
  return pre || (weak ? { ...weak, from: 'scan (low score)' } : null);
}

class QR {
  constructor({ qrtool }) { this.qrtool = qrtool; }
  get ready() { return fs.existsSync(this.qrtool); }

  /** The modules of the QR code for `value`, for drawing it in the UI: { n, rows: ['1011…' × n] } (1 = dark). */
  async matrix(value, workDir) {
    this.cache ||= new Map();
    if (!this.cache.has(value)) {
      const raw = require('node:path').join(workDir, `qrmatrix_${process.pid}_${Date.now()}.png`);
      try {
        await run(this.qrtool, ['make', value, raw]);
        const pbm = (await run('magick', [raw, '-trim', '+repage', '-compress', 'none', 'pbm:-'])).replace(/#[^\n]*\n/g, '').trim().split(/\s+/);
        const n = Number(pbm[1]), bits = pbm.slice(3).join('');
        if (!(n > 0) || bits.length !== n * n) throw new Error('unexpected QR bitmap');
        this.cache.set(value, { n, rows: Array.from({ length: n }, (_, r) => bits.slice(r * n, (r + 1) * n)) });
      } finally { await fsp.rm(raw, { force: true }); }
    }
    return this.cache.get(value);
  }

  /** Read the QR code in or near `box` ({ x1, y1, x2, y2, margin? } px) of `image` (width × height px). Resolves the text, or null. */
  async read({ image, width, height, box, stem }) {
    const m = Math.max(box.x2 - box.x1, box.y2 - box.y1) * (box.margin ?? 0.6);
    const x = Math.max(0, Math.floor(box.x1 - m)), y = Math.max(0, Math.floor(box.y1 - m));
    const w = Math.min(width, Math.ceil(box.x2 + m)) - x, h = Math.min(height, Math.ceil(box.y2 + m)) - y;
    const full = `${stem}.qrfull.png`, crop = `${stem}.qrcrop.png`;
    try {
      await run('magick', [image, '-crop', `${w}x${h}+${x}+${y}`, '+repage', '-depth', '8', full]);      // the big image is read once
      for (const long of [900, 450, 1800]) {                 // Vision is happiest with a code a few hundred px across
        await run('magick', [full, '-resize', `${long}x${long}`, crop]);
        const out = JSON.parse(await run(this.qrtool, ['read', crop]));
        const value = out.codes?.[0]?.value;
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return null;
    } finally { await fsp.rm(full, { force: true }); await fsp.rm(crop, { force: true }); }
  }

  /**
   * The clean copy: a white tile TILE.widthCm wide at `dpi` with the QR code for `value` (quiet zone included in
   * the width) and `text` below it, sized to fit that width. Writes `${stem}.qrtile.png`; resolves { file, w, h }.
   */
  async tile({ value, text, dpi, stem }) {
    const raw = `${stem}.qrraw.png`, label = `${stem}.qrlabel.png`, file = `${stem}.qrtile.png`;
    try {
      await run(this.qrtool, ['make', value, raw]);
      const n = Number((await run('magick', [raw, '-trim', '+repage', '-format', '%w', 'info:'])).trim());
      const W = Math.round((TILE.widthCm / 2.54) * dpi);
      const mod = Math.floor(W / (n + 2 * TILE.quietModules));
      if (!(n > 0) || mod < 2) throw new Error('the resolution is too low for a readable QR code');
      const code = n * mod, quiet = Math.floor((W - code) / 2), font = FONTS.find((f) => fs.existsSync(f));
      await run('magick', ['-background', 'white', '-fill', 'black', ...(font ? ['-font', font] : []), '-size', `${code}x`, `label:${text}`, '-depth', '8', label]);
      const lh = Number((await run('magick', [label, '-format', '%h', 'info:'])).trim());
      const H = W + lh + Math.round(quiet / 2);
      await run('magick', ['-size', `${W}x${H}`, 'xc:white',
        '(', raw, '-trim', '+repage', '-filter', 'point', '-resize', `${code}x${code}`, ')', '-gravity', 'North', '-geometry', `+0+${quiet}`, '-composite',
        '(', label, ')', '-gravity', 'North', '-geometry', `+0+${W - Math.round(quiet / 2)}`, '-composite',
        '-alpha', 'off', '-colorspace', 'sRGB', '-type', 'TrueColor', '-depth', '8', `PNG24:${file}`]);
      return { file, w: W, h: H };
    } finally { await fsp.rm(raw, { force: true }); await fsp.rm(label, { force: true }); }
  }
}

module.exports = { QR, pick, place, findRuler, candidates, TILE, SCORES };
