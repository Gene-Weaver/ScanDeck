import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { patternSeries, defaultPattern } from '../src/renderer/js/pattern.js';
import { estimate, msPerLine, OVERHEAD_S } from '../src/renderer/js/estimate.js';
import { pixelsFor, areaLabel } from '../src/renderer/js/util.js';

const require = createRequire(import.meta.url);
const leaves = require('../src/main/leaves.js');
const { areaArg, listRuns } = require('../src/main/calibration.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scandeck-test-'));
const hasMagick = (() => { try { execFileSync('which', ['magick'], { stdio: 'ignore' }); return true; } catch { return false; } })();
function makeTiff(file, { w, h, bits = 8, dpi = 300 }) {
  execFileSync('magick', ['-size', `${w}x${h}`, 'gradient:#103030-#e0f0f0', '-depth', String(bits), '-units', 'PixelsPerInch', '-density', String(dpi), '-compress', 'LZW', file]);
}

test('leaf IDs follow the TapeDeck pattern, last segment fastest', () => {
  const p = defaultPattern();
  const at = (n) => patternSeries({ ...p, from: n, to: n }).values[0].text;
  assert.equal(patternSeries({ ...p, from: 1, to: 1 }).total, 52 * 3);
  assert.deepEqual([1, 2, 3, 4].map(at), ['UM-001-A', 'UM-001-B', 'UM-001-C', 'UM-002-A']);
  assert.equal(at(156), 'UM-052-C');
});

test('scan areas and pixel sizes', () => {
  assert.deepEqual(pixelsFor({ mode: '10cm' }, 1200), { w: 4724, h: 4724 });
  assert.deepEqual(pixelsFor({ mode: 'full' }, 150), { w: 1275, h: 1755 });
  assert.deepEqual(pixelsFor({ mode: 'custom', wCm: 15, hCm: 25 }, 600), { w: 3543, h: 5906 });
  assert.equal(areaLabel({ mode: 'custom', wCm: 15, hCm: 25 }), '15 × 25 cm');
  assert.deepEqual(leaves.expectedPixels({ full: true }, 150), { w: 1275, h: 1755 });
  assert.equal(areaArg({ mode: '10cm', wCm: 10, hCm: 10 }), '10cm');
  assert.equal(areaArg({ mode: 'custom', wCm: 15, hCm: 25 }), '15x25cm');
  assert.equal(areaArg({ mode: 'full' }), 'full');
});

test('estimates use the measured line time at the same dpi and the measured size ratio', () => {
  // the 2026-11-12 run: 1200 dpi, 10 cm → 4724 lines, 53.6 s; 16-bit file 178 MB vs 134 MB raw
  const runs = [{ id: 'r1', results: [
    { dpi: 1200, bits: 16, h: 4724, scanSeconds: 53.6, fileBytes: 178e6, rawBytes: 4724 * 4724 * 6 },
    { dpi: 1200, bits: 8, h: 4724, scanSeconds: 53.6, fileBytes: 43e6, rawBytes: 4724 * 4724 * 3 },
  ] }];
  assert.ok(Math.abs(msPerLine(runs[0].results[0]) - ((53.6 - OVERHEAD_S) / 4724) * 1000) < 1e-9);
  const same = estimate({ dpi: 1200, bits: 16, area: { mode: '10cm' } }, runs);
  assert.ok(Math.abs(same.seconds - 53.6) < 0.01);
  assert.ok(Math.abs(same.bytes - 178e6) < 1);
  const tall = estimate({ dpi: 1200, bits: 8, area: { mode: 'custom', wCm: 10, hCm: 20 } }, runs);
  assert.ok(tall.seconds > 95 && tall.seconds < 100, `${tall.seconds}`);   // twice the lines, same overhead
  const unknown = estimate({ dpi: 2400, bits: 8, area: { mode: '10cm' } }, runs);
  assert.equal(unknown.seconds, null);
});

test('file names: only safe IDs and folders', () => {
  for (const bad of ['../x', 'a/b', '', '.hidden', 'a b', 'UM-001-A/..']) assert.throws(() => leaves.checkName(bad));
  for (const ok of ['UM-001-A', 'scans', 'MICH_001234.L3']) assert.equal(leaves.checkName(ok), ok);
  const p = leaves.leafPaths('/r', 'UM', 'UM-001-A', 't');
  assert.equal(p.tiff, '/r/UM/scans/UM-001-A_ta.tif');
  assert.equal(p.sidecar, '/r/UM/scans/UM-001-A_t.json');
  assert.equal(p.retakes, '/r/UM/retakes');
  assert.equal(p.preview, '/r/UM/previews/UM-001-A_ta.jpg');
  assert.throws(() => leaves.leafPaths('/r', 'UM', 'UM-001-A', 'x'));
});

