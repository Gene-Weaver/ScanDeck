'use strict';
// The plant crop (<ID>_tp) and the segmented product (<ID>_tl): the plant crop with everything that is not leaf painted
// black (0, 0, 0). "The scan" below is whatever image mask() is given; save.js gives it the plant crop.
//
// LeafMachine3's leaf segmenter (YOLO26x-seg, OpenVINO IR in src/models/leaf_segmenter, run by probe/ovseg)
// works on single-leaf crops, 1024 px letterboxed, and returns Leaf, Petiole and Hole instances. Like
// LeafMachine3, the crops are the plant detector's Leaf_WHOLE / Leaf_PARTIAL boxes, found here on the scan
// itself (so it works for every area mode and both sides). The mask keeps Leaf (and Petiole, if that is switched on)
// and blacks out the background and the Holes. With no leaf box, the whole scan is segmented as one crop.
//
// Everything runs on a working copy of the scan no larger than WORK_PX on its long side; the finished mask
// is scaled back up to the scan by the caller (save.js), which applies it to the original pixels.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { run } = require('./tools');
const { letterbox, padLeafBoxes, LEAF_CLASSES } = require('./detect');

const SIZE = 1024;                  // segmenter input
const WORK_PX = 4096;               // working copy: long side at most this (a leaf crop is shrunk to 1024 anyway)
// maskScore = LeafMachine3's conf for this model. pad = margin around a leaf box as a fraction of its size, used
// when no leaf padding is set; leafPaddingCm > 0 (Scan settings) replaces it with that many cm on every side.
// petiole: keep Petiole instances too (Scan settings, off by default since 2026-11-17: the leaf is the blade only).
const DEFAULTS = { leafScore: 0.25, maskScore: 0.3, pad: 0.06, leafPaddingCm: 0, petiole: false };
const CLASS_NAMES = ['Leaf', 'Petiole', 'Hole'];

class Segmenter {
  constructor({ ovseg, modelsDir, detector }) {
    this.ovseg = ovseg;
    this.xml = path.join(modelsDir, 'leaf_segmenter', 'best.xml');
    this.detector = detector;
  }

  /** The plant crop needs only the detector. */
  get plantReady() { return this.detector.ready; }

  /**
   * Where the plant is on a scan: the union of the plant model's boxes (classes in `opts.classes`, 'all' or a list of
   * names) scoring at least `opts.threshold`, leaf boxes first grown by `opts.leafPaddingCm`, the union grown by
   * `opts.paddingCm`, kept on the scan. `image` is width × height px
   * at `dpi`. Resolves { box: [x, y, w, h] px, from, used: [{ label, score }], archival: [boxes in px] }; the whole scan when nothing is found.
   */
  async plantBox({ image, width, height, dpi, workDir, opts = {} }) {
    const o = { threshold: 0.15, paddingCm: 1, leafPaddingCm: 0, classes: 'all', ...opts };
    const det = await this.detector.detect({ image, width, height, dpi: 1, workDir });     // dpi 1 → boxes in pixels
    const used = padLeafBoxes(det.boxes.filter((b) => b.model === 'plant' && b.score >= o.threshold && (o.classes === 'all' || o.classes.includes(b.label))),
      ((Number(o.leafPaddingCm) || 0) / 2.54) * dpi, { w: width, h: height });
    // The archival boxes of the same pass (px), for the label's QR code and the ruler (qr.js): no second detection.
    const archival = det.boxes.filter((b) => b.model === 'archival').map((b) => ({ label: b.label, score: b.score, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }));
    if (!used.length) return { box: [0, 0, width, height], from: 'whole scan (no plant box)', used: [], archival };
    const pad = (o.paddingCm / 2.54) * dpi;
    const x1 = Math.max(0, Math.floor(Math.min(...used.map((b) => b.x1)) - pad)), y1 = Math.max(0, Math.floor(Math.min(...used.map((b) => b.y1)) - pad));
    const x2 = Math.min(width, Math.ceil(Math.max(...used.map((b) => b.x2)) + pad)), y2 = Math.min(height, Math.ceil(Math.max(...used.map((b) => b.y2)) + pad));
    return { box: [x1, y1, x2 - x1, y2 - y1], from: 'union of plant boxes', used: used.map((b) => ({ label: b.label, score: +b.score.toFixed(3) })), archival };
  }

  get ready() { return fs.existsSync(this.ovseg) && fs.existsSync(this.xml) && fs.existsSync(this.xml.replace(/\.xml$/, '.bin')) && this.detector.ready; }

