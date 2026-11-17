'use strict';
// Where scans live, and how a finished scan becomes master files.
//
// Three products per side (t = top/adaxial, b = bottom/abaxial), all in <root>/<folder>/scans/ (2026-11-13; scans/ since
// 2026-11-17: the folder holds every final file and nothing else). previews/ and retakes/ are beside scans/, in <root>/<folder>/:
//   <ID>_<side>a…   "a" = archival: the whole scan = union of the archival and plant boxes (_ta, _ba)
//       <ID>_ta_lossy.jxl  JPEG XL lossy, distance 1 (default) · <ID>_ta.jxl  JPEG XL lossless, verified bit-exact
//       <ID>_ta.tif        TIFF: only when TIFF output is on, or if converting failed
//   <ID>_<side>p[_lossy].jxl   "p" = plant: the scan cropped to the union of the plant boxes found on it (_tp, _bp)
//   <ID>_<side>l[_lossy].jxl   "l" = leaf, the main product: the plant crop with everything but the leaf black (segment.js) (_tl, _bl)
//       p and l are JPEG XL at the scan's own quality (_lossy = distance 1, without = lossless)
//   <ID>_<side>.json           sidecar for the side: profile, what the driver accepted, TIFF facts, every product, sha256s
//   previews/<ID>_<side>a.jpg, <ID>_<side>p.jpg, <ID>_<side>l.jpg   thumbnails of the three products
//   previews/<ID>_<side>_previewbbox.jpg   Auto area: the prescan of the whole glass with the scan area (blue) and the plant (green) / archival (purple) unions
//                                          and detections drawn in
//   previews/<ID>_<side>_previewbboxall.jpg   the same prescan with every single detection at or above the threshold, before the unions:
//                                             class and score on each; dashed = its class is not ticked, so it did not count
//   retakes/<file name>-s<N>.<ext>   leaf files replaced by a ReSeg (e.g. UM-001-A_tl_lossy-s1.jxl), never deleted
//   retakes/<file name>-r<N>.<ext>   superseded takes (every file of the side, e.g. UM-001-A_ta_lossy-r1.jxl,
//                                    UM-001-A_tl_lossy-r1.jxl), never deleted
//   <root>/.reseg/<folder>/<ID>_<side>p.ppm   ReSeg source: the plant crop's scanned pixels, lossless, only for the leaf being worked on
//                                             (both sides at most); deleted when another leaf becomes the current one
//   <root>/.staging/                         scans land here; save.js converts them and moves the results into place
//
// Nothing is ever overwritten: a retake first moves every file of that side into retakes/.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./tools');

const SIDES = { t: 'top (adaxial)', b: 'bottom (abaxial)' };
/** Output formats → file suffix after <ID>_<side>a (and, JPEG XL only, after <ID>_<side>p and <ID>_<side>l). Order = which one "Open" uses first. */
const OUTPUTS = { jxl: '.jxl', tiff: '.tif', jxlLossy: '_lossy.jxl' };

function checkName(s, what = 'name') {
  if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(s) || s.includes('..')) {
    throw new Error(`The ${what} "${s}" can't be used in a file name (letters, digits, . _ - only).`);
  }
  return s;
}
function checkSide(side) { if (!SIDES[side]) throw new Error(`Unknown side "${side}"`); return side; }

/**
 * <root>/<folder>/scans: every final file of the folder (the products and the JSON records), nothing else (2026-11-17).
 * previews/ and retakes/ stay beside it in <root>/<folder>/. The first time a folder is used, loose files left in
 * <root>/<folder>/ by the older layout are moved into scans/ (never over an existing file).
 */
