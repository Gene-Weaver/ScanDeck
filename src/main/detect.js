'use strict';
// Auto scan area: find what is on the glass in the 150 dpi prescan, and scan only that.
//
// Two LeafMachine3 YOLO26n detectors (OpenVINO IR in src/models, run by probe/ovdetect with Homebrew's
// OpenVINO): plant material (leaves, flowers, fruit, …) and archival items (ruler, color card, label, …),
// 9 classes each. The capture area is the union of the boxes scoring at or above the threshold in the
// classes below, grown by the padding and kept on the glass. Leaf boxes can get their own padding first
// (leafPaddingCm): it widens the union, and the leaf segmenter is given the padded leaf box.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { run } = require('./tools');

const SIZE = 640;                                  // model input (letterboxed like Ultralytics: gray 114, centered)
const MODELS = [
  { key: 'plant', dir: 'plant_detector' },
  { key: 'archival', dir: 'archival_detector' },
];
// Classes that define the capture area (2026-11-12; Barcode added 2026-11-17 for the petiole label's QR code):
// every plant class, plus the ruler, barcode and text (Label) from the archival model. Color cards, envelopes, maps, photos, attached items and
// weights are still detected but don't widen the area.
const UNION_CLASSES = { plant: 'all', archival: ['Ruler', 'Barcode', 'Label'] };
const inUnion = (b, classes = UNION_CLASSES) => classes[b.model] === 'all' || (classes[b.model] || []).includes(b.label);
// Leaf padding (2026-11-17): the plant model's leaf boxes, the ones the leaf segmenter gets as crops.
const LEAF_CLASSES = ['Leaf_WHOLE', 'Leaf_PARTIAL'];
const isLeaf = (b) => b.model === 'plant' && LEAF_CLASSES.includes(b.label);
/** Leaf boxes grown by `pad` on every side (same unit as the boxes), kept inside 0..w × 0..h; other boxes unchanged. */
function padLeafBoxes(boxes, pad, { w, h }) {
  if (!(pad > 0)) return boxes;
  return boxes.map((b) => (isLeaf(b) ? { ...b, x1: Math.max(0, b.x1 - pad), y1: Math.max(0, b.y1 - pad), x2: Math.min(w, b.x2 + pad), y2: Math.min(h, b.y2 + pad) } : b));
}
/** A stored class choice ({ plant: [names], archival: [names] }) → what captureArea uses; a model left out keeps its default. */
function unionClasses(chosen) {
  const out = { ...UNION_CLASSES };
  for (const m of MODELS) if (Array.isArray(chosen?.[m.key])) out[m.key] = chosen[m.key].map(String);
  return out;
}

/** Class names from an Ultralytics metadata.yaml ("names:" block of "  <i>: <name>" lines). */
function readNames(file) {
  const names = {};
  let inNames = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^names:/.test(line)) { inNames = true; continue; }
    if (inNames) { const m = /^\s+(\d+):\s*(.+)$/.exec(line); if (m) names[m[1]] = m[2].trim(); else if (/^\S/.test(line)) break; }
  }
  return names;
}

function letterbox(w, h, size = SIZE) {
  const r = Math.min(size / w, size / h);
  const nw = Math.round(w * r), nh = Math.round(h * r);
  return { r, nw, nh, left: Math.max(0, Math.round((size - nw) / 2 - 0.1)), top: Math.max(0, Math.round((size - nh) / 2 - 0.1)) };
}

class Detector {
  constructor({ ovdetect, modelsDir }) {
    this.ovdetect = ovdetect;
    // Class names come from each model's metadata.yaml, read once it is there (models are fetched on first run: models.js).
    this.models = MODELS.map((m) => {
      const meta = path.join(modelsDir, m.dir, 'metadata.yaml');
      let names = null;
      return { ...m, xml: path.join(modelsDir, m.dir, 'best.xml'),
        get names() { if (!names && fs.existsSync(meta)) names = readNames(meta); return names || {}; } };
    });
  }