test('commit validates, keeps retakes, and never overwrites', { skip: !hasMagick && 'needs ImageMagick' }, async () => {
  const root = tmp();
  const staging = path.join(root, '.staging'); fs.mkdirSync(staging);
  const area = { full: false, w: 1, h: 0.5 };
  const profile = { dpi: 300, bits: 8 };
  const report = { accepted: { dpi: 300, bitDepth: 8 }, scanSeconds: 9.1 };

  const s1 = path.join(staging, 'a.tiff'); makeTiff(s1, { w: 300, h: 150 });
  const first = await leaves.commit({ root, folder: 'UM', id: 'UM-001-A', side: 't', staged: s1, report, profile, area, appVersion: 't' });
  assert.equal(first.name, 'UM-001-A_ta.tif');
  assert.equal(first.retakes, 0);
  assert.ok(fs.existsSync(path.join(root, 'UM', 'previews', 'UM-001-A_ta.jpg')));
  const side1 = JSON.parse(fs.readFileSync(path.join(root, 'UM', 'scans', 'UM-001-A_t.json'), 'utf8'));
  assert.equal(side1.tiff.width, 300); assert.match(side1.outputs[0].sha256, /^[0-9a-f]{64}$/);

  const s2 = path.join(staging, 'b.tiff'); makeTiff(s2, { w: 300, h: 150 });
  const second = await leaves.commit({ root, folder: 'UM', id: 'UM-001-A', side: 't', staged: s2, report, profile, area, appVersion: 't' });
  assert.equal(second.retakes, 1);
  for (const f of ['UM-001-A_ta-r1.tif', 'UM-001-A_t-r1.json', 'UM-001-A_ta-r1.jpg']) assert.ok(fs.existsSync(path.join(root, 'UM', 'retakes', f)), f);

  const wrong = path.join(staging, 'c.tiff'); makeTiff(wrong, { w: 200, h: 150 });
  await assert.rejects(leaves.commit({ root, folder: 'UM', id: 'UM-001-A', side: 'b', staged: wrong, report, profile, area, appVersion: 't' }), /rejected/);
  assert.ok(fs.existsSync(path.join(staging, 'rejected', 'c.tiff')));
  assert.equal(fs.existsSync(path.join(root, 'UM', 'scans', 'UM-001-A_ba.tif')), false);

  const driverChanged = path.join(staging, 'd.tiff'); makeTiff(driverChanged, { w: 300, h: 150 });
  await assert.rejects(leaves.commit({ root, folder: 'UM', id: 'UM-001-A', side: 'b', staged: driverChanged, report: { accepted: { dpi: 150, bitDepth: 8 } }, profile, area, appVersion: 't' }), /150 dpi/);

  const list = await leaves.listLeaves(root, 'UM');
  assert.deepEqual(list.map((l) => l.id), ['UM-001-A']);
  assert.ok(list[0].t && !list[0].b);
  fs.rmSync(root, { recursive: true, force: true });
});

test('calibration runs are read from summary.json, newest first', () => {
  const root = tmp();
  for (const [id, finished] of [['2026-11-12_175915_10cm', true], ['2026-11-13_090000_fullbed', false]]) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'summary.json'), JSON.stringify({ meta: { finished: finished ? 'x' : null }, results: [{ status: 'OK' }, { status: 'CHECK: x' }] }));
  }
  fs.mkdirSync(path.join(root, 'not-a-run'));
  const runs = listRuns(root);
  assert.deepEqual(runs.map((r) => r.id), ['2026-11-13_090000_fullbed', '2026-11-12_175915_10cm']);
  assert.equal(runs[1].ok, 1); assert.equal(runs[1].total, 2); assert.equal(runs[0].finished, false);
  fs.rmSync(root, { recursive: true, force: true });
});

const { Saver, normalizeFormats } = require('../src/main/save.js');
const hasJxl = (() => { try { execFileSync('which', ['cjxl']); execFileSync('which', ['djxl']); return hasMagick; } catch { return false; } })();

test('format choice never ends up empty', () => {
  assert.deepEqual(normalizeFormats(), { jxl: false, jxlLossy: true, tiff: false });
  assert.deepEqual(normalizeFormats({}), { jxl: false, jxlLossy: false, tiff: true });
  const runs = [{ id: 'r', results: [], compression: { source: { rawBytes: 100 }, results: [{ key: 'jxl', bytes: 70 }, { key: 'jxl-d1', bytes: 3 }] } }];
  const e = estimate({ dpi: 100, bits: 16, area: { mode: 'custom', wCm: 2.54, hCm: 2.54 }, formats: { jxl: true, jxlLossy: true } }, runs);
  assert.equal(e.rawBytes, 100 * 100 * 6);
  assert.ok(Math.abs(e.bytes - e.rawBytes * 0.73) < 1e-6);
  assert.deepEqual(e.parts.map((p) => p.format), ['jxl', 'jxlLossy']);
});