const laidOut = new Set();
function scansDir(root, folder) {
  const home = path.join(root, checkName(folder, 'folder')), dir = path.join(home, 'scans');
  if (!laidOut.has(home)) {
    laidOut.add(home);
    try {
      const loose = fs.readdirSync(home, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.'));
      if (loose.length) fs.mkdirSync(dir, { recursive: true });
      for (const e of loose) { const to = path.join(dir, e.name); if (!fs.existsSync(to)) fs.renameSync(path.join(home, e.name), to); }
    } catch { /* no such folder yet */ }
  }
  return dir;
}

function leafPaths(root, folder, id, side) {
  const dir = scansDir(root, folder), home = path.dirname(dir);
  const base = `${checkName(id, 'leaf ID')}_${checkSide(side)}`;
  const files = Object.fromEntries(Object.entries(OUTPUTS).map(([k, suffix]) => [k, path.join(dir, `${base}a${suffix}`)]));
  const jxls = (b) => ({ jxl: path.join(dir, b + OUTPUTS.jxl), jxlLossy: path.join(dir, b + OUTPUTS.jxlLossy) });
  return {
    dir, base, files, tiff: files.tiff,
    sidecar: path.join(dir, `${base}.json`),
    preview: path.join(home, 'previews', `${base}a.jpg`),
    previewBBox: path.join(home, 'previews', `${base}_previewbbox.jpg`),
    previewBBoxAll: path.join(home, 'previews', `${base}_previewbboxall.jpg`),
    plantFiles: jxls(`${base}p`), previewPlant: path.join(home, 'previews', `${base}p.jpg`),
    segFiles: jxls(`${base}l`), previewSeg: path.join(home, 'previews', `${base}l.jpg`),
    retakes: path.join(home, 'retakes'),
    resegSrc: path.join(root, '.reseg', folder, `${base}p.ppm`),      // the plant crop's scanned pixels, kept while this leaf is the current one (save.js)
  };
}

/** Pixel size of a scan area: { full } or { w, h } in inches. */
function expectedPixels(area, dpi, bed = { w: 8.5, h: 11.7 }) {
  const w = area.full ? bed.w : area.w, h = area.full ? bed.h : area.h;
  return { w: Math.round(w * dpi), h: Math.round(h * dpi) };
}

/** TIFF facts from macOS's own sips (no Homebrew needed). */
async function tiffFacts(file) {
  const out = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'bitsPerSample', '-g', 'samplesPerPixel', '-g', 'dpiWidth', '-g', 'formatOptions', '-g', 'profile', file]);
  const g = (k) => (new RegExp(`\\b${k}:\\s*(.+)`).exec(out) || [])[1]?.trim() ?? null;
  return {
    width: Number(g('pixelWidth')), height: Number(g('pixelHeight')),
    bitsPerSample: Number(g('bitsPerSample')), samplesPerPixel: Number(g('samplesPerPixel')),
    dpi: Number(g('dpiWidth')) || null, compression: g('formatOptions'), profile: g('profile'),
  };
}

/** Problems that make a scan unfit to be a master; [] when it is fine. */
function validate(facts, { w, h, bits }) {
  const problems = [];
  if (Math.abs(facts.width - w) > 2 || Math.abs(facts.height - h) > 2) problems.push(`size ${facts.width} × ${facts.height} px, expected ${w} × ${h}`);
  if (facts.bitsPerSample !== bits) problems.push(`${facts.bitsPerSample} bits/sample, expected ${bits}`);
  if (facts.samplesPerPixel !== 3) problems.push(`${facts.samplesPerPixel} samples/pixel, expected RGB`);
  return problems;
}

/**
 * Check a staged scan against the profile and what the driver accepted. Returns its TIFF facts, or throws
 * after moving it to .staging/rejected, so a bad scan never becomes a master.
 */
