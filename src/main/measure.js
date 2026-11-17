'use strict';
// Measure tab: the image to measure on, and one measurements file per specimen.
//
//   <root>/<folder>/<ID>.json             every measurement recorded for the specimen (both sides, every product),
//                                         its notes, and for each image used: its metadata, the scan options and
//                                         CF, the pixels-per-cm conversion factor (dpi / 2.54)
//   <root>/.cache/measure/<folder>/…      measuring images: a JPEG of a product no larger than MEASURE_PX on its
//                                         long side (the app cannot show JPEG XL, and previews are too small to place
//                                         end points well). Rebuilt whenever the product file changes.
//
// Points are always stored in pixels of the full-resolution product image, so they do not depend on the
// measuring image. The three products of a side share the scan's dpi (the plant crop and the leaf are crops,
// not resamples), so one CF holds for all of them.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const leaves = require('./leaves');
const { run } = require('./tools');

const MEASURE_PX = 6000;
const PRODUCTS = {                    // the renderer's letter → name in the file, file suffix letter, where its files are
  a: { name: 'archival', letter: 'a', files: (p) => p.files },
  p: { name: 'plant', letter: 'p', files: (p) => p.plantFiles },
  s: { name: 'leaf', letter: 'l', files: (p) => p.segFiles },
};
const LETTER_OF = Object.fromEntries(Object.entries(PRODUCTS).map(([k, v]) => [v.name, k]));

function productFile(p, product) {
  const def = PRODUCTS[product];
  if (!def) throw new Error(`Unknown product "${product}"`);
  const m = def.files(p);
  return [m.jxl, m.tiff, m.jxlLossy].find((f) => f && fs.existsSync(f)) || null;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const making = new Map();             // measuring images being made right now (one job per image)

/**
 * The measuring image for one product of one side, made on first use. Resolves null when that product does not
 * exist, else { name, file, proxy, width, height (full-resolution px), dpi, pxPerCm, mtime }.
 */
async function measureImage(root, { folder, id, side, product }) {
  const p = leaves.leafPaths(root, folder, id, side);
  const file = productFile(p, product);
  if (!file) return null;
  const st = await fsp.stat(file);
  const dir = path.join(root, '.cache', 'measure', leaves.checkName(folder, 'folder'));
  const stem = path.basename(file).replace(/\.\w+$/, ''), key = `${stem}.${Math.round(st.mtimeMs)}`;
  const proxy = path.join(dir, `${key}.jpg`), factsFile = path.join(dir, `${key}.json`);
  let dims = fs.existsSync(proxy) ? readJson(factsFile) : null;
  if (!dims) {
    if (!making.has(proxy)) {
      making.set(proxy, (async () => {
        await fsp.mkdir(dir, { recursive: true });
        for (const f of await fsp.readdir(dir)) if (f.startsWith(`${stem}.`)) await fsp.rm(path.join(dir, f), { force: true });   // older takes of this image
        let src = file, tmp = null;
        if (/\.jxl$/i.test(file)) { tmp = path.join(dir, `${key}.dec.ppm`); await run('djxl', [file, tmp, '--bits_per_sample=8', '--quiet']); src = tmp; }
        try {
          const [width, height] = (await run('magick', ['identify', '-ping', '-format', '%w %h', src])).trim().split(' ').map(Number);
          await run('magick', [src, '-resize', `${MEASURE_PX}x${MEASURE_PX}>`, '-quality', '90', proxy]);
          const d = { width, height };
          await fsp.writeFile(factsFile, JSON.stringify(d));
          return d;
        } finally { if (tmp) await fsp.rm(tmp, { force: true }); }
      })().finally(() => making.delete(proxy)));
    }
    dims = await making.get(proxy);
  }
  const meta = readJson(p.sidecar);
  const dpi = Number(meta?.profile?.dpi) || Number(meta?.accepted?.dpi) || null;
  return { name: path.basename(file), file, proxy, width: dims.width, height: dims.height, dpi, pxPerCm: dpi ? dpi / 2.54 : null, mtime: st.mtimeMs };
}

/** What the measurements file says about one image: its metadata, the scan options, and CF. */
async function imageRecord(root, folder, id, side, product) {
  const img = await measureImage(root, { folder, id, side, product });
  if (!img) return null;
  const p = leaves.leafPaths(root, folder, id, side), meta = readJson(p.sidecar) || {};
  const def = PRODUCTS[product];
  const out = product === 'a' ? (meta.outputs || []).find((o) => o.name === img.name) : product === 'p' ? meta.plant : meta.segmented;
  return {
    name: img.name, side, sideName: leaves.SIDES[side], product: def.name, suffix: `_${side}${def.letter}`,
    widthPx: img.width, heightPx: img.height, dpi: img.dpi,
    CF: img.pxPerCm ? +img.pxPerCm.toFixed(4) : null,                       // pixels per cm: lengthCm = lengthPx / CF
    pxPerMm: img.pxPerCm ? +(img.pxPerCm / 10).toFixed(5) : null,
    bytes: fs.statSync(img.file).size, sha256: out?.name === img.name ? out.sha256 ?? null : null,
    lossless: out?.lossless ?? null, scannedAt: meta.scannedAt ?? null,
    cropOfArchivalPx: product === 'a' ? null : meta.plant?.box ?? null,      // [x, y, w, h]: where this image sits in the whole scan (<ID>_<side>a)
    scanOptions: meta.profile ?? null,                                      // dpi, bits, pixel type, area on the glass, corrections off
    accepted: meta.accepted ?? null,                                        // what the scanner driver reported it used
    device: meta.device ?? null, sidecar: path.basename(p.sidecar),
  };
}

const measurementsFile = (root, folder, id) => path.join(leaves.scansDir(root, folder), `${leaves.checkName(id, 'leaf ID')}.json`);

/** The specimen's measurements file as stored, or null. Product names come back as the renderer's letters too (`view`). */
function load(root, { folder, id }) {
  const file = measurementsFile(root, folder, id), doc = readJson(file);
  if (!doc || doc.format !== 'scandeck-measurements') return null;
  return { file, notes: doc.notes || '', updatedAt: doc.updatedAt, measurements: (doc.measurements || []).map((m) => ({ ...m, view: LETTER_OF[m.product] || 'a' })) };
}

const pathLength = (pts) => pts.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0);