test('saver: JPEG XL lossless (verified) + lossy, TIFF deleted, retakes keep every file, jobs resume', { skip: !hasJxl && 'needs cjxl, djxl and ImageMagick' }, async () => {
  const root = tmp(), staging = path.join(root, '.staging'); fs.mkdirSync(staging);
  const area = { full: false, w: 1, h: 0.5 }, profile = { dpi: 300, bits: 16 };
  const report = { accepted: { dpi: 300, bitDepth: 16 }, scanSeconds: 9 };
  const stage = (name) => {
    const f = path.join(staging, `${name}.tiff`);
    execFileSync('magick', ['-size', '300x150', 'plasma:', '-attenuate', '0.4', '+noise', 'Gaussian', '-depth', '16', '-units', 'PixelsPerInch', '-density', '300', '-compress', 'LZW', f]);
    return f;
  };
  const done = [];
  let wake = null;
  const saver = new Saver({ appVersion: 't', onDone: (r) => { done.push(r); if (wake) wake(); } });
  const waitFor = (n) => new Promise((res) => { const check = () => (done.length >= n ? res() : (wake = check)); check(); });
  const job = async (name, formats) => {
    const staged = stage(name);
    const facts = await leaves.checkStaged({ staged, report, profile, area });
    await saver.enqueue({ root, folder: 'UM', id: 'UM-001-A', side: 't', staged, stagedPreview: null, formats, report, profile, area, facts });
    return staged;
  };

  const s1 = await job('a', { jxl: true, jxlLossy: true });
  assert.ok(saver.pendingFor(root, 'UM', 'UM-001-A', 't'));
  await waitFor(1);
  assert.equal(done[0].ok, true, done[0].error);
  const home = path.join(root, 'UM'), dir = path.join(home, 'scans');
  assert.ok(fs.existsSync(path.join(dir, 'UM-001-A_ta.jxl')));
  assert.ok(fs.existsSync(path.join(dir, 'UM-001-A_ta_lossy.jxl')));
  assert.equal(fs.existsSync(path.join(dir, 'UM-001-A_ta.tif')), false);
  assert.equal(fs.existsSync(s1), false);
  const side = JSON.parse(fs.readFileSync(path.join(dir, 'UM-001-A_t.json'), 'utf8'));
  assert.deepEqual(side.outputs.map((o) => o.format), ['jxl', 'jxlLossy']);
  assert.match(side.outputs[0].verified, /identical/);
  assert.equal(side.tiffDeleted, true);
  assert.deepEqual(fs.readdirSync(staging), []);
  const info = await leaves.sideInfo(root, 'UM', 'UM-001-A', 't');
  assert.equal(info.name, 'UM-001-A_ta.jxl');
  assert.equal(info.files.length, 2);

  await job('b', { jxl: true, jxlLossy: true });    // retake
  await waitFor(2);
  assert.equal(done[1].ok, true, done[1].error);
  for (const f of ['UM-001-A_ta-r1.jxl', 'UM-001-A_ta_lossy-r1.jxl', 'UM-001-A_t-r1.json']) assert.ok(fs.existsSync(path.join(home, 'retakes', f)), f);
  assert.equal((await leaves.sideInfo(root, 'UM', 'UM-001-A', 't')).retakes, 1);

  await job('c', { tiff: true });                   // TIFF output still works
  await waitFor(3);
  assert.equal(done[2].ok, true, done[2].error);
  assert.ok(fs.existsSync(path.join(dir, 'UM-001-A_ta.tif')));
  assert.equal(fs.existsSync(path.join(dir, 'UM-001-A_ta.jxl')), false);
  const tifSide = JSON.parse(fs.readFileSync(path.join(dir, 'UM-001-A_t.json'), 'utf8'));
  assert.equal(tifSide.outputs[0].compression, 'none');           // rewritten uncompressed and checked; the driver's LZW file is gone
  assert.match(tifSide.outputs[0].verified, /identical/);
  assert.equal(tifSide.tiffDeleted, true); assert.equal(tifSide.note ?? null, null);
  assert.match(execFileSync('magick', ['identify', '-format', '%C %z %x', path.join(dir, 'UM-001-A_ta.tif')]).toString(), /^None 16 300/);
  assert.deepEqual(fs.readdirSync(staging), []);

  // a job left in .staging by a quit is picked up again
  const staged = stage('d');
  const facts = await leaves.checkStaged({ staged, report, profile, area });
  fs.writeFileSync(staged.replace('.tiff', '.job.json'), JSON.stringify({ root, folder: 'UM', id: 'UM-002-A', side: 'b', staged, stagedPreview: null, formats: { jxlLossy: true }, report, profile, area, facts }));
  assert.equal(await saver.recover([root]), 1);
  await waitFor(4);
  assert.equal(done[3].ok, true, done[3].error);
  assert.ok(fs.existsSync(path.join(dir, 'UM-002-A_ba_lossy.jxl')));
  assert.deepEqual((await leaves.listLeaves(root, 'UM')).map((l) => l.id).sort(), ['UM-001-A', 'UM-002-A']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('saver: plant crop (_tp) and segmented plant crop (_tl) next to the whole scan (_ta); retired with a retake; failures do not fail the save', { skip: !hasJxl && 'needs cjxl, djxl and ImageMagick' }, async () => {
  const root = tmp(), staging = path.join(root, '.staging'); fs.mkdirSync(staging);
  const area = { full: false, w: 1, h: 0.5 }, profile = { dpi: 300, bits: 16 }, report = { accepted: { dpi: 300, bitDepth: 16 }, scanSeconds: 9 };
  // stand-in segmenter: the plant is the 200 x 100 px box at (40, 20); the mask keeps the left half of whatever it is given
  let fail = false;
  const sizes = [];
  const segmenter = {
    plantBox: async () => ({ box: [40, 20, 200, 100], from: 'test', used: [] }),
    mask: async ({ width, height, stem }) => {
      if (fail) throw new Error('boom');
      sizes.push([width, height]);
      const mask = `${stem}.mask.png`;
      execFileSync('magick', ['-size', `${width}x${height}`, 'xc:black', '-fill', 'white', '-draw', `rectangle 0,0 ${width / 2 - 1},${height}`, '-depth', '8', mask]);
      return { mask, keptFraction: 0.5, crops: [], ms: {} };
    },
  };
  const done = [];
  let wake = null;
  const saver = new Saver({ appVersion: 't', segmenter, onDone: (r) => { done.push(r); if (wake) wake(); } });
  const waitFor = (n) => new Promise((res) => { const check = () => (done.length >= n ? res() : (wake = check)); check(); });
  const job = async (name, formats) => {
    const staged = path.join(staging, `${name}.tiff`);
    execFileSync('magick', ['-size', '300x150', 'plasma:', '-attenuate', '0.4', '+noise', 'Gaussian', '-evaluate', 'add', '10%', '-depth', '16', '-units', 'PixelsPerInch', '-density', '300', '-compress', 'LZW', staged]);
    const facts = await leaves.checkStaged({ staged, report, profile, area });
    execFileSync('magick', [staged, '-depth', '16', `ppm:${path.join(root, `${name}.orig.ppm`)}`]);
    await saver.enqueue({ root, folder: 'UM', id: 'UM-001-A', side: 't', staged, stagedPreview: null, formats, report, profile, area, facts, segment: true });
  };
  const home = path.join(root, 'UM'), dir = path.join(home, 'scans');
  await job('a', { jxl: true, jxlLossy: true });      // lossless on → the plant crop and the segmented file are lossless too
  await waitFor(1);
  assert.equal(done[0].ok, true, done[0].error);
  const sc = JSON.parse(fs.readFileSync(path.join(dir, 'UM-001-A_t.json'), 'utf8'));
  assert.deepEqual(sc.outputs.map((o) => o.name).sort(), ['UM-001-A_ta.jxl', 'UM-001-A_ta_lossy.jxl']);
  assert.equal(sc.plant.name, 'UM-001-A_tp.jxl'); assert.deepEqual(sc.plant.box, [40, 20, 200, 100]);
  assert.equal(sc.segmented.name, 'UM-001-A_tl.jxl'); assert.equal(sc.segmented.lossless, true);
  assert.deepEqual(sizes, [[200, 100]]);               // the mask was asked for on the plant crop, not the whole scan
  for (const f of ['UM-001-A_ta.jpg', 'UM-001-A_tp.jpg', 'UM-001-A_tl.jpg']) assert.ok(fs.existsSync(path.join(home, 'previews', f)), f);
  const stat = (f, crop) => execFileSync('magick', [f, '-crop', crop, '+repage', '-depth', '16', '-format', '%w %h %#', 'info:']).toString();
  const decode = (name) => { const d = path.join(root, `${name}.dec.ppm`); execFileSync('djxl', [path.join(dir, name), d, '--quiet']); return d; };
  const orig = path.join(root, 'a.orig.ppm');
  // _tp = exactly the scanned pixels inside the plant box
  assert.equal(stat(decode('UM-001-A_tp.jxl'), '200x100+0+0'), stat(orig, '200x100+40+20'));
  // _tl = the plant crop; kept half = the scanned pixels exactly, the other half = 0, 0, 0
  const seg = decode('UM-001-A_tl.jxl');
  assert.equal(stat(seg, '100x100+0+0'), stat(orig, '100x100+40+20'));
  assert.equal(Number(execFileSync('magick', [seg, '-crop', '100x100+100+0', '+repage', '-format', '%[fx:maxima]', 'info:']).toString()), 0);
  assert.equal(execFileSync('magick', [seg, '-format', '%w %h', 'info:']).toString(), '200 100');
  const info = await leaves.sideInfo(root, 'UM', 'UM-001-A', 't');
  assert.ok(info.plant && info.previewPlant && info.segmented && info.previewSeg);
  assert.equal(info.name, 'UM-001-A_ta.jxl'); assert.deepEqual(info.plantSize, { w: 200, h: 100 });
  assert.deepEqual((await leaves.listLeaves(root, 'UM')).map((l) => l.id), ['UM-001-A']);

  fail = true;
  await job('b', { jxlLossy: true });                 // retake; the segmenter fails this time
  await waitFor(2);
  assert.equal(done[1].ok, true, done[1].error); assert.equal(done[1].note ?? null, null);
  for (const f of ['UM-001-A_ta-r1.jxl', 'UM-001-A_ta_lossy-r1.jxl', 'UM-001-A_tp-r1.jxl', 'UM-001-A_tl-r1.jxl', 'UM-001-A_t-r1.json', 'UM-001-A_ta-r1.jpg', 'UM-001-A_tp-r1.jpg', 'UM-001-A_tl-r1.jpg'])
    assert.ok(fs.existsSync(path.join(home, 'retakes', f)), f);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.jxl')).sort(), ['UM-001-A_ta_lossy.jxl', 'UM-001-A_tp_lossy.jxl']);   // no segmented file this time
  assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'UM-001-A_t.json'), 'utf8')).segmented.error, /boom/);
  assert.equal((await leaves.sideInfo(root, 'UM', 'UM-001-A', 't')).retakes, 1);
  assert.deepEqual(fs.readdirSync(staging), []);
  fs.rmSync(root, { recursive: true, force: true });
});

