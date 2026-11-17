'use strict';
// Saving a scan, in the background so the next scan can start right away.
//
// The driver's TIFF (already checked by leaves.checkStaged) is converted to the formats chosen in
// Scan settings. Default since 2026-11-13: JPEG XL lossy (distance 1) only. Uncompressed TIFF and JPEG XL
// lossless (about 30% smaller than the TIFF, but roughly 10× slower to save) are toggles, both off.
//  - Each lossless file is read back and compared pixel-for-pixel with the driver's TIFF before that is
//    deleted. If that or anything else fails, the driver's TIFF itself becomes the master (nothing is lost).
//  - Jobs run one at a time, in order, so a retake queued behind its first take retires it properly.
//  - Each job waits in <root>/.staging/ with a .job.json, so quitting mid-save loses nothing: the job
//    is picked up again on the next launch (recover()).
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const leaves = require('./leaves');
const { run } = require('./tools');
const { checkFringe } = require('./fringe');
const { applyMaskArgs, DEFAULTS: SEG_DEFAULTS } = require('./segment');
const qrcode = require('./qr');

const DEFAULT_FORMATS = { jxl: false, jxlLossy: true, tiff: false };

/** Which outputs to write; never nothing (falls back to TIFF). */
function normalizeFormats(f = DEFAULT_FORMATS) {
  const out = { jxl: !!f.jxl, jxlLossy: !!f.jxlLossy, tiff: !!f.tiff };
  if (!out.jxl && !out.jxlLossy && !out.tiff) out.tiff = true;
  return out;
}

/** sha256 of a binary PPM's pixel bytes (header and comments skipped). */
async function ppmPixelHash(file) {
  const b = await fsp.readFile(file);
  let i = 0; const fields = [];
  const ws = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
  while (fields.length < 4) {
    while (ws(b[i])) i++;
    if (b[i] === 0x23) { while (b[i] !== 0x0a) i++; continue; }
    let s = ''; while (!ws(b[i])) s += String.fromCharCode(b[i++]);
    fields.push(s);
  }
  return { w: +fields[1], h: +fields[2], max: +fields[3], hash: crypto.createHash('sha256').update(b.subarray(i + 1)).digest('hex') };
}

/** Width, height and maxval of a binary PPM, from its header alone. */
async function ppmHeader(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { buffer: b } = await fh.read(Buffer.alloc(256), 0, 256, 0);
    const f = b.toString('latin1').replace(/#[^\n]*\n/g, ' ').trim().split(/\s+/);
    return { w: +f[1], h: +f[2], max: +f[3] };
  } finally { await fh.close(); }
}

class Saver {
  constructor({ appVersion, segmenter = null, qr = null, onDone = () => {}, onProgress = () => {} }) {
    this.qr = qr;                   // qr.js: the label's QR code, read on the scan; its clean copy goes onto the archival image
    this.resegging = new Set();
    this.keep = null;               // { root, folder, id }: the leaf being worked on; only its ReSeg sources are kept (keepSources)
    this.segmenter = segmenter;     // segment.js; job.plant → plant crop (<ID>_tp), job.segment → segmented plant crop (<ID>_tl)
    this.onProgress = onProgress;
    this.appVersion = appVersion;
    this.onDone = onDone;
    this.queue = [];
    this.current = null;
    this.pending = new Map();     // "<root>|<folder>|<id>|<side>" → newest job for that side
  }

  /**
   * The leaf being worked on changed: delete every ReSeg source (<root>/.reseg/<folder>/<ID>_<side>p.ppm) that is not
   * this leaf's. Sides of other leaves that finish saving later don't leave one either. At most one leaf's two sides stay.
   */
  async keepSources(root, folder, id) {
    this.keep = { root, folder, id };
    const base = path.join(root, '.reseg');
    let removed = 0;
    for (const d of await fsp.readdir(base).catch(() => [])) {
      for (const f of await fsp.readdir(path.join(base, d)).catch(() => [])) {
        const mine = d === folder && (f === `${id}_tp.ppm` || f === `${id}_bp.ppm`);
        const m = /^(.+)_([tb])p\.ppm$/.exec(f);
        if (mine || (m && this.resegging.has([root, d, m[1], m[2]].join('|')))) continue;      // never under a running ReSeg
        await fsp.rm(path.join(base, d, f), { force: true }); removed++;
      }
    }
    return removed;
  }
  keeps(job) { const k = this.keep; return !!k && k.root === job.root && k.folder === job.folder && k.id === job.id; }

