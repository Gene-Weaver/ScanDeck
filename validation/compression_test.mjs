#!/usr/bin/env node
// Compression test for ScanDeck masters (default: the 1200 dpi, 16-bit RGB scan of a calibration run).
//
// Re-encodes one scan in several lossless formats, plus two lossy references. For each one it
// decodes the file back and checks it is bit-for-bit identical, measures size and encode/decode
// time, and checks whether macOS (Preview / ImageIO) opens it. It then writes compression.html with
// tight crops of one region (default: the postage stamp) cut from every decoded file.
//
// Usage:
//   node validation/compression_test.mjs                          # newest run with a 1200 dpi 16-bit scan
//   node validation/compression_test.mjs --run 2026-11-12_182223_10cm
//   node validation/compression_test.mjs --tiff path/to/scan.tiff --out some/dir
//   node validation/compression_test.mjs --crop 0.65,0.6,2.75,2.55 --detail 1.45,1.1,0.6   # cm from the scan's top-left
//   node validation/compression_test.mjs --run ID --html-only      # rebuild compression.html, no re-encoding
//
// Output: <out>/compression/ (encoded files and crops), <out>/compression.json, <out>/compression.html
// Needs (all Homebrew): ImageMagick, libtiff (tiffcp), jpeg-xl (cjxl/djxl), openjpeg, jpeg-turbo ≥ 3.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'validation_tests_out');
const SOURCE_NAME = 'scan_1200dpi_16bit.tiff';

const { values: opt } = parseArgs({ options: {
  run: { type: 'string' }, tiff: { type: 'string' }, out: { type: 'string' },
  crop: { type: 'string', default: '0.65,0.6,2.75,2.55' },        // postage stamp, cm: x,y,w,h
  detail: { type: 'string', default: '1.45,1.1,0.6' },            // red flower center, cm: x,y,size
  'html-only': { type: 'boolean', default: false },             // rebuild compression.html from compression.json
  help: { type: 'boolean', short: 'h', default: false },
} });
if (opt.help) { console.log('usage: node validation/compression_test.mjs [--run ID | --tiff FILE --out DIR] [--crop x,y,w,h] [--detail x,y,size]'); process.exit(0); }
const fail = (m) => { console.error(`error: ${m}`); process.exit(2); };

// ---- source ----------------------------------------------------------------------------------
function newestRunWithSource() {
  const dirs = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((d) => fs.existsSync(path.join(RUNS, d, SOURCE_NAME))).sort() : [];
  return dirs.length ? path.join(RUNS, dirs.at(-1)) : null;
}
let src, outDir;
if (opt.tiff) { src = path.resolve(opt.tiff); outDir = path.resolve(opt.out || path.dirname(src)); }
else {
  const run = opt.run ? path.join(RUNS, opt.run) : newestRunWithSource();
  if (!run) fail(`no calibration run with ${SOURCE_NAME}; pass --tiff`);
  src = path.join(run, SOURCE_NAME); outDir = run;
}
if (!fs.existsSync(src)) fail(`not found: ${src}`);
const work = path.join(outDir, 'compression');
if (opt['html-only']) {
  const saved = JSON.parse(fs.readFileSync(path.join(outDir, 'compression.json'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'compression.html'), html(saved));
  console.log(`Rebuilt ${path.join(outDir, 'compression.html')}`);
  process.exit(0);
}
fs.mkdirSync(work, { recursive: true });

const run = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26, ...o });
const timed = (fn) => { const t = performance.now(); fn(); return (performance.now() - t) / 1000; };
const sips = (file) => {
  const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'bitsPerSample', '-g', 'dpiWidth', file], { encoding: 'utf8' });
  const g = (k) => Number((new RegExp(`${k}:\\s*([\\d.]+)`).exec(r.stdout || '') || [])[1]) || null;
  return { ok: r.status === 0 && !!g('pixelWidth'), width: g('pixelWidth'), height: g('pixelHeight'), bits: g('bitsPerSample'), dpi: g('dpiWidth') };
};