async function checkStaged({ staged, report, profile, area }) {
  const facts = await tiffFacts(staged);
  const problems = validate(facts, { ...expectedPixels(area, profile.dpi), bits: profile.bits });
  const acc = report.accepted || {};
  if (acc.dpi != null && acc.dpi !== profile.dpi) problems.push(`driver used ${acc.dpi} dpi instead of ${profile.dpi}`);
  if (acc.bitDepth != null && acc.bitDepth !== profile.bits) problems.push(`driver used ${acc.bitDepth}-bit instead of ${profile.bits}-bit`);
  if (problems.length) {
    const rejected = path.join(path.dirname(staged), 'rejected');
    await fsp.mkdir(rejected, { recursive: true });
    await fsp.rename(staged, path.join(rejected, path.basename(staged)));
    throw new Error(`Scan rejected (kept in .staging/rejected): ${problems.join('; ')}`);
  }
  return facts;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (b) => h.update(b)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

async function makePreview(tiff, jpg, maxPx = 1600) {
  await fsp.mkdir(path.dirname(jpg), { recursive: true });
  await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', String(maxPx), tiff, '--out', jpg]);
}

const exists = (f) => fsp.access(f).then(() => true, () => false);

async function nextRetake(retakesDir, base) {
  let n = 0;
  const b = base.replace(/[.]/g, '\\.');
  const res = [
    new RegExp(`^${b}[apls]?(?:_(?:lossy|previewbbox|previewbboxall))?-r(\\d+)\\.(?:tif|jxl|json|jpg)$`),                    // <file name>-r<N>
    new RegExp(`^${b}_r(\\d+)(?:_(?:lossy|previewbbox|segmented))?\\.(?:tif|jxl|json|jpg)$`),             // before 2026-11-13
  ];
  try {
    for (const f of await fsp.readdir(retakesDir)) for (const re of res) { const m = re.exec(f); if (m) n = Math.max(n, Number(m[1])); }
  } catch { /* none yet */ }
  return n + 1;
}

/** Move every file of a side (all three products, sidecar, previews) to retakes/ as <file name>-r<N>.<ext>; returns the moved names. */
async function retire(p) {
  const masters = Object.values(p.files);
  const present = [];
  for (const from of [...masters, ...Object.values(p.plantFiles), ...Object.values(p.segFiles), p.sidecar, p.preview, p.previewBBox, p.previewBBoxAll, p.previewPlant, p.previewSeg]) if (await exists(from)) present.push(from);
  if (!present.some((from) => masters.includes(from))) return null;
  await fsp.mkdir(p.retakes, { recursive: true });
  const n = await nextRetake(p.retakes, p.base);
  const names = [];
  for (const from of present) {
    const { name: stem, ext } = path.parse(from);
    const name = `${stem}-r${n}${ext}`;
    await fsp.rename(from, path.join(p.retakes, name));
    names.push(name);
  }
  return names;
}

/** TIFF master (the pre-JPEG XL path, and save.js's fallback): validate, retire, move into place, sidecar, preview. */
async function commit({ root, folder, id, side, staged, report, profile, area, appVersion, facts = null, note = null }) {
  const p = leafPaths(root, folder, id, side);
  facts ||= await checkStaged({ staged, report, profile, area });
  await fsp.mkdir(p.dir, { recursive: true });
  const retired = await retire(p);
  await fsp.rename(staged, p.tiff);
  const sidecar = sidecarFor({ id, side, report, profile, area, facts, appVersion, retired, note,
    outputs: [{ format: 'tiff', name: path.basename(p.tiff), lossless: true, bytes: (await fsp.stat(p.tiff)).size, sha256: await sha256(p.tiff) }] });
  try { await makePreview(p.tiff, p.preview); } catch (e) { sidecar.previewError = e.message; }
  await fsp.writeFile(p.sidecar, JSON.stringify(sidecar, null, 2));
  return sideInfo(root, folder, id, side);
}

function sidecarFor({ id, side, report, profile, area, facts, appVersion, retired, outputs, note }) {
  return {
    format: 'scandeck-scan', version: 3,
    id, side, sideName: SIDES[side], outputs, retired, note: note || undefined,
    scannedAt: new Date().toISOString(), scanSeconds: report.scanSeconds ?? null,
    profile: { dpi: profile.dpi, bits: profile.bits, pixel: 'RGB', area, correctionsOff: true },
    accepted: report.accepted ?? null, tiff: facts,
    device: report.device ?? null, mock: !!report.mock, app: { name: 'ScanDeck', version: appVersion },
  };
}

async function sideInfo(root, folder, id, side) {
  const p = leafPaths(root, folder, id, side);
  const files = [];
  for (const [format, file] of Object.entries(p.files)) {
    try { const st = await fsp.stat(file); files.push({ format, file, name: path.basename(file), bytes: st.size, mtime: st.mtimeMs }); } catch { /* not saved */ }
  }
  if (!files.length) return null;
  let meta = null;
  try { meta = JSON.parse(await fsp.readFile(p.sidecar, 'utf8')); } catch { /* master without sidecar */ }
  const main = files[0];                                   // OUTPUTS order: lossless JPEG XL, TIFF, lossy JPEG XL
  const first = async (m) => ((await exists(m.jxl)) ? m.jxl : (await exists(m.jxlLossy)) ? m.jxlLossy : null);
  const plant = await first(p.plantFiles), segmented = await first(p.segFiles);
  let bytes = files.reduce((s, f) => s + f.bytes, 0);
  for (const f of [plant, segmented]) if (f) bytes += (await fsp.stat(f)).size;
  const pb = meta?.plant?.box;
  let v = main.mtime;                                      // changes when any product does (a ReSeg rewrites only the leaf): cache key for the previews
  for (const f of [plant, segmented]) if (f) v = Math.max(v, (await fsp.stat(f)).mtimeMs);
  return {
    side, files, file: main.file, name: main.name, bytes, mtime: main.mtime,
    preview: (await exists(p.preview)) ? p.preview : null, retakes: (await nextRetake(p.retakes, p.base)) - 1,
    previewBBox: (await exists(p.previewBBox)) ? p.previewBBox : null,
    previewBBoxAll: (await exists(p.previewBBoxAll)) ? p.previewBBoxAll : null,
    plant, previewPlant: (await exists(p.previewPlant)) ? p.previewPlant : null, plantSize: Array.isArray(pb) ? { w: pb[2], h: pb[3] } : null,
    segmented, previewSeg: (await exists(p.previewSeg)) ? p.previewSeg : null,
    resegSource: await exists(p.resegSrc),               // ReSeg can still start from the scanned pixels (no second lossy generation)
    segmentedError: meta?.segmented?.error ?? null, maskScore: meta?.segmented?.maskScore ?? null, v,
    // the label's QR code: what was read, whether it is this leaf's ID, and whether the clean copy went onto the archival image
    qr: meta?.qr ? { value: meta.qr.value ?? null, match: !!meta.qr.match, inserted: !!meta.qr.inserted, code: meta.qr.inserted ? (meta.qr.inserted.value || meta.qr.inserted.text || null) : null, note: meta.qr.note || meta.qr.error || null } : null,
    dpi: meta?.profile?.dpi ?? null, bits: meta?.profile?.bits ?? null, seconds: meta?.scanSeconds ?? null,
    width: meta?.tiff?.width ?? null, height: meta?.tiff?.height ?? null, note: meta?.note ?? null,
    capture: meta?.prescan?.capture ?? null,              // where the scan sits on the prescan, as fractions
    quality: meta?.quality ?? null,                       // color-fringing check: { verdict: ok | warn | bad | unknown, ranges, … }
  };
}

async function leaf(root, folder, id) {
  const [t, b] = await Promise.all([sideInfo(root, folder, id, 't'), sideInfo(root, folder, id, 'b')]);
  return { id, t, b };
}

/** Every leaf with at least one side in <root>/<folder>, newest first. */
async function listLeaves(root, folder) {
  const dir = scansDir(root, folder);
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const ids = new Set();
  for (const f of names) { const m = /^(.+)_(t|b)a(?:_lossy)?\.(?:tif|jxl)$/.exec(f); if (m) ids.add(m[1]); }
  const leaves = await Promise.all([...ids].map((id) => leaf(root, folder, id)));
  const newest = (l) => Math.max(l.t?.mtime || 0, l.b?.mtime || 0);
  return leaves.sort((a, b) => newest(b) - newest(a));
}

/** What is wrong with a side's label QR code, from its sidecar's `qr` ('' when it matched or was never looked for). */
function qrIssue(qr) {
  if (!qr || qr.match) return '';
  return qr.value == null ? 'QR code not read' : `QR code says ${qr.value}`;
}
const qrCache = new Map();      // sidecar path → { mtimeMs, issue }

/**
 * Progress of every leaf in <root>/<folder>: { <ID>: { s: 't' | 'b' | 'tb' (sides saved), warn: 'top: QR code not read; …' | '' } }.
 * Sides come from the file names; the QR problems from the sidecars (cached by modification time).
 */
async function statusMap(root, folder) {
  const dir = scansDir(root, folder);
  const out = {};
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    const m = /^(.+)_(t|b)a(?:_lossy)?\.(?:tif|jxl)$/.exec(f);
    if (!m) continue;
    const e = (out[m[1]] ||= { s: '', warn: '' });
    if (!e.s.includes(m[2])) e.s = m[2] === 't' ? `t${e.s}` : `${e.s}b`;
  }
  await Promise.all(Object.entries(out).flatMap(([id, e]) => [...e.s].map(async (side) => {
    const file = path.join(dir, `${id}_${side}.json`);
    try {
      const { mtimeMs } = await fsp.stat(file);
      let c = qrCache.get(file);
      if (!c || c.mtimeMs !== mtimeMs) { c = { mtimeMs, issue: qrIssue(JSON.parse(await fsp.readFile(file, 'utf8')).qr) }; qrCache.set(file, c); }
      if (c.issue) e[side] = c.issue;
    } catch { /* no sidecar: nothing known */ }
  })));
  for (const e of Object.values(out)) { e.warn = ['t', 'b'].filter((k) => e[k]).map((k) => `${SIDES[k].split(' ')[0]}: ${e[k]}`).join('; '); delete e.t; delete e.b; }
  return out;
}

module.exports = { scansDir, statusMap, qrIssue, SIDES, OUTPUTS, checkName, leafPaths, expectedPixels, tiffFacts, validate, checkStaged, sha256, commit, sidecarFor, leaf, listLeaves, retire, makePreview, sideInfo };