const { Detector, captureArea, letterbox, readNames } = require('../src/main/detect.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('auto area: letterbox, union of boxes over the threshold, padding, kept on the glass', () => {
  assert.deepEqual(letterbox(1275, 1755), { r: 640 / 1755, nw: 465, nh: 640, left: 87, top: 0 });
  const boxes = [
    { model: 'plant', label: 'Leaf_WHOLE', score: 0.9, x1: 1, y1: 2, x2: 3, y2: 4 },
    { model: 'archival', label: 'Ruler', score: 0.2, x1: 5, y1: 1, x2: 6, y2: 2 },
    { model: 'plant', label: 'Bud', score: 0.1, x1: 0, y1: 0, x2: 8.5, y2: 11.7 },         // below the threshold: ignored
    { model: 'archival', label: 'Envelope', score: 0.9, x1: 0, y1: 0, x2: 8.5, y2: 11.7 }, // class not in the union: ignored
  ];
  const a = captureArea(boxes, { threshold: 0.15, paddingCm: 2.54 });
  assert.deepEqual([a.x, a.y, a.w, a.h].map((v) => +v.toFixed(3)), [0, 0, 7, 5]);   // union 1..6 × 1..4, +1 in, clamped at 0
  assert.equal(a.used.length, 2);
  const edge = captureArea([{ model: 'archival', label: 'Label', score: 0.5, x1: 8, y1: 11, x2: 8.5, y2: 11.7 }], { threshold: 0.15, paddingCm: 2.54 });
  assert.deepEqual([edge.x + edge.w, edge.y + edge.h], [8.5, 11.7]);
  assert.equal(captureArea(boxes, { threshold: 0.95 }), null);
  // leaf padding: only the leaf box grows (1 in), before the union; the union padding comes on top
  const lp = captureArea(boxes, { threshold: 0.15, paddingCm: 0, leafPaddingCm: 2.54 });
  assert.deepEqual([lp.x, lp.y, lp.w, lp.h].map((v) => +v.toFixed(3)), [0, 1, 6, 4]);      // leaf 0..4 × 1..5, ruler 5..6 × 1..2
  const lp2 = captureArea(boxes, { threshold: 0.15, paddingCm: 2.54, leafPaddingCm: 2.54 });
  assert.deepEqual([lp2.x, lp2.y, lp2.w, lp2.h].map((v) => +v.toFixed(3)), [0, 0, 7, 6]);
  // class picker: a stored choice per model replaces that model's default; a model left out keeps it
  const { unionClasses } = require('../src/main/detect.js');
  assert.deepEqual(unionClasses(null), { plant: 'all', archival: ['Ruler', 'Barcode', 'Label'] });
  assert.deepEqual(unionClasses({ archival: [] }), { plant: 'all', archival: [] });
  // the clean QR tile goes 2 cm below the ruler, 1 cm from the image edge the ruler is on; nowhere if there is no room below it
  const { place, pick, findRuler, candidates } = require('../src/main/qr.js');
  // where to look for the QR code: sure Barcode boxes, weak ones on a Label, the Labels, other weak Barcodes
  const cb = (label, score, x1) => ({ label, score, x1, y1: 0, x2: x1 + 10, y2: 10 });
  assert.deepEqual(candidates([cb('Label', 0.7, 100), cb('Barcode', 0.04, 105), cb('Barcode', 0.03, 500), cb('Barcode', 0.6, 900), cb('Label', 0.1, 300), cb('Ruler', 0.9, 0), cb('Barcode', 0.07, 700)])
    .map((c) => `${c.label} ${c.score} ${c.margin}`), ['Barcode 0.6 0.6', 'Barcode 0.04 0.6', 'Label 0.7 0.15', 'Barcode 0.07 0.6']);
  assert.deepEqual(candidates([cb('Ruler', 0.9, 0)]), []);
  // the ruler: this side's prescan box (glass cm → scan px), else a confident box on the scan, else the top's mirrored, else a weak one
  const onScan = [{ label: 'Ruler', score: 0.2, x1: 1, y1: 2, x2: 3, y2: 4 }], areaIn = { full: false, x: 1, y: 0.5 };
  const fr = findRuler({ prescanRuler: { score: 0.9, cm: [5.08, 2.54, 7.62, 12.7] }, area: areaIn, boxes: onScan, dpi: 100, width: 1000, height: 1000 });
  assert.deepEqual([fr.x1, fr.y1, fr.x2, fr.y2, fr.from], [100, 50, 200, 450, 'prescan']);
  assert.equal(findRuler({ prescanRuler: { score: 0.9, mirrored: true, cm: [5.08, 2.54, 7.62, 12.7] }, area: areaIn, boxes: onScan, dpi: 100, width: 1000, height: 1000 }).from, 'top side prescan, mirrored');
  assert.equal(findRuler({ prescanRuler: { score: 0.9, mirrored: true, cm: [5.08, 2.54, 7.62, 12.7] }, area: areaIn, boxes: [{ ...onScan[0], score: 0.7 }], dpi: 100, width: 1000, height: 1000 }).from, 'scan');
  assert.equal(findRuler({ prescanRuler: null, area: areaIn, boxes: onScan, dpi: 100, width: 1000, height: 1000 }).from, 'scan (low score)');
  assert.equal(findRuler({ prescanRuler: null, area: areaIn, boxes: [], dpi: 100, width: 1000, height: 1000 }), null);
  assert.deepEqual(place({ ruler: { x1: 10, y1: 10, x2: 60, y2: 300 }, w: 200, h: 240, width: 2000, height: 2000, dpi: 254 }), { x: 100, y: 500 });
  assert.deepEqual(place({ ruler: { x1: 1800, y1: 10, x2: 1900, y2: 300 }, w: 200, h: 240, width: 2000, height: 2000, dpi: 254 }), { x: 1700, y: 500 });
  assert.deepEqual(place({ ruler: { x1: 10, y1: 10, x2: 60, y2: 1700 }, w: 200, h: 240, width: 2000, height: 2000, dpi: 254 }), { x: 100, y: 1760 });
  assert.equal(place({ ruler: { x1: 10, y1: 10, x2: 60, y2: 1900 }, w: 200, h: 240, width: 2000, height: 2000, dpi: 254 }), null);
  assert.equal(pick([{ label: 'Barcode', score: 0.2 }, { label: 'Barcode', score: 0.6 }, { label: 'Ruler', score: 0.9 }], 'Barcode', 0.15).score, 0.6);
  assert.equal(pick([{ label: 'Barcode', score: 0.1 }], 'Barcode', 0.15), null);
  const only = [{ model: 'archival', label: 'Colorcard', score: 0.9, x1: 1, y1: 1, x2: 2, y2: 2 }];
  assert.equal(captureArea(only, {}), null);
  assert.ok(captureArea(only, { classes: unionClasses({ archival: ['Colorcard'] }) }));
  if (fs.existsSync(path.join(ROOT, 'src/models/plant_detector/metadata.yaml'))) {       // models are fetched on first run (npm run models:fetch)
    assert.equal(readNames(path.join(ROOT, 'src/models/plant_detector/metadata.yaml'))[0], 'Leaf_WHOLE');
    assert.equal(readNames(path.join(ROOT, 'src/models/archival_detector/metadata.yaml'))[0], 'Ruler');
  }
});