const info = sips(src);
if (!info.ok) fail(`can't read ${src}`);
const dpi = info.dpi || 1200;
const pxPerCm = dpi / 2.54;
const nums = (s, n) => { const v = s.split(',').map(Number); if (v.length !== n || v.some((x) => !(x >= 0))) fail(`bad numbers: ${s}`); return v; };
const [cx, cy, cw, ch] = nums(opt.crop, 4).map((v) => Math.round(v * pxPerCm));
const [dx, dy, ds] = nums(opt.detail, 3).map((v) => Math.round(v * pxPerCm));
const stampGeom = `${cw}x${ch}+${cx}+${cy}`, detailGeom = `${ds}x${ds}+${dx}+${dy}`;
const rawBytes = info.width * info.height * 3 * 2;
console.log(`source  ${path.relative(ROOT, src)}  ${info.width} × ${info.height} px, ${info.bits}-bit, ${dpi} dpi, ${(fs.statSync(src).size / 1e6).toFixed(0)} MB (raw ${(rawBytes / 1e6).toFixed(0)} MB)`);
console.log(`crops   stamp ${stampGeom} px, detail ${detailGeom} px`);

// ---- helpers ---------------------------------------------------------------------------------
/** Pixel bytes of a binary PPM (skips the header and any comments). */
function ppmPixels(file) {
  const b = fs.readFileSync(file);
  let i = 0, fields = [];
  while (fields.length < 4) {
    while (/\s/.test(String.fromCharCode(b[i]))) i++;
    if (b[i] === 0x23) { while (b[i] !== 0x0a) i++; continue; }
    let s = ''; while (!/\s/.test(String.fromCharCode(b[i]))) s += String.fromCharCode(b[i++]);
    fields.push(s);
  }
  return { magic: fields[0], w: +fields[1], h: +fields[2], max: +fields[3], data: b.subarray(i + 1) };
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const metric = (m, a, b) => {
  const r = spawnSync('magick', ['compare', '-metric', m, a, b, 'null:'], { encoding: 'utf8' });   // exits 1 when images differ
  const out = (r.stderr || '').trim();
  if (/^inf/i.test(out)) return { value: Infinity, norm: 0 };
  const mm = /^([\d.eE+-]+)(?:\s*\(([\d.eE+-]+)\))?/.exec(out);
  return mm ? { value: Number(mm[1]), norm: mm[2] != null ? Number(mm[2]) : null } : null;
};

// Reference: the original pixels as a 16-bit PPM, its hash, its ICC profile, and a 16-bit PNG (cjxl input).
const refPpm = path.join(work, '_ref.ppm');
run('magick', [src, '-depth', '16', `ppm:${refPpm}`]);
const ref = ppmPixels(refPpm);
const refHash = sha(ref.data);
const icc = path.join(work, '_profile.icc');
try { run('magick', [src, `icc:${icc}`]); } catch { /* no profile */ }
const haveIcc = fs.existsSync(icc) && fs.statSync(icc).size > 0;

// ---- candidates ------------------------------------------------------------------------------
const C = [
  { key: 'tiff-lzw', label: 'TIFF · LZW (as scanned)', ext: 'tiff', lossless: true, original: true, note: 'What the Epson driver writes. Opens everywhere.' },
  { key: 'tiff-none', label: 'TIFF · uncompressed', ext: 'tif', lossless: true, note: 'Opens everywhere.',
    enc: (o) => run('tiffcp', ['-c', 'none', src, o]) },
  { key: 'tiff-zip', label: 'TIFF · ZIP + predictor', ext: 'tif', lossless: true, note: 'Deflate. Opens in Preview, Photoshop, Fiji, Python.',
    enc: (o) => run('tiffcp', ['-c', 'zip:2:p9', src, o]) },
  { key: 'tiff-zstd', label: 'TIFF · ZSTD + predictor', ext: 'tif', lossless: true, note: 'Needs a recent libtiff (Python tifffile, GDAL).',
    enc: (o) => run('tiffcp', ['-c', 'zstd:2:p12', src, o]) },
  { key: 'tiff-lzma', label: 'TIFF · LZMA + predictor', ext: 'tif', lossless: true, note: 'Needs a recent libtiff (Python tifffile, GDAL).',
    enc: (o) => run('tiffcp', ['-c', 'lzma:2:p6', src, o]) },
  { key: 'png16', label: 'PNG · 16-bit', ext: 'png', lossless: true, note: 'Opens everywhere; no TIFF tags.',
    enc: (o) => run('magick', [src, '-depth', '16', '-define', 'png:compression-level=9', o]) },
  { key: 'jp2', label: 'JPEG 2000 · lossless', ext: 'jp2', lossless: true, note: 'Archival standard (Library of Congress). Fiji, Python (glymur).',
    enc: (o) => run('opj_compress', ['-i', src, '-o', o, '-threads', 'ALL_CPUS']),
    dec: (f, o) => run('opj_decompress', ['-i', f, '-o', o, '-threads', 'ALL_CPUS']) },
  { key: 'jxl', label: 'JPEG XL · lossless', ext: 'jxl', lossless: true, note: 'Newest. Preview (macOS 14+), Photoshop 2023+, Python (imagecodecs).',
    enc: (o) => run('cjxl', [pngFor(), o, '-d', '0', '-e', '7', '--quiet']), dec: (f, o) => run('djxl', [f, o, '--quiet']) },
  { key: 'ljpeg', label: 'JPEG · lossless (ITU T.81)', ext: 'jpg', lossless: true, note: 'Old lossless JPEG mode. Few viewers read it.',
    enc: (o) => run('cjpeg', ['-precision', '16', '-lossless', '1', ...(haveIcc ? ['-icc', icc] : []), '-outfile', o, refPpm]),
    dec: (f, o) => run('djpeg', ['-outfile', o, f]) },
  { key: 'jxl-d1', label: 'JPEG XL · lossy, distance 1', ext: 'jxl', lossless: false, note: '“Visually lossless”; not bit-exact.',
    enc: (o) => run('cjxl', [pngFor(), o, '-d', '1', '-e', '7', '--quiet']), dec: (f, o) => run('djxl', [f, o, '--quiet']) },
  { key: 'jpeg-q95', label: 'JPEG · quality 95, 8-bit', ext: 'jpg', lossless: false, note: 'An ordinary JPG: drops to 8-bit and compresses lossily.',
    enc: (o) => run('magick', [src, '-depth', '8', '-quality', '95', o]), dec: (f, o) => run('djpeg', ['-outfile', o, f]) },
];
// cjxl reads PNG (with the ICC profile) but not TIFF: reuse the PNG candidate's file.
const pngFor = () => path.join(work, 'png16.png');

// ---- run -------------------------------------------------------------------------------------
const results = [];
for (const c of C) {
  const file = c.original ? src : path.join(work, `${c.key}.${c.ext}`);
  process.stdout.write(`${c.label.padEnd(30)} `);
  const r = { key: c.key, label: c.label, lossless: c.lossless, note: c.note, file: path.relative(outDir, file) };
  try {
    r.encodeS = c.original ? null : timed(() => c.enc(file));
    r.bytes = fs.statSync(file).size;
    const dec = path.join(work, `_dec_${c.key}.ppm`);
    r.decodeS = timed(() => (c.dec ? c.dec(file, dec) : run('magick', [file, '-depth', '16', `ppm:${dec}`])));
    const d = ppmPixels(dec);
    r.exact = d.max === 65535 && d.w === ref.w && d.h === ref.h && sha(d.data) === refHash;
    if (!r.exact) {
      const psnr = metric('PSNR', refPpm, dec), pae = metric('PAE', refPpm, dec);
      r.psnr = psnr?.value ?? null;
      r.maxError16 = pae?.norm != null ? Math.round(pae.norm * 65535) : null;
    }
    const p = sips(file);
    r.opensInPreview = p.ok; r.previewBits = p.bits;
    // crops from the decoded pixels (8-bit PNGs for display)
    const base = path.join(work, `crop_${c.key}`);
    run('magick', [dec, '-crop', stampGeom, '+repage', '-depth', '8', `${base}_stamp.png`]);
    run('magick', [dec, '-crop', detailGeom, '+repage', '-depth', '8', `${base}_detail.png`]);
    r.crops = { stamp: path.relative(outDir, `${base}_stamp.png`), detail: path.relative(outDir, `${base}_detail.png`) };
    if (!r.exact) {
      run('magick', [refPpm, dec, '-crop', detailGeom, '+repage', '-compose', 'difference', '-composite', '-evaluate', 'multiply', '16', '-depth', '8', `${base}_diff16.png`]);
      r.crops.diff = path.relative(outDir, `${base}_diff16.png`);
    }
    fs.rmSync(dec, { force: true });
    console.log(`${(r.bytes / 1e6).toFixed(0).padStart(5)} MB  ${String(Math.round((r.bytes / rawBytes) * 100)).padStart(3)}% of raw  enc ${r.encodeS == null ? '  — ' : r.encodeS.toFixed(1).padStart(4) + 's'}  dec ${r.decodeS.toFixed(1).padStart(4)}s  ${r.exact ? 'bit-exact' : `LOSSY psnr ${r.psnr?.toFixed(1)} dB, max err ${r.maxError16}`}  preview ${r.opensInPreview ? 'yes' : 'no'}`);
    if (c.lossless && !r.exact) r.error = 'expected lossless but pixels differ';
  } catch (e) {
    r.error = String(e.stderr || e.message).trim().split('\n')[0];
    console.log(`FAILED: ${r.error}`);
  }
  results.push(r);
}
fs.rmSync(refPpm, { force: true });
const refCrop = { stamp: results[0].crops?.stamp, detail: results[0].crops?.detail };

const summary = {
  created: new Date().toISOString(),
  source: { file: path.relative(outDir, src), width: info.width, height: info.height, bits: info.bits, dpi, bytes: fs.statSync(src).size, rawBytes, icc: haveIcc },
  crop: { stamp: { cm: nums(opt.crop, 4), px: stampGeom }, detail: { cm: nums(opt.detail, 3), px: detailGeom } },
  reference: refCrop, results,
};
fs.writeFileSync(path.join(outDir, 'compression.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, 'compression.html'), html(summary));
console.log(`\nOpen ${path.join(outDir, 'compression.html')}`);

// ---- page ------------------------------------------------------------------------------------
function html(s) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const mb = (b) => (b == null ? '—' : `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`);
  const sec = (v) => (v == null ? '—' : `${v.toFixed(1)} s`);
  const geom = (g) => { const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(g); return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] }; };
  const st = geom(s.crop.stamp.px), dt = geom(s.crop.detail.px);
  const best = Math.min(...s.results.filter((r) => r.exact).map((r) => r.bytes));
  const quality = (r) => (r.exact ? 'bit-exact' : r.psnr != null ? `lossy · ${r.psnr === Infinity ? '∞' : r.psnr.toFixed(1)} dB` : '');
  // Everything the compare popup can show: the original first, then each decoded version.
  const items = [{ label: 'Original', note: 'as scanned', stamp: s.reference.stamp },
    ...s.results.filter((r) => r.crops && r.key !== 'tiff-lzw').map((r) => ({ label: r.label, note: `${mb(r.bytes)} · ${quality(r)}`, stamp: r.crops.stamp }))];
  const data = { items, stamp: { w: st.w, h: st.h }, detail: { x: dt.x - st.x, y: dt.y - st.y, size: dt.w } };

  const rows = s.results.map((r) => `<tr class="${r.lossless ? '' : 'lossy'}">
    <td>${esc(r.label)}</td>
    <td class="num">${mb(r.bytes)}</td><td class="num">${r.bytes ? Math.round((r.bytes / s.source.rawBytes) * 100) + '%' : '—'}</td>
    <td class="num">${sec(r.encodeS)}</td><td class="num">${sec(r.decodeS)}</td>
    <td>${r.error ? `<span class="bad">${esc(r.error)}</span>` : r.exact ? '<span class="ok">bit-exact</span>' : `<span class="warn">${esc(quality(r))} · max ±${r.maxError16}</span>`}</td>
    <td>${r.opensInPreview ? 'yes' : '<span class="muted">no</span>'}</td>
    <td class="muted">${esc(r.note)}${r.exact && r.bytes === best ? ' <b class="ok">smallest</b>' : ''}</td></tr>`).join('');
  const itemIndex = (stamp) => items.findIndex((it) => it.stamp === stamp);
  const card = (label, sub, crops, cls = '') => `<figure class="card ${cls}">
      <figcaption><b>${esc(label)}</b> <span class="muted">${esc(sub)}</span></figcaption>
      <img class="stamp" src="${esc(crops.stamp)}" data-i="${itemIndex(crops.stamp)}" alt="">
      <div class="pair">
        <img class="px" src="${esc(crops.detail)}" data-i="${itemIndex(crops.stamp)}" alt="" title="Detail, actual pixels">
        ${crops.diff ? `<img class="px" src="${esc(crops.diff)}" data-i="${itemIndex(crops.stamp)}" alt="" title="Difference from the original ×16">` : '<div class="px empty"></div>'}
      </div>
    </figure>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScanDeck compression</title>
<style>
:root { --bg:#f6f6f3; --fg:#1c1c1a; --muted:#6a6a64; --card:#fff; --line:#e1e1da; --ok:#1d7a3a; --warn:#9a5a00; --bad:#b3261e; --accent:#14958a; --pane:#e9e9e4; }
@media (prefers-color-scheme: dark) { :root { --bg:#15171c; --fg:#e8eaf0; --muted:#8b93a3; --card:#1d2027; --line:#30353f; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; --accent:#2ec4b6; --pane:#0d0f12; } }
* { box-sizing:border-box; }
body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system, system-ui, sans-serif; }
main { max-width:1280px; margin:0 auto; }
h1 { font-size:21px; margin:0 0 2px; } .muted { color:var(--muted); } .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
button, select { font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:7px; padding:4px 10px; cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#03201d; font-weight:700; }
.scroll { overflow-x:auto; margin:16px 0; }
table { border-collapse:collapse; width:100%; background:var(--card); border:1px solid var(--line); border-radius:8px; }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; } th { font-weight:600; color:var(--muted); }
td.num { text-align:right; font-variant-numeric:tabular-nums; } tr.lossy td:first-child { font-style:italic; }
.bar { display:flex; gap:10px; align-items:center; margin:0 0 14px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:12px; }
.card { margin:0; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px; }
.card.lossy { border-style:dashed; } .card.ref { border-color:var(--accent); }
figcaption { margin-bottom:8px; font-size:13px; }
img { cursor:zoom-in; }
img.stamp { width:100%; display:block; border-radius:4px; }
.pair { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px; }   /* same size in every card */
.pair .px { width:100%; aspect-ratio:1; display:block; image-rendering:pixelated; border-radius:4px; }
.pair .empty { background:var(--pane); }
/* compare popup */
.cmp { position:fixed; inset:0; z-index:10; background:var(--bg); display:flex; flex-direction:column; }
.cmp.hidden { display:none; }
.cmp-bar { display:flex; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
.cmp-bar .spacer { flex:1; } .cmp-bar .z { min-width:9em; text-align:center; font-variant-numeric:tabular-nums; }
.panes { flex:1; min-height:0; display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:6px; }
.pane { position:relative; overflow:hidden; background:var(--pane); border-radius:6px; cursor:grab; touch-action:none; user-select:none; }
.pane.drag { cursor:grabbing; }
.pane img { position:absolute; left:0; top:0; transform-origin:0 0; max-width:none; image-rendering:pixelated; cursor:inherit; pointer-events:none; }
.pane.smooth img { image-rendering:auto; }
.pane select { position:absolute; left:8px; top:8px; z-index:2; max-width:calc(100% - 16px); }
.pane .note { position:absolute; left:8px; bottom:8px; z-index:2; font-size:12px; background:var(--card); border:1px solid var(--line); border-radius:6px; padding:2px 8px; }
</style></head><body><main>
<h1>Compression · ${s.source.dpi} dpi · ${s.source.bits}-bit</h1>
<div class="muted">${esc(s.source.file)} · ${s.source.width} × ${s.source.height} px · raw ${mb(s.source.rawBytes)} · ${esc(s.created.slice(0, 16).replace('T', ' '))}</div>
<div class="scroll"><table><thead><tr><th>Format</th><th>Size</th><th>of raw</th><th>Encode</th><th>Decode</th><th>Pixels</th><th>Preview</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="bar"><button class="primary" id="openCmp">Compare side by side</button><span class="muted">or click any image</span></div>
<div class="grid">
  ${card('Original', 'stamp · detail at actual pixels', s.reference, 'ref')}
  ${s.results.filter((r) => r.crops && r.key !== 'tiff-lzw').map((r) => card(r.label, `${mb(r.bytes)} · ${quality(r)}`, r.crops, r.lossless ? '' : 'lossy')).join('')}
</div>
</main>

<div class="cmp hidden" id="cmp">
  <div class="cmp-bar">
    <strong>Compare</strong><span class="muted">drag to pan · scroll to zoom · ← → change right · Esc</span>
    <span class="spacer"></span>
    <button id="zDetail" title="Zoom to the detail area">Detail</button><button id="zFit">Fit</button>
    <button id="zOut">−</button><span class="z" id="zLbl"></span><button id="zIn">+</button>
    <button id="cmpClose">Close</button>
  </div>
  <div class="panes">
    <div class="pane" id="paneA"><select id="selA"></select><img id="imgA" alt=""><div class="note" id="noteA"></div></div>
    <div class="pane" id="paneB"><select id="selB"></select><img id="imgB" alt=""><div class="note" id="noteB"></div></div>
  </div>
</div>

<script>
// Side-by-side compare. Both panes are the same size and share one view (scale + offset), so the same
// image pixel sits at the same spot in each. Zoom steps are whole screen pixels per image pixel
// (1, 2, 3, 4, 6, 8 … device pixels), offsets snap to the device-pixel grid: every image pixel is drawn
// as an identical square block in both panes.
var DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
var $ = function (id) { return document.getElementById(id); };
var dpr = window.devicePixelRatio || 1;
var LEVELS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
var W = DATA.stamp.w, H = DATA.stamp.h;
var view = { s: 1, x: 0, y: 0 }, a = 0, b = 1;
var panes = [$('paneA'), $('paneB')], imgs = [$('imgA'), $('imgB')];
imgs.forEach(function (im) { im.style.width = W + 'px'; im.style.height = H + 'px'; });

function snap(v) { return Math.round(v * dpr) / dpr; }
function size() { var r = panes[0].getBoundingClientRect(); return { w: r.width, h: r.height }; }
function apply() {
  var t = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.s + ')';
  imgs.forEach(function (im) { im.style.transform = t; });
  panes.forEach(function (p) { p.classList.toggle('smooth', view.s * dpr < 1); });
  var px = view.s * dpr;
  $('zLbl').textContent = px >= 1 ? '1 px = ' + Math.round(px) + ' screen px' : 'fit (' + Math.round(view.s * 100) + '%)';
}
function clamp() {
  var z = size(), iw = W * view.s, ih = H * view.s;
  view.x = snap(Math.min(z.w / 2, Math.max(view.x, z.w / 2 - iw)));
  view.y = snap(Math.min(z.h / 2, Math.max(view.y, z.h / 2 - ih)));
}
function zoomAt(level, cx, cy) {                    // level = device px per image px; (cx, cy) stays put
  var ix = (cx - view.x) / view.s, iy = (cy - view.y) / view.s;
  view.s = level / dpr; view.x = snap(cx - ix * view.s); view.y = snap(cy - iy * view.s);
  clamp(); apply();
}
function step(dir, cx, cy) {
  var cur = view.s * dpr, next = null;
  if (dir > 0) next = LEVELS.find(function (l) { return l > cur + 1e-6; });
  else next = LEVELS.slice().reverse().find(function (l) { return l < cur - 1e-6; });
  if (next == null) { if (dir < 0) fit(); return; }
  var z = size();
  zoomAt(next, cx == null ? z.w / 2 : cx, cy == null ? z.h / 2 : cy);
}
function fit() { var z = size(); view.s = Math.min(z.w / W, z.h / H); view.x = snap((z.w - W * view.s) / 2); view.y = snap((z.h - H * view.s) / 2); apply(); }
function focusDetail() {                            // the largest whole zoom at which the detail area fits
  var z = size(), d = DATA.detail;
  var lvl = LEVELS.filter(function (l) { return d.size * l / dpr <= Math.min(z.w, z.h) * 0.95; }).pop() || 1;
  view.s = lvl / dpr; view.x = snap(z.w / 2 - (d.x + d.size / 2) * view.s); view.y = snap(z.h / 2 - (d.y + d.size / 2) * view.s); apply();
}
function show() {
  [a, b].forEach(function (k, i) {
    imgs[i].src = DATA.items[k].stamp;
    $(i ? 'noteB' : 'noteA').textContent = DATA.items[k].note;
    $(i ? 'selB' : 'selA').value = String(k);
  });
}
function open(right) {
  a = 0; b = right > 0 ? right : 1;
  $('cmp').classList.remove('hidden'); document.body.style.overflow = 'hidden';
  show(); focusDetail();
}
function close() { $('cmp').classList.add('hidden'); document.body.style.overflow = ''; }

['selA', 'selB'].forEach(function (id) {
  $(id).innerHTML = DATA.items.map(function (it, i) { return '<option value="' + i + '">' + it.label.replace(/</g, '&lt;') + '</option>'; }).join('');
});
$('selA').onchange = function () { a = Number(this.value); show(); };
$('selB').onchange = function () { b = Number(this.value); show(); };
$('zIn').onclick = function () { step(1); }; $('zOut').onclick = function () { step(-1); };
$('zFit').onclick = fit; $('zDetail').onclick = focusDetail; $('cmpClose').onclick = close;
$('openCmp').onclick = function () { open(1); };
document.querySelectorAll('main img[data-i]').forEach(function (im) { im.onclick = function () { open(Number(im.dataset.i)); }; });

// one drag pans both panes
var drag = null;
panes.forEach(function (p) {
  p.addEventListener('pointerdown', function (e) {
    if (e.target.tagName === 'SELECT') return;
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, pane: p }; p.setPointerCapture(e.pointerId); p.classList.add('drag');
  });
  p.addEventListener('pointermove', function (e) {
    if (!drag) return;
    view.x = drag.vx + (e.clientX - drag.x); view.y = drag.vy + (e.clientY - drag.y); clamp(); apply();
  });
  p.addEventListener('pointerup', function () { if (drag) drag.pane.classList.remove('drag'); drag = null; });
  p.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (Math.abs(e.deltaY) < 1) return;
    var r = p.getBoundingClientRect();
    step(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
});
document.addEventListener('keydown', function (e) {
  if ($('cmp').classList.contains('hidden')) return;
  if (e.key === 'Escape') close();
  else if (e.key === '+' || e.key === '=') step(1);
  else if (e.key === '-') step(-1);
  else if (e.key === '0') fit();
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    var n = DATA.items.length;
    b = (b + (e.key === 'ArrowRight' ? 1 : n - 1)) % n; show();
  }
});
window.addEventListener('resize', function () { if (!$('cmp').classList.contains('hidden')) { clamp(); apply(); } });
</script>
</body></html>
`;
}