  /** Models and their class names, with the defaults ticked, for the class picker in Scan settings. */
  get classes() { return this.models.map((m) => { const names = Object.values(m.names); return { key: m.key, names, defaults: UNION_CLASSES[m.key] === 'all' ? names : UNION_CLASSES[m.key] }; }); }

  get ready() { return fs.existsSync(this.ovdetect) && this.models.every((m) => fs.existsSync(m.xml) && fs.existsSync(m.xml.replace(/\.xml$/, '.bin'))); }

  /**
   * Detections on an image of the whole glass at `dpi`; boxes in inches from the glass corner.
   * Returns { boxes: [{ model, cls, label, score, x1, y1, x2, y2 }], ms }.
   */
  async detect({ image, width, height, dpi, workDir }) {
    if (!this.ready) throw new Error('Detector missing: run "npm run ov:build" (needs brew install openvino)');
    const lb = letterbox(width, height);
    const raw = path.join(workDir, `${path.basename(image).replace(/\.\w+$/, '')}.640.rgb`);
    await run('magick', ['-size', `${SIZE}x${SIZE}`, 'xc:rgb(114,114,114)', '(', image, '-resize', `${lb.nw}x${lb.nh}!`, ')',
      '-geometry', `+${lb.left}+${lb.top}`, '-composite', '-depth', '8', `rgb:${raw}`]);
    let out;
    try { out = JSON.parse(await run(this.ovdetect, [raw, ...this.models.map((m) => m.xml)])); }
    finally { await fsp.rm(raw, { force: true }); }
    const boxes = [];
    const clampX = (v) => Math.min(Math.max(v, 0), width), clampY = (v) => Math.min(Math.max(v, 0), height);
    out.models.forEach((res, i) => {
      const m = this.models[i];
      for (const [x1, y1, x2, y2, score, cls] of res.dets) {
        const px = [clampX((x1 - lb.left) / lb.r), clampY((y1 - lb.top) / lb.r), clampX((x2 - lb.left) / lb.r), clampY((y2 - lb.top) / lb.r)];
        if (px[2] - px[0] < 1 || px[3] - px[1] < 1) continue;
        boxes.push({ model: m.key, cls, label: m.names[cls] ?? String(cls), score, x1: px[0] / dpi, y1: px[1] / dpi, x2: px[2] / dpi, y2: px[3] / dpi });
      }
    });
    return { boxes, ms: { load: out.models.reduce((s, x) => s + x.loadMs, 0), infer: out.models.reduce((s, x) => s + x.inferMs, 0) } };
  }
}

/**
 * The capture area: union of the boxes in UNION_CLASSES at or above `threshold`, padded by `paddingCm`,
 * kept on the glass. Leaf boxes are grown by `leafPaddingCm` before the union, so the union padding comes on top.
 * Returns { x, y, w, h } in inches (plus the boxes it used, leaf boxes padded), or null when nothing qualifies.
 */
function captureArea(boxes, { threshold = 0.15, paddingCm = 1, leafPaddingCm = 0, bed = { w: 8.5, h: 11.7 }, classes = UNION_CLASSES } = {}) {
  const used = padLeafBoxes(boxes.filter((b) => b.score >= threshold && inUnion(b, classes)), leafPaddingCm / 2.54, bed);
  if (!used.length) return null;
  const pad = paddingCm / 2.54;
  const x1 = Math.max(0, Math.min(...used.map((b) => b.x1)) - pad), y1 = Math.max(0, Math.min(...used.map((b) => b.y1)) - pad);
  const x2 = Math.min(bed.w, Math.max(...used.map((b) => b.x2)) + pad), y2 = Math.min(bed.h, Math.max(...used.map((b) => b.y2)) + pad);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, used };
}

module.exports = { Detector, captureArea, letterbox, readNames, unionClasses, padLeafBoxes, UNION_CLASSES, LEAF_CLASSES };