const SAMPLE = path.join(ROOT, 'probe/out/t03_fullbed_150dpi.tiff');
const detector = new Detector({ ovdetect: path.join(ROOT, 'probe/ovdetect'), modelsDir: path.join(ROOT, 'src/models') });
test('detector: both OpenVINO models run on a 150 dpi prescan', { skip: !(detector.ready && hasMagick && fs.existsSync(SAMPLE)) && 'needs probe/ovdetect (npm run ov:build) and a sample prescan' }, async () => {
  const r = await detector.detect({ image: SAMPLE, width: 1275, height: 1755, dpi: 150, workDir: tmp() });
  assert.ok(r.boxes.some((b) => b.model === 'plant') && r.boxes.some((b) => b.model === 'archival'));
  for (const b of r.boxes) assert.ok(b.x1 >= 0 && b.y1 >= 0 && b.x2 <= 8.5 + 1e-9 && b.y2 <= 11.7 + 1e-9 && b.x2 > b.x1 && b.y2 > b.y1);
  const label = r.boxes.filter((b) => b.label === 'Label').sort((a, b) => b.score - a.score)[0];
  assert.ok(label && label.score > 0.5, 'the address window is found as a Label');
});

const { bandShifts, judge } = require('../src/main/fringe.js');
test('fringe check: clean stripes pass, blue shifted by 3 rows in a stretch fails', () => {
  const w = 64, h = 1200;
  const make = (shiftAt) => {
    const buf = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = (yy) => (Math.floor(yy / 5) % 2 ? 220 : 40) + ((x * 7 + yy * 3) % 5);   // horizontal stripes
      const i = (y * w + x) * 3;
      buf[i] = v(y); buf[i + 1] = v(y);
      buf[i + 2] = v(shiftAt(y) ? y + 3 : y);
    }
    return buf;
  };
  const ok = judge(bandShifts(make(() => false), w, h), { dpi: 1200, height: h });
  assert.equal(ok.verdict, 'ok');
  const bad = judge(bandShifts(make((y) => y > 400 && y < 700), w, h), { dpi: 1200, height: h });
  assert.equal(bad.verdict, 'bad');
  assert.ok(bad.ranges.some((r) => r.from < 0.45 && r.to > 0.4), JSON.stringify(bad.ranges));
});