  get busy() { return this.queue.length + (this.current ? 1 : 0); }
  key(j) { return [j.root, j.folder, j.id, j.side].join('|'); }
  pendingFor(root, folder, id, side) { return this.pending.get([root, folder, id, side].join('|')) || null; }

  async enqueue(job) {
    job.formats = normalizeFormats(job.formats);
    job.jobFile = job.staged.replace(/\.tiff?$/i, '.job.json');
    await fsp.writeFile(job.jobFile, JSON.stringify(job, null, 2));
    this.pending.set(this.key(job), job);
    this.queue.push(job);
    this.kick();
  }

  /** Re-queue jobs left in .staging/ by a quit or crash. */
  async recover(roots) {
    let n = 0;
    for (const root of roots) {
      const dir = path.join(root, '.staging');
      let names = [];
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const f of names.filter((x) => x.endsWith('.job.json')).sort()) {
        try {
          const job = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
          if (fs.existsSync(job.staged)) { await this.enqueue(job); n++; } else await fsp.rm(path.join(dir, f), { force: true });
        } catch (e) { console.error('could not recover', f, e.message); }
      }
    }
    return n;
  }

  async kick() {
    if (this.current || !this.queue.length) return;
    const job = this.current = this.queue.shift();
    let result;
    try { result = { ok: true, ...(await this.process(job)) }; }
    catch (e) { result = { ok: false, error: e.message }; }
    if (this.pending.get(this.key(job)) === job) this.pending.delete(this.key(job));
    this.current = null;
    this.onDone({ id: job.id, side: job.side, folder: job.folder, root: job.root, ...result });
    this.kick();
  }

  async process(job) {
    const { root, folder, id, side, staged, formats, profile, area, facts } = job;
    const p = leaves.leafPaths(root, folder, id, side);
    const stem = staged.replace(/\.tiff?$/i, '');
    const temps = [`${stem}.png`, `${stem}.ref.ppm`, `${stem}.dec.ppm`, `${stem}.chk.ppm`, `${stem}.seg.ppm`, `${stem}.mask.png`];
    const segOut = `${stem}.seg.jxl`, segJpg = `${stem}.seg.jpg`;
    const plantPpm = `${stem}.plant.ppm`, plantOut = `${stem}.plant.jxl`, plantJpg = `${stem}.plant.jpg`;
    const wantPlant = job.plant !== false && typeof this.segmenter?.plantBox === 'function' && !!facts?.width;
    const wantSeg = wantPlant && !!job.segment;
    let seg = null, plant = null, qr = null;
    const outs = { tiff: `${stem}.none.tif`, jxl: `${stem}.jxl`, jxlLossy: `${stem}_lossy.jxl` };
    const made = [];
    let note = null, keptDriverTiff = false;
    // Progress for the UI: each finished step adds its share (rough weights of how long it takes).
    const W = { prep: formats.jxl ? 5 : 1, tiff: formats.tiff ? 1.5 : 0, jxl: formats.jxl ? 7 : 0, lossy: formats.jxlLossy ? 2.5 : 0, plant: wantPlant ? 2 : 0, seg: wantSeg ? 5 : 0 };
    const total = W.prep + W.tiff + W.jxl + W.lossy + W.plant + W.seg;
    let pct = 0;
    const tell = (extra = {}) => this.onProgress({ id, side, folder, root, pct: Math.min(99, Math.round(pct)), ...extra });
    const step = (w, extra) => { pct += (100 * w) / total; tell(extra); };
    tell();
    // Thumbnail of the real scan first, so the side shows it right away; the fringing check (optional) alongside.
    const thumb = (async () => {
      if (job.stagedPreview && fs.existsSync(job.stagedPreview)) return;
      job.stagedPreview = `${stem}.jpg`;
      try { await leaves.makePreview(staged, job.stagedPreview); tell({ preview: true }); } catch (e) { console.error('preview', e.message); job.stagedPreview = null; }
    })();
    const fringe = job.fringe && facts?.width ? checkFringe(staged, { width: facts.width, height: facts.height, dpi: profile.dpi })
      .then((q) => { job.quality = q; tell({ quality: q }); }, (e) => console.error('fringe check', e.message)) : null;
    const same = (a, b) => a.hash === b.hash && a.w === b.w && a.h === b.h && a.max === b.max;
    try {
      // The scanned pixels as a plain PPM: the reference for the lossless checks and the input for the lossy
      // encoder. Lossless JPEG XL also needs a PNG (cjxl doesn't read TIFF; the PNG carries the ICC profile).
      await Promise.all([
        run('magick', [staged, '-depth', String(profile.bits), `ppm:${temps[1]}`]),
        formats.jxl && run('magick', [staged, '-depth', String(profile.bits), '-define', 'png:compression-level=1', temps[0]]),
      ]);
      const refHash = ppmPixelHash(temps[1]);
      step(W.prep);
      // One detection pass on the scan itself: the plant box, and the archival boxes (Barcode, Ruler) for the QR code.
      const detected = wantPlant ? this.segmenter.plantBox({ image: temps[1], width: facts.width, height: facts.height, dpi: profile.dpi, workDir: path.dirname(stem), opts: job.plantOpts }) : null;
      if (detected) detected.catch(() => {});
      // What the archival files are made from. Normally the scanned pixels. When the label's QR code reads as this
      // leaf's ID, a clean code for <ID>_<side> (2 cm wide, that text below) is laid onto the archival image below the ruler;
      // the lossless files are then checked against that image. The plant crop and the leaf never get it.
      const archive = (async () => {
        const plain = { ppm: temps[1], png: temps[0], tiff: [staged], hash: refHash, verified: 'pixels identical to the scanned TIFF' };
        if (!detected || !this.qr?.ready) return plain;
        try {
          const boxes = (await detected).archival || [];
          const cands = qrcode.candidates(boxes);
          if (!cands.length) { qr = { value: null, expected: id, match: false, note: 'no Barcode or Label box found on the scan' }; job.qr = qr; tell({ preview: true }); return plain; }
          let value = null, bc = null;
          for (const c of cands) { value = await this.qr.read({ image: temps[1], width: facts.width, height: facts.height, box: c, stem }); if (value != null) { bc = c; break; } }
          qr = { value, expected: id, match: value === id, tried: cands.map((c) => `${c.label} ${c.score.toFixed(2)}`),
            foundIn: bc ? { label: bc.label, score: +bc.score.toFixed(3), box: [bc.x1, bc.y1, bc.x2 - bc.x1, bc.y2 - bc.y1].map(Math.round) } : undefined };
          if (value == null) qr.note = `no QR code could be read in the ${cands.length} Barcode / Label box${cands.length === 1 ? '' : 'es'} on the scan`;
          job.qr = qr; tell({ preview: true });
          if (!qr.match) return plain;
          const ruler = qrcode.findRuler({ prescanRuler: job.prescan?.ruler, area, boxes, dpi: profile.dpi, width: facts.width, height: facts.height });
          if (!ruler) { qr.note = 'clean copy not added: no ruler found'; return plain; }
          const sideId = `${id}_${side}`;                     // the clean code and its text: leaf ID and side (2026-11-17), e.g. UM-025-A_t
          const tile = await this.qr.tile({ value: sideId, text: sideId, dpi: profile.dpi, stem });
          temps.push(tile.file);
          const at = qrcode.place({ ruler, w: tile.w, h: tile.h, width: facts.width, height: facts.height, dpi: profile.dpi });
          if (!at) { qr.note = 'clean copy not added: no room below the ruler'; return plain; }
          const lay = [tile.file, '-geometry', `+${at.x}+${at.y}`, '-compose', 'Over', '-composite'];
          const ppm = `${stem}.arch.ppm`, png = `${stem}.arch.png`;
          temps.push(ppm, png);
          await Promise.all([
            run('magick', [temps[1], ...lay, '-depth', String(profile.bits), `ppm:${ppm}`]),
            formats.jxl && run('magick', [temps[0], ...lay, '-depth', String(profile.bits), '-define', 'png:compression-level=1', png]),
          ]);
          await thumb;                                       // the thumbnail shows the archival image as saved
          if (job.stagedPreview) { try { await run('magick', [ppm, '-resize', '1600x1600>', '-quality', '82', job.stagedPreview]); tell({ preview: true }); } catch (e) { console.error('preview', e.message); } }
          qr.inserted = { value: sideId, text: sideId, box: [at.x, at.y, tile.w, tile.h], widthCm: qrcode.TILE.widthCm, ruler: { from: ruler.from, score: +ruler.score.toFixed(3), box: [ruler.x1, ruler.y1, ruler.x2 - ruler.x1, ruler.y2 - ruler.y1].map(Math.round) } };
          return { ppm, png, tiff: [staged, ...lay], hash: ppmPixelHash(ppm), verified: 'pixels identical to the scanned TIFF with the clean QR code added' };
        } catch (e) {
          console.error('qr', e.message);
          qr = { ...(qr || { value: null, expected: id, match: false }), inserted: undefined, error: e.message }; job.qr = qr;
          return plain;
        }
      })();
      // Uncompressed TIFF (default master since 2026-11-13): smaller than the driver's LZW at 16-bit and written
      // in under a second. Read back and compared before the driver's file is deleted.
      const tiff = formats.tiff && (async () => {
        const A = await archive;
        await run('magick', [...A.tiff, '-compress', 'none', outs.tiff]);
        await run('magick', [outs.tiff, '-depth', String(profile.bits), `ppm:${temps[3]}`]);
        if (!same(await A.hash, await ppmPixelHash(temps[3]))) throw new Error('the rewritten TIFF did not match the scanned pixels');
        step(W.tiff);
        return { format: 'tiff', from: outs.tiff, lossless: true, compression: 'none', verified: A.verified };
      })();
      const lossless = formats.jxl && (async () => {
        const A = await archive;
        await run('cjxl', [A.png, outs.jxl, '-d', '0', '-e', '7', '--quiet']);
        await run('djxl', [outs.jxl, temps[2], '--quiet']);
        if (!same(await A.hash, await ppmPixelHash(temps[2]))) throw new Error('JPEG XL lossless did not decode back to the scanned pixels');
        step(W.jxl);
        return { format: 'jxl', from: outs.jxl, lossless: true, verified: A.verified };
      })();
      const lossy = formats.jxlLossy && (async () => {
        const A = await archive;
        await run('cjxl', [formats.jxl ? A.png : A.ppm, outs.jxlLossy, '-d', '1', '-e', '7', '--quiet']);   // the scanner's profile is sRGB, cjxl's default for PPM
        step(W.lossy);
        return { format: 'jxlLossy', from: outs.jxlLossy, lossless: false, distance: 1 };
      })();
      // Plant crop (<ID>_tp): the scanned pixels inside the union of the plant boxes found on the scan itself.
      // Segmented product (<ID>_tl): leaf mask on that crop → everything else black. Both are JPEG XL at the same
      // quality as the scan's own JPEG XL (lossless if that is on, else distance 1), encoded from the scanned pixels,
      // not from a decoded lossy file, so they lose nothing more. A failure here never fails the save.
      const plantChain = wantPlant && (async () => {
        const lossless = !!formats.jxl, q = ['-d', lossless ? '0' : '1', '-e', '7', '--quiet'];
        let w, h;
        try {
          const b = await detected;
          const [x, y] = b.box; [, , w, h] = b.box;
          await run('magick', [temps[1], '-crop', `${w}x${h}+${x}+${y}`, '+repage', '-depth', String(profile.bits), '-write', `ppm:${plantPpm}`,
            '-resize', '1600x1600>', '-quality', '82', plantJpg]);
          job.stagedPlant = plantJpg; job.plantSize = { w, h }; tell({ preview: true });
          plant = { lossless, distance: lossless ? undefined : 1, box: b.box, from: b.from, used: b.used };
        } catch (e) {
          console.error('plant crop', e.message); plant = { error: e.message }; if (wantSeg) seg = { error: 'not made: no plant crop' };
          await fsp.rm(plantJpg, { force: true }); job.stagedPlant = null;
          step(W.plant + W.seg); return;
        }
        const encoding = run('cjxl', [plantPpm, plantOut, ...q]).then(() => null, (e) => e);
        if (wantSeg) {
          try {
            const leafPaddingCm = Number(job.plantOpts?.leafPaddingCm) || 0;     // the plant crop already includes it, so the padded leaf box fits
            const petiole = job.segPetiole === true;
            const m = await this.segmenter.mask({ image: plantPpm, width: w, height: h, dpi: profile.dpi, stem, opts: { leafPaddingCm, petiole } });
            await run('magick', [...applyMaskArgs(plantPpm, m.mask, w, h), '-depth', String(profile.bits), '-write', `ppm:${temps[4]}`,
              '-resize', '1600x1600>', '-quality', '82', segJpg]);
            job.stagedSeg = segJpg; tell({ preview: true });
            await run('cjxl', [temps[4], segOut, ...q]);
            seg = { lossless, distance: lossless ? undefined : 1, of: 'plant crop', model: 'lm3_leaf_segmenter__yolo26x_seg_1024', keeps: petiole ? ['Leaf', 'Petiole'] : ['Leaf'], black: petiole ? ['background', 'Hole'] : ['background', 'Hole', 'Petiole'], petiole,
              maskScore: SEG_DEFAULTS.maskScore, leafPaddingCm, keptFraction: m.keptFraction, crops: m.crops, ms: m.ms };
          } catch (e) { console.error('segment', e.message); seg = { error: e.message }; await fsp.rm(segOut, { force: true }); await fsp.rm(segJpg, { force: true }); job.stagedSeg = null; }
          step(W.seg);
        }
        const failed = await encoding;
        if (failed) { console.error('plant crop', failed.message); plant = { error: failed.message }; await fsp.rm(plantOut, { force: true }); await fsp.rm(plantJpg, { force: true }); job.stagedPlant = null; }
        step(W.plant);
      })();
      const done = await Promise.allSettled([tiff, lossless, lossy, plantChain, archive.then(() => null)]);
      for (const d of done) if (d.status === 'fulfilled' && d.value) made.push(d.value);
      const failed = done.find((d) => d.status === 'rejected');
      if (failed) throw failed.reason;
    } catch (e) {
      // Keep the scan no matter what: the driver's own TIFF becomes the master.
      note = `Converting failed (${e.message}); kept the scanner's TIFF`;
      for (const f of [...Object.values(outs), segOut, segJpg, plantOut, plantJpg]) await fsp.rm(f, { force: true });
      job.stagedSeg = job.stagedPlant = null;
      if (wantPlant) plant = { error: 'not made: the scan could not be converted' };
      if (wantSeg) seg = { error: 'not made: the scan could not be converted' };
      if (qr?.inserted) { qr.inserted = undefined; qr.note = 'clean copy not added: the scan could not be converted'; }
      made.length = 0;
      made.push({ format: 'tiff', from: staged, lossless: true, compression: 'lzw (as scanned)' });
      keptDriverTiff = true;
    } finally {
      for (const t of temps) await fsp.rm(t, { force: true });
    }
    await Promise.all([thumb, fringe]);
    if (job.reportReady instanceof Promise) job.report = (await job.reportReady) || job.report || {};   // arrives when the head is home
    const report = job.report || {};
    const stagedPreview = job.stagedPreview;

    await fsp.mkdir(p.dir, { recursive: true });
    const retired = await leaves.retire(p);
    const outputs = [];
    for (const m of made) {
      const dest = p.files[m.format];
      await fsp.rename(m.from, dest);
      outputs.push({ format: m.format, name: path.basename(dest), lossless: m.lossless, compression: m.compression, distance: m.distance, verified: m.verified,
        bytes: (await fsp.stat(dest)).size, sha256: await leaves.sha256(dest) });
    }
    await fsp.mkdir(path.dirname(p.preview), { recursive: true });
    if (stagedPreview && fs.existsSync(stagedPreview)) await fsp.rename(stagedPreview, p.preview);
    if (job.stagedBBox && fs.existsSync(job.stagedBBox)) await fsp.rename(job.stagedBBox, p.previewBBox);
    if (job.stagedBBoxAll && fs.existsSync(job.stagedBBoxAll)) await fsp.rename(job.stagedBBoxAll, p.previewBBoxAll);
    if (plant && !plant.error && fs.existsSync(plantOut)) {
      const plantFile = p.plantFiles[plant.lossless ? 'jxl' : 'jxlLossy'];
      await fsp.rename(plantOut, plantFile);
      if (fs.existsSync(plantJpg)) await fsp.rename(plantJpg, p.previewPlant);
      plant = { name: path.basename(plantFile), bytes: (await fsp.stat(plantFile)).size, sha256: await leaves.sha256(plantFile), ...plant };
    }
    // ReSeg source: the plant crop's scanned pixels stay (as they are, no encoding) while this leaf is the current one,
    // so a ReSeg makes a first-generation file again. Dropbox is told to leave the folder alone.
    if (plant?.name && fs.existsSync(plantPpm) && this.keeps(job)) {
      const base = path.join(root, '.reseg');
      const fresh = !fs.existsSync(base);
      await fsp.mkdir(path.dirname(p.resegSrc), { recursive: true });
      if (fresh) await run('xattr', ['-w', 'com.dropbox.ignored', '1', base]).catch(() => {});
      await fsp.rename(plantPpm, p.resegSrc);
    } else {
      await fsp.rm(plantPpm, { force: true });
      if (plant?.name) await fsp.rm(p.resegSrc, { force: true });     // an older take's source no longer matches this crop
    }
    if (seg && !seg.error && fs.existsSync(segOut)) {
      const segFile = p.segFiles[seg.lossless ? 'jxl' : 'jxlLossy'];
      await fsp.rename(segOut, segFile);
      if (fs.existsSync(segJpg)) await fsp.rename(segJpg, p.previewSeg);
      seg = { name: path.basename(segFile), bytes: (await fsp.stat(segFile)).size, sha256: await leaves.sha256(segFile), ...seg };
    }
    const sidecar = leaves.sidecarFor({ id, side, report, profile, area, facts, appVersion: this.appVersion, retired, outputs, note });
    if (plant) sidecar.plant = plant;                         // <ID>_tp: box = [x, y, w, h] px within the scan (<ID>_ta)
    if (qr) sidecar.qr = qr;                                  // the label's QR code; inserted = the clean copy on <ID>_ta ([x, y, w, h] px)
    if (seg) sidecar.segmented = seg;                         // <ID>_tl: the plant crop, leaf only
    if (job.quality) sidecar.quality = job.quality;           // color-fringing check (fringe.js)
    if (job.prescan?.reusedFrom) sidecar.areaFrom = job.prescan;   // auto area mirrored from the top side (no prescan)
    else if (job.prescan) sidecar.prescan = job.prescan;    // auto area: detections, capture box; the preview IS the prescan
    sidecar.tiffDeleted = !keptDriverTiff;                  // the driver's LZW file; an uncompressed copy may be among the outputs
    await fsp.writeFile(p.sidecar, JSON.stringify(sidecar, null, 2));
    if (!keptDriverTiff) await fsp.rm(staged, { force: true });
    await fsp.rm(job.jobFile, { force: true });
    return { note, info: await leaves.sideInfo(root, folder, id, side) };
  }

  /**
   * ReSeg: segment a saved side's leaf again at another confidence, without scanning. The saved plant crop (<ID>_tp) is
   * decoded and masked anew; the leaf files it replaces move to retakes/ as <file name>-s<N>. Lower `maskScore` keeps
   * more (e.g. a petiole the first mask dropped). While the leaf is the current one its ReSeg source (the plant crop's
   * scanned pixels) is still there and the new file is first-generation, like the first save. Without it, a lossy plant
   * crop is decoded and encoded again at distance 1 (second generation).
   */
  async reseg({ root, folder, id, side, maskScore, petiole = false }) {
    if (!this.segmenter?.ready) throw new Error('The leaf segmenter is not available.');
    if (!(maskScore >= 0.01 && maskScore <= 0.95)) throw new Error('Confidence must be between 0.01 and 0.95.');
    const key = [root, folder, id, side].join('|');
    if (this.pending.has(key)) throw new Error('This side is still being saved.');
    if (this.resegging.has(key)) throw new Error('This side is already being re-segmented.');
    const p = leaves.leafPaths(root, folder, id, side);
    const has = (f) => fsp.access(f).then(() => true, () => false);
    const lossless = await has(p.plantFiles.jxl), src = lossless ? p.plantFiles.jxl : p.plantFiles.jxlLossy;
    if (!(await has(src))) throw new Error(`No plant crop (${id}_${side}p) to segment.`);
    const meta = JSON.parse(await fsp.readFile(p.sidecar, 'utf8'));
    this.resegging.add(key);
    const staging = path.join(root, '.staging');
    await fsp.mkdir(staging, { recursive: true });
    const stem = path.join(staging, `${id}_${side}_reseg_${Date.now()}`);
    const ppm = `${stem}.plant.ppm`, segPpm = `${stem}.seg.ppm`, out = `${stem}.seg.jxl`, jpg = `${stem}.seg.jpg`;
    try {
      // the scanned pixels if they are still kept and are this crop; else the saved plant crop, decoded
      let pixels = null;
      if (await has(p.resegSrc)) { const k = await ppmHeader(p.resegSrc), pb = meta.plant?.box; if (Array.isArray(pb) && k.w === pb[2] && k.h === pb[3]) pixels = p.resegSrc; }
      const fromScan = !!pixels;
      if (!pixels) { await run('djxl', [src, ppm, '--quiet']); pixels = ppm; }
      const { w, h, max } = await ppmHeader(pixels);
      const bits = max > 255 ? 16 : 8, leafPaddingCm = Number(meta.segmented?.leafPaddingCm) || 0;
      const m = await this.segmenter.mask({ image: pixels, width: w, height: h, dpi: meta.profile?.dpi, stem, opts: { maskScore, leafPaddingCm, petiole: petiole === true } });
      await run('magick', [...applyMaskArgs(pixels, m.mask, w, h), '-depth', String(bits), '-write', `ppm:${segPpm}`, '-resize', '1600x1600>', '-quality', '82', jpg]);
      await run('cjxl', [segPpm, out, '-d', lossless ? '0' : '1', '-e', '7', '--quiet']);
      // the leaf files being replaced are kept: retakes/<file name>-s<N>
      await fsp.mkdir(p.retakes, { recursive: true });
      let n = 1;
      const re = new RegExp(`^${p.base.replace(/[.]/g, '\\.')}l(?:_lossy)?-s(\\d+)\\.`);
      for (const f of await fsp.readdir(p.retakes)) { const k = re.exec(f); if (k) n = Math.max(n, Number(k[1]) + 1); }
      const replaced = [];
      for (const from of [...Object.values(p.segFiles), p.previewSeg]) {
        if (!(await has(from))) continue;
        const { name, ext } = path.parse(from);
        await fsp.rename(from, path.join(p.retakes, `${name}-s${n}${ext}`));
        replaced.push(`${name}-s${n}${ext}`);
      }
      const dest = p.segFiles[lossless ? 'jxl' : 'jxlLossy'];
      await fsp.rename(out, dest);
      await fsp.mkdir(path.dirname(p.previewSeg), { recursive: true });
      await fsp.rename(jpg, p.previewSeg);
      meta.segmented = { name: path.basename(dest), bytes: (await fsp.stat(dest)).size, sha256: await leaves.sha256(dest), lossless, distance: lossless ? undefined : 1,
        of: 'plant crop', model: 'lm3_leaf_segmenter__yolo26x_seg_1024', keeps: petiole === true ? ['Leaf', 'Petiole'] : ['Leaf'], black: petiole === true ? ['background', 'Hole'] : ['background', 'Hole', 'Petiole'], petiole: petiole === true,
        maskScore, leafPaddingCm, keptFraction: m.keptFraction, crops: m.crops, ms: m.ms,
        reseg: { at: new Date().toISOString(), from: fromScan ? 'scanned pixels (ReSeg source)' : path.basename(src), secondLossyGeneration: (!fromScan && !lossless) || undefined, replaced, previousMaskScore: meta.segmented?.maskScore ?? SEG_DEFAULTS.maskScore, previousKeptFraction: meta.segmented?.keptFraction ?? null } };
      await fsp.writeFile(p.sidecar, JSON.stringify(meta, null, 2));
      return { fromScan, keptFraction: m.keptFraction, previousKeptFraction: meta.segmented.reseg.previousKeptFraction, maskScore, info: await leaves.sideInfo(root, folder, id, side) };
    } finally {
      this.resegging.delete(key);
      for (const f of [ppm, segPpm, out, jpg, `${stem}.mask.png`]) await fsp.rm(f, { force: true });
    }
  }
}

module.exports = { Saver, DEFAULT_FORMATS, normalizeFormats };