/**
 * Write <ID>.json: `measurements` = [{ id, label, note, side, view (a | p | s), points: [[x, y], …] in full-resolution
 * px of that image, recordedAt?, imageSha256? }]. Lengths, CF and the image records are worked out here.
 */
async function save(root, { folder, id, notes, measurements }, appVersion) {
  const file = measurementsFile(root, folder, id);
  const prev = readJson(file), now = new Date().toISOString();
  const images = {}, cache = new Map(), out = [];
  for (const m of Array.isArray(measurements) ? measurements : []) {
    const side = leaves.SIDES[m.side] ? m.side : null, view = PRODUCTS[m.view] ? m.view : null;
    if (!side || !view) throw new Error('A measurement has no side or view.');
    const k = side + view;
    if (!cache.has(k)) cache.set(k, await imageRecord(root, folder, id, side, view));
    const img = cache.get(k);
    if (!img) throw new Error(`${id}: the ${PRODUCTS[view].name} image of the ${side === 't' ? 'top' : 'bottom'} is gone; remove its measurements or rescan.`);
    images[img.name] = img;
    const points = (Array.isArray(m.points) ? m.points : []).map((q) => [+Number(q[0]).toFixed(1), +Number(q[1]).toFixed(1)]).filter((q) => q.every(Number.isFinite));
    if (points.length < 2) continue;
    const px = pathLength(points), cm = img.CF ? px / img.CF : null;
    out.push({
      id: String(m.id || `m${out.length + 1}`), label: String(m.label || '').slice(0, 80), note: m.note ? String(m.note).slice(0, 300) : undefined,
      type: points.length === 2 ? 'line' : 'path',
      image: img.name, side, product: img.product, points,                  // pixels of `image`, origin top-left
      lengthPx: +px.toFixed(2), lengthMm: cm == null ? null : +(cm * 10).toFixed(3), lengthCm: cm == null ? null : +cm.toFixed(4),
      CF: img.CF, imageSha256: m.imageSha256 || img.sha256 || null,         // the image as it was when first recorded
      recordedAt: m.recordedAt || now,
    });
  }
  const doc = {
    format: 'scandeck-measurements', version: 1, id, folder,
    notes: String(notes || '').slice(0, 2000),
    createdAt: prev?.createdAt || now, updatedAt: now, app: { name: 'ScanDeck', version: appVersion },
    units: { points: 'pixels of the image named in each measurement, origin top-left', CF: 'pixels per cm (scan dpi / 2.54)', lengthCm: 'lengthPx / CF', lengthMm: 'lengthCm × 10' },
    images, measurements: out,
  };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.writing`;
  await fsp.writeFile(tmp, JSON.stringify(doc, null, 2));
  await fsp.rename(tmp, file);
  return load(root, { folder, id });
}

module.exports = { measureImage, load, save, measurementsFile, pathLength, PRODUCTS, MEASURE_PX };