test('measure: one <ID>.json per specimen with CF, image metadata, scan options, notes, and lengths from the points', { skip: !hasMagick && 'needs ImageMagick' }, async () => {
  const measure = require('../src/main/measure.js');
  const root = tmp(), dir = path.join(root, 'UM'); fs.mkdirSync(dir);
  execFileSync('magick', ['-size', '600x300', 'gradient:', '-depth', '8', path.join(dir, 'UM-001-A_ta.tif')]);
  fs.writeFileSync(path.join(dir, 'UM-001-A_t.json'), JSON.stringify({ scannedAt: '2026-11-13T00:00:00.000Z', profile: { dpi: 600, bits: 16, area: { full: false, w: 1, h: 0.5 } }, accepted: { dpi: 600 },
    outputs: [{ name: 'UM-001-A_ta.tif', sha256: 'abc', lossless: true }] }));
  const img = await measure.measureImage(root, { folder: 'UM', id: 'UM-001-A', side: 't', product: 'a' });
  assert.equal(img.width, 600); assert.equal(img.height, 300); assert.equal(img.dpi, 600);
  assert.ok(Math.abs(img.pxPerCm - 600 / 2.54) < 1e-9); assert.ok(fs.existsSync(img.proxy));
  assert.equal(await measure.measureImage(root, { folder: 'UM', id: 'UM-001-A', side: 't', product: 'p' }), null);   // no plant crop saved
  assert.equal(measure.load(root, { folder: 'UM', id: 'UM-001-A' }), null);
  const saved = await measure.save(root, { folder: 'UM', id: 'UM-001-A', notes: 'midrib bent', measurements: [
    { id: 'm1', label: 'width', side: 't', view: 'a', points: [[100, 50], [336.22, 50]] },                           // 236.22 px = 1 cm at 600 dpi
    { id: 'm2', label: '', side: 't', view: 'a', points: [[0, 0], [300, 0], [300, 400]] },                           // a path: 700 px
  ] }, 't');
  assert.equal(path.basename(saved.file), 'UM-001-A.json');
  assert.deepEqual(fs.readdirSync(dir), ['scans']);                    // the loose files of the older layout were moved into scans/
  assert.ok(fs.existsSync(path.join(dir, 'scans', 'UM-001-A_ta.tif')));
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'scans', 'UM-001-A.json'), 'utf8'));
  assert.equal(doc.format, 'scandeck-measurements'); assert.equal(doc.id, 'UM-001-A'); assert.equal(doc.notes, 'midrib bent');
  const im = doc.images['UM-001-A_ta.tif'];
  assert.equal(im.CF, 236.2205); assert.equal(im.dpi, 600); assert.equal(im.widthPx, 600); assert.equal(im.product, 'archival'); assert.equal(im.suffix, '_ta');
  assert.equal(im.sha256, 'abc'); assert.deepEqual(im.scanOptions, { dpi: 600, bits: 16, area: { full: false, w: 1, h: 0.5 } });
  const [m1, m2] = doc.measurements;
  assert.equal(m1.type, 'line'); assert.equal(m1.image, 'UM-001-A_ta.tif'); assert.equal(m1.lengthPx, 236.2); assert.equal(m1.lengthCm, 0.9999); assert.equal(m1.lengthMm, 9.999);
  assert.equal(m2.type, 'path'); assert.equal(m2.lengthPx, 700); assert.equal(m2.lengthMm, +(700 / (600 / 2.54) * 10).toFixed(3));
  assert.equal(saved.measurements[0].view, 'a');
  // recording again keeps createdAt and each measurement's first recordedAt
  const again = await measure.save(root, { folder: 'UM', id: 'UM-001-A', notes: '', measurements: [{ ...saved.measurements[0], points: m1.points }] }, 't');
  const doc2 = JSON.parse(fs.readFileSync(path.join(dir, 'scans', 'UM-001-A.json'), 'utf8'));
  assert.equal(doc2.createdAt, doc.createdAt); assert.equal(doc2.measurements.length, 1); assert.equal(doc2.measurements[0].recordedAt, m1.recordedAt); assert.equal(again.notes, '');
  assert.deepEqual((await leaves.listLeaves(root, 'UM')).map((l) => l.id), ['UM-001-A']);     // the measurements file is not mistaken for a scan
  fs.rmSync(root, { recursive: true, force: true });
});