  /**
   * Leaf mask for a scan. `image` is anything ImageMagick reads (the driver's TIFF or a PPM), width × height px at `dpi`
   * (needed only for `opts.leafPaddingCm`: each leaf box is grown by that much before it is cropped for the segmenter).
   * Writes `${stem}.mask.png` (8-bit, white = keep, at working size) and resolves
   * { mask, crops: [{ box: [x, y, w, h] in scan px, from, instances: { Leaf, Petiole, Hole } }], keptFraction, ms }.
   */
  async mask({ image, width, height, dpi, stem, opts = {} }) {
    if (!this.ready) throw new Error('Segmenter missing: run "npm run ov:build" (needs brew install openvino) and check src/models/leaf_segmenter');
    const o = { ...DEFAULTS, ...opts };
    const t0 = Date.now();
    const scale = Math.min(1, WORK_PX / Math.max(width, height));
    const ww = Math.max(1, Math.round(width * scale)), wh = Math.max(1, Math.round(height * scale));
    const leafPadPx = dpi > 0 && Number(o.leafPaddingCm) > 0 ? (Number(o.leafPaddingCm) / 2.54) * dpi * scale : 0;   // in working pixels
    const work = `${stem}.work.ppm`, mask = `${stem}.mask.png`;
    const temps = [work];
    try {
      await run('magick', [image, '-resize', `${ww}x${wh}!`, '-depth', '8', `ppm:${work}`]);
      // leaf boxes on the scan itself, in working pixels (dpi 1 → "inches" are pixels)
      const det = await this.detector.detect({ image: work, width: ww, height: wh, dpi: 1, workDir: path.dirname(stem) });
      let boxes = det.boxes.filter((b) => b.model === 'plant' && LEAF_CLASSES.includes(b.label) && b.score >= o.leafScore)
        .map((b) => {
          const px = leafPadPx || (b.x2 - b.x1) * o.pad, py = leafPadPx || (b.y2 - b.y1) * o.pad;
          const x = Math.max(0, Math.floor(b.x1 - px)), y = Math.max(0, Math.floor(b.y1 - py));
          return { x, y, w: Math.min(ww, Math.ceil(b.x2 + px)) - x, h: Math.min(wh, Math.ceil(b.y2 + py)) - y, from: `${b.label} ${b.score.toFixed(2)}` };
        }).filter((b) => b.w > 8 && b.h > 8);
      if (!boxes.length) boxes = [{ x: 0, y: 0, w: ww, h: wh, from: 'whole scan (no leaf box)' }];
      const tDetect = Date.now();

      // one letterboxed 1024 crop per box
      const crops = boxes.map((b, i) => ({ ...b, lb: letterbox(b.w, b.h, SIZE), rgb: `${stem}.crop${i}.rgb`, gray: `${stem}.crop${i}.gray` }));
      for (const c of crops) temps.push(c.rgb, c.gray);
      await Promise.all(crops.map((c) => run('magick', ['-size', `${SIZE}x${SIZE}`, 'xc:rgb(114,114,114)',
        '(', work, '-crop', `${c.w}x${c.h}+${c.x}+${c.y}`, '+repage', '-resize', `${c.lb.nw}x${c.lb.nh}!`, ')',
        '-geometry', `+${c.lb.left}+${c.lb.top}`, '-composite', '-depth', '8', `rgb:${c.rgb}`])));
      const env = { ...process.env }; delete env.OVSEG_NO_PETIOLE;
      if (!o.petiole) env.OVSEG_NO_PETIOLE = '1';
      const out = JSON.parse(await run(this.ovseg, [this.xml, String(o.maskScore), ...crops.flatMap((c) => [c.rgb, c.gray])], { env }));
      const tSeg = Date.now();

      // un-letterbox each crop's mask and lay them onto one mask of the working copy (union)
      const args = ['-size', `${ww}x${wh}`, 'xc:black'];
      for (const c of crops) {
        args.push('(', '-size', `${SIZE}x${SIZE}`, '-depth', '8', `gray:${c.gray}`, '-crop', `${c.lb.nw}x${c.lb.nh}+${c.lb.left}+${c.lb.top}`, '+repage',
          '-resize', `${c.w}x${c.h}!`, ')', '-geometry', `+${c.x}+${c.y}`, '-compose', 'Lighten', '-composite');
      }
      args.push('-threshold', '50%', '-colorspace', 'Gray', '-depth', '8', '-format', '%[fx:mean]', '-write', 'info:', mask);
      const keptFraction = Number((await run('magick', args)).trim());
      const s = 1 / scale;
      return {
        mask, keptFraction: Number.isFinite(keptFraction) ? +keptFraction.toFixed(4) : null,
        crops: crops.map((c, i) => {
          const n = { Leaf: 0, Petiole: 0, Hole: 0 };
          for (const inst of out.crops[i].instances) { const name = CLASS_NAMES[inst[0]]; if (name) n[name]++; }
          const bx = Math.round(c.x * s), by = Math.round(c.y * s);
          return { box: [bx, by, Math.min(width - bx, Math.round(c.w * s)), Math.min(height - by, Math.round(c.h * s))], from: c.from, instances: n };
        }),
        ms: { detect: tDetect - t0, segment: tSeg - tDetect, infer: Math.round(out.crops.reduce((a, c) => a + c.inferMs, 0)), load: Math.round(out.loadMs), total: Date.now() - t0 },
      };
    } finally {
      for (const t of temps) await fsp.rm(t, { force: true });
    }
  }
}

/** ImageMagick arguments that black out everything outside `mask` (any size) on `image` (width × height). Exact for kept pixels. */
function applyMaskArgs(image, mask, width, height) {
  return [image, '(', mask, '-resize', `${width}x${height}!`, '-threshold', '50%', ')', '-compose', 'Multiply', '-composite'];
}

module.exports = { Segmenter, applyMaskArgs, DEFAULTS };