test('models: missing files are listed from models.json, fetched, checked by size and sha256, and put in place', async () => {
  const models = require('../src/main/models.js');
  const http = require('node:http');
  const crypto = require('node:crypto');
  const blob = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251));
  const files = { 'openvino/m/metadata.yaml': blob(300, 1), 'openvino/m/best.bin': blob(200000, 2), 'openvino/m/best.xml': blob(5000, 3) };
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  let served = 0, tamper = false;
  const server = http.createServer((req, res) => {
    const m = /^\/org\/repo\/resolve\/abc123\/(.+)$/.exec(req.url);
    const body = m && files[m[1]];
    if (!body) { res.writeHead(404); res.end(); return; }
    served++;
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(tamper && m[1].endsWith('best.bin') ? Buffer.concat([body.subarray(0, -1), Buffer.from([0])]) : body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = [{ dir: 'plant_detector', repo: 'org/repo', revision: 'abc123',
    files: ['metadata.yaml', 'best.bin', 'best.xml'].map((name) => ({ name, src: `openvino/m/${name}`, bytes: files[`openvino/m/${name}`].length, sha256: sha(files[`openvino/m/${name}`]) })) }];
  const modelsDir = tmp();
  try {
    const todo = models.missing({ modelsDir, list, base });
    assert.deepEqual(todo.map((x) => x.file), ['metadata.yaml', 'best.bin', 'best.xml']);       // best.xml last: a model counts once it is there
    let last = null;
    const r = await models.ensure({ modelsDir, list, base, onProgress: (p) => { last = p; } });
    assert.equal(r.bytes, 205300);
    assert.deepEqual(last && [last.done, last.total], [205300, 205300]);
    for (const [k, b] of Object.entries(files)) assert.ok(fs.readFileSync(path.join(modelsDir, 'plant_detector', k.split('/').pop())).equals(b), k);
    assert.deepEqual(models.missing({ modelsDir, list, base }), []);
    // a second run fetches nothing; a corrupted download is refused and leaves nothing behind
    served = 0; await models.ensure({ modelsDir, list, base }); assert.equal(served, 0);
    fs.rmSync(path.join(modelsDir, 'plant_detector', 'best.bin'));
    tamper = true;
    await assert.rejects(models.ensure({ modelsDir, list, base }), /sha256/);
    assert.deepEqual(fs.readdirSync(path.join(modelsDir, 'plant_detector')).sort(), ['best.xml', 'metadata.yaml']);
    // the real manifest names three models, each with its three files
    assert.deepEqual(models.manifest().models.map((m) => [m.dir, m.files.length]), [['plant_detector', 3], ['archival_detector', 3], ['leaf_segmenter', 3]]);
  } finally { server.close(); fs.rmSync(modelsDir, { recursive: true, force: true }); }
});
