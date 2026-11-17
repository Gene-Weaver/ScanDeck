#!/usr/bin/env node
// ScanDeck validation scans for the Epson V370, run through probe/icprobe and the Epson ICA driver.
//
// It makes one scan per (dpi × bit depth) over the same area, then a summary and a contact sheet
// so the scans can be judged side by side.
// Defaults:
//   - 150, 300, 600, 1200 and 2400 dpi
//   - each at 8 bits/channel RGB (24-bit color) and 16 bits/channel RGB (48-bit color)
//   - Epson's automatic corrections pinned off (icprobe does this)
//   - the first 10 × 10 cm of the glass: the corner that ends up at the top left of the image
//   - plus a corrections set at 1200 dpi / 16-bit, compared against the plain 1200 dpi scan:
//     a repeat with no corrections (scan-to-scan noise floor), each Epson correction on its own
//     (unsharp mask, descreening, backlight correction, dust removal, color restoration), then all of them
//
// Usage:
//   node validation/run_validation_tests.mjs                  # 10 scans, 10 × 10 cm
//   node validation/run_validation_tests.mjs --area full      # whole glass, 8.5 × 11.7 in (2400 dpi: GBs, minutes per scan)
//   node validation/run_validation_tests.mjs --area 15x20cm   # W × H in cm from the corner
//   node validation/run_validation_tests.mjs --dpi 300,600 --bits 16
//   node validation/run_validation_tests.mjs --no-corrections # skip the corrections set
//   node validation/run_validation_tests.mjs --no-compression # skip the compression test (compression_test.mjs) on the 1200 dpi 16-bit scan
//   node validation/run_validation_tests.mjs --corrections-dpi 600 --corrections-bits 8 --correction-level high
//   node validation/run_validation_tests.mjs --dry-run        # print the plan and sizes, scan nothing
//
// Output goes to validation_tests_out/<yyyy-mm-dd_HHMMSS>_<area>/:
//   scan_0150dpi_08bit.tiff …   masters straight from the driver
//   scan_….json, scan_….log     icprobe report (requested vs. accepted settings, timing) and its log
//   previews/                   JPEG overview, 1 cm center crop at native pixels, tone-stretched crop,
//                               and for corrections a ×8 difference image against the plain scan
//   summary.csv, summary.json, index.html   (open index.html to compare)
//   compression/, compression.json, compression.html   lossless formats for the 1200 dpi 16-bit scan
//
// Ctrl-C once stops after the scan in progress. Ctrl-C twice quits right away. Avoid that:
// an Epson ICA session interrupted mid-scan can stay busy until the scanner is power-cycled.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_SRC = path.join(ROOT, 'probe', 'icprobe.swift');
const PROBE = path.join(ROOT, 'probe', 'icprobe');
const DRIVER_PLIST = '/Library/Image Capture/Devices/EPSON Scanner.app/Contents/Info';
const BED_CM = { w: 8.5 * 2.54, h: 11.7 * 2.54 };   // flatbed physicalSize reported by the driver
const CROP_CM = 1;                                   // edge of the detail crop
const STRETCH = 0.03;                                // ± window around the crop mean for the stretched view (~16× contrast)
const MAGICK_LIMITS = ['-limit', 'memory', '2GiB', '-limit', 'map', '8GiB'];

const USAGE = `usage: node validation/run_validation_tests.mjs [--area 10cm|full|<W>x<H>cm] [--dpi 150,300,600,1200,2400]
                                             [--bits 8,16] [--out DIR] [--dry-run]
                                             [--no-corrections] [--corrections-dpi 1200] [--corrections-bits 16]
                                             [--correction-level low|medium|high] [--no-compression]`;
const LEVELS = ['low', 'medium', 'high'];

/** Epson's corrections as the ICA driver names them (icprobe --set NAME=VALUE turns one on). */
function correctionSets(level) {
  const L = level[0].toUpperCase() + level.slice(1);
  const singles = [
    { key: 'unsharp', label: `Unsharp mask (${L})`, set: { VF_UNSHARPMASK: L } },
    { key: 'descreen', label: 'Descreening (General)', set: { VF_DESCREEN: 'General' } },
    { key: 'backlight', label: `Backlight correction (${L})`, set: { VF_BACKLIGHTCORRECTION: L } },
    { key: 'dust', label: `Dust removal (${L})`, set: { VF_DUSTREMOVAL: L } },
    { key: 'colorrestore', label: 'Color restoration', set: { VF_COLORRESTORATION: 'on' } },
  ];
  return [
    { key: 'repeat', label: 'Repeat, no corrections (scan-to-scan noise)', set: {} },
    ...singles,
    { key: 'all', label: `All corrections (${L})`, set: Object.assign({}, ...singles.map((c) => c.set)) },
  ];
}

// ---- options ---------------------------------------------------------------------------------

const { values: opt } = parseArgs({ options: {
  area: { type: 'string', default: '10cm' },
  dpi: { type: 'string', default: '150,300,600,1200,2400' },
  bits: { type: 'string', default: '8,16' },
  out: { type: 'string', default: path.join(ROOT, 'validation_tests_out') },
  'dry-run': { type: 'boolean', default: false },
  corrections: { type: 'boolean', default: true },
  compression: { type: 'boolean', default: true },
  'corrections-dpi': { type: 'string', default: '1200' },
  'corrections-bits': { type: 'string', default: '16' },
  'correction-level': { type: 'string', default: 'medium' },
  help: { type: 'boolean', short: 'h', default: false },
}, allowNegative: true });
if (opt.help) { console.log(USAGE); process.exit(0); }

function parseArea(s) {
  if (s === 'full') return { label: 'fullbed', full: true, wCm: BED_CM.w, hCm: BED_CM.h };
  const m = /^(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?cm$/i.exec(s);
  if (!m) fail(`--area must be "full", "<N>cm" or "<W>x<H>cm", got "${s}"`);
  const wCm = Number(m[1]), hCm = Number(m[2] ?? m[1]);
  if (!(wCm > 0 && hCm > 0) || wCm > BED_CM.w + 1e-6 || hCm > BED_CM.h + 1e-6) {
    fail(`area ${wCm} × ${hCm} cm doesn't fit the ${BED_CM.w.toFixed(1)} × ${BED_CM.h.toFixed(1)} cm glass`);
  }
  return { label: m[2] ? `${m[1]}x${m[2]}cm` : `${m[1]}cm`, full: false, wCm, hCm };
}

function parseList(s, name, ok) {
  const list = s.split(',').map((v) => Number(v.trim()));
  for (const v of list) if (!ok(v)) fail(`bad ${name} value in "${s}"`);
  return list;
}

function fail(msg) { console.error(`error: ${msg}\n${USAGE}`); process.exit(2); }

const area = parseArea(opt.area);
const dpis = parseList(opt.dpi, '--dpi', (v) => Number.isInteger(v) && v >= 50 && v <= 12800);
const bitsList = parseList(opt.bits, '--bits', (v) => v === 8 || v === 16);
const outRoot = path.resolve(opt.out);
const corr = opt.corrections ? {
  dpi: parseList(opt['corrections-dpi'], '--corrections-dpi', (v) => Number.isInteger(v) && v >= 50 && v <= 12800)[0],
  bits: parseList(opt['corrections-bits'], '--corrections-bits', (v) => v === 8 || v === 16)[0],
  level: LEVELS.includes(opt['correction-level']) ? opt['correction-level'] : fail(`--correction-level must be ${LEVELS.join(', ')}`),
} : null;

// ---- plan ------------------------------------------------------------------------------------

const px = (cm, dpi) => Math.round((cm / 2.54) * dpi);
const pad = (n, w) => String(n).padStart(w, '0');
const mb = (bytes) => (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0);

const item = (dpi, bits, correction = null) => {
  const w = px(area.wCm, dpi), h = px(area.hCm, dpi);
  const base = `scan_${pad(dpi, 4)}dpi_${pad(bits, 2)}bit`;
  return {
    dpi, bits, w, h, rawBytes: w * h * 3 * (bits / 8),
    name: correction ? `${base}_c-${correction.key}` : base,
    correction, baseline: correction ? base : null,
  };
};
const plan = dpis.flatMap((dpi) => bitsList.map((bits) => item(dpi, bits)));
if (corr) {
  // The corrections are judged against the plain scan at the same dpi and depth, so make sure it is
  // in the plan, and scan them right after it (same warm-up, items still on the glass).
  let at = plan.findIndex((p) => p.dpi === corr.dpi && p.bits === corr.bits);
  if (at < 0) { plan.push(item(corr.dpi, corr.bits)); plan.sort((a, b) => a.dpi - b.dpi || a.bits - b.bits); at = plan.findIndex((p) => p.dpi === corr.dpi && p.bits === corr.bits); }
  const last = plan.reduce((k, p, i) => (p.dpi === corr.dpi ? i : k), at);
  plan.splice(last + 1, 0, ...correctionSets(corr.level).map((c) => item(corr.dpi, corr.bits, c)));
}
const totalRaw = plan.reduce((s, p) => s + p.rawBytes, 0);

console.log(`ScanDeck validation: ${plan.length} scans, area ${area.wCm.toFixed(2)} × ${area.hCm.toFixed(2)} cm (${area.label})`);
for (const p of plan) {
  console.log(`  ${p.name.padEnd(32)} ${String(p.w).padStart(5)} × ${String(p.h).padStart(5)} px  ≈ ${mb(p.rawBytes).padStart(5)} MB uncompressed${p.correction ? `  ${p.correction.label}` : ''}`);
}
console.log(`  total ≈ ${mb(totalRaw)} MB uncompressed (the driver writes LZW, usually smaller)`);
if (totalRaw > 4e9) console.warn('  warning: very large run; each 2400 dpi full-bed scan takes several minutes');
for (const p of plan) if (p.rawBytes > 4e9) console.warn(`  warning: ${p.name} exceeds the 4 GB classic-TIFF limit and will probably fail`);
if (opt['dry-run']) process.exit(0);

// ---- prerequisites ---------------------------------------------------------------------------

const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const haveTiffinfo = has('tiffinfo'), haveMagick = has('magick');
if (!haveTiffinfo) console.warn('tiffinfo not found (brew install libtiff): TIFF tag checks skipped');
if (!haveMagick) console.warn('magick not found (brew install imagemagick): previews and tone checks skipped');

if (!fs.existsSync(PROBE) || fs.statSync(PROBE_SRC).mtimeMs > fs.statSync(PROBE).mtimeMs) {
  console.log('building icprobe…');
  execFileSync('swiftc', ['-swift-version', '5', '-O', '-o', PROBE, PROBE_SRC], { stdio: 'inherit' });
}

const freshRoot = !fs.existsSync(outRoot);
fs.mkdirSync(outRoot, { recursive: true });
// Scan output stays local (decided 2026-11-12), so keep test scans out of Dropbox sync.
// Only done when the folder is first created, so removing the attribute by hand sticks.
if (freshRoot && outRoot.startsWith(path.join(os.homedir(), 'Dropbox') + path.sep)) {
  try {
    execFileSync('xattr', ['-w', 'com.dropbox.ignored', '1', outRoot]);
    console.log(`${path.relative(ROOT, outRoot)}/ is marked Dropbox-ignored: it stays on this Mac only`);
  } catch (e) { console.warn(`could not mark ${outRoot} Dropbox-ignored: ${e.message}`); }
}

const { bavail, bsize } = fs.statfsSync(outRoot);
if (bavail * bsize < totalRaw * 1.2) fail(`not enough free disk: need ≈ ${mb(totalRaw * 1.2)} MB, have ${mb(bavail * bsize)} MB`);

const now = new Date();
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}_${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
const runDir = path.join(outRoot, `${stamp}_${area.label}`);
const previewDir = path.join(runDir, 'previews');
fs.mkdirSync(previewDir, { recursive: true });

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const meta = {
  started: now.toISOString(),
  area: { label: area.label, full: area.full, wCm: area.wCm, hCm: area.hCm, origin: 'top-left corner of the image' },
  dpis, bits: bitsList, corrections: corr,
  macOS: sh('sw_vers', ['-productVersion']),
  driverVersion: sh('defaults', ['read', DRIVER_PLIST, 'CFBundleShortVersionString']),
  device: null,
};

// ---- Ctrl-C ----------------------------------------------------------------------------------

let current = null, stopRequested = false;
process.on('SIGINT', () => {
  if (!stopRequested) {
    stopRequested = true;
    console.log('\nCtrl-C: stopping after the current scan (press Ctrl-C again to quit now).');
    return;
  }
  console.log('\nQuitting now. If the scanner stays busy, power-cycle it.');
  if (current) current.kill('SIGTERM');
  process.exit(130);
});

// ---- scanning --------------------------------------------------------------------------------

function runProbe(args, logFile) {
  return new Promise((resolve) => {
    // detached: the terminal's Ctrl-C reaches only this script, never the scan in progress
    const child = spawn(PROBE, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    const log = fs.createWriteStream(logFile);
    let out = '', pending = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => {
      log.write(b);
      pending += b;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i); pending = pending.slice(i + 1);
        if (/progress|error|fail|timed out|busy|removed/i.test(line)) console.log(`    ${line}`);
      }
    });
    child.on('close', (code) => {
      current = null;
      log.end();
      let report = null;
      try { report = JSON.parse(out); } catch { /* reported as a failure below */ }
      resolve({ code, report });
    });
  });
}

function findTiff(name) {
  const f = fs.readdirSync(runDir).find((n) => n.startsWith(name) && /\.tiff?$/i.test(n));
  return f ? path.join(runDir, f) : null;
}

function tiffInfo(file) {
  const t = sh('tiffinfo', [file]) ?? '';
  const g = (re) => (re.exec(t) || [])[1];
  return {
    width: Number(g(/Image Width:\s*(\d+)/)), height: Number(g(/Image Length:\s*(\d+)/)),
    bitsPerSample: Number(g(/Bits\/Sample:\s*(\d+)/)), samplesPerPixel: Number(g(/Samples\/Pixel:\s*(\d+)/)),
    resolution: Number(g(/Resolution:\s*([\d.]+)/)) || null,
    compression: g(/Compression Scheme:\s*(.+)/)?.trim() ?? null,
    icc: /ICC Profile: <present>/.test(t),
  };
}

const magick = (args) => execFileSync('magick', [...MAGICK_LIMITS, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });

// Tone levels actually present in the crop. 8-bit data shows ≤ 256 levels per channel set, all
// multiples of 257 once widened to 16 bits. Genuine 16-bit data has thousands of levels.
function toneStats(file) {
  const raw = magick([file, '-depth', '16', '-endian', 'MSB', 'rgb:-']);
  const seen = new Uint8Array(65536);
  let distinct = 0, mult257 = 0, clipped = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const v = raw.readUInt16BE(i);
    if (!seen[v]) { seen[v] = 1; distinct++; }
    if (v % 257 === 0) mult257++;
    if (v === 0 || v === 65535) clipped++;
  }
  const n = raw.length >> 1;
  return { samples: n, distinctLevels: distinct, frac257: mult257 / n, clippedFrac: clipped / n };
}

function makePreviews(tiff, r) {
  const base = path.join(previewDir, r.name);
  const c = Math.max(8, px(CROP_CM, r.dpi));
  const x = Math.max(0, Math.round(r.info.width / 2 - c / 2)), y = Math.max(0, Math.round(r.info.height / 2 - c / 2));
  const files = {
    overview: `${base}_overview.jpg`, crop16: `${base}_crop1cm.tif`,
    crop: `${base}_crop1cm.png`, stretch: `${base}_crop1cm_stretch.png`,
  };
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '1400', tiff, '--out', files.overview], { stdio: 'ignore' });
  magick([tiff, '-crop', `${c}x${c}+${x}+${y}`, '+repage', files.crop16]);
  magick([files.crop16, '-depth', '8', files.crop]);
  const mean = Number(execFileSync('magick', [files.crop16, '-format', '%[fx:mean]', 'info:'], { encoding: 'utf8' }));
  const lo = Math.max(0, mean - STRETCH), hi = Math.min(1, mean + STRETCH);
  magick([files.crop16, '-level', `${(lo * 100).toFixed(3)}%,${(hi * 100).toFixed(3)}%`, '-depth', '8', files.stretch]);
  const rel = (f) => path.relative(runDir, f);
  return {
    overview: rel(files.overview), crop16: rel(files.crop16), crop: rel(files.crop), stretch: rel(files.stretch),
    cropPx: { x, y, size: c }, stretchWindow: [lo, hi], tones: toneStats(files.crop16),
  };
}

// How far a correction moved the pixels of the 1 cm crop compared with the plain scan: mean absolute
// difference (% of full scale), the mean shift per channel (% points, + = brighter) and a ×8 difference
// image. Read it against the "repeat" scan (no corrections): that is scan-to-scan noise plus sub-pixel
// misregistration, the floor below which a correction did nothing visible.
function diffAgainst(base, r) {
  const a = path.join(runDir, base.previews.crop16), b = path.join(runDir, r.previews.crop16);
  const cmp = spawnSync('magick', ['compare', '-metric', 'MAE', a, b, 'null:'], { encoding: 'utf8' });   // exits 1 when images differ
  const m = /\(([\d.eE+-]+)\)/.exec(cmp.stderr || '');
  if (!m) throw new Error(`compare failed: ${(cmp.stderr || '').trim().split('\n')[0]}`);
  const means = (f) => execFileSync('magick', [f, '-format', '%[fx:mean.r] %[fx:mean.g] %[fx:mean.b]', 'info:'], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  const [ma, mb2] = [means(a), means(b)];
  const diffPng = path.join(previewDir, `${r.name}_diff8x.png`);
  magick([a, b, '-compose', 'difference', '-composite', '-evaluate', 'multiply', '8', '-depth', '8', diffPng]);
  return { vs: base.name, maePct: Number(m[1]) * 100, meanShiftPct: mb2.map((v, i) => (v - ma[i]) * 100), image: path.relative(runDir, diffPng) };
}

const isOff = (f) => (f.kind === 'boolean' ? !f.value : String(f.current) === '0');

function checks(r, report) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });
  const a = r.accepted;
  if (a) {
    add('dpi accepted', a.dpi === r.dpi, `${a.dpi}`);
    add('bit depth accepted', a.bitDepth === r.bits, `${a.bitDepth}`);
    const vf = a.vendorFeatures || [];
    const want = r.correction?.set || {};
    for (const name of Object.keys(want)) {
      const f = vf.find((x) => x.internalName === name);
      add(`${name} on`, !!f && !isOff(f), f ? String(f.current ?? f.value) : 'not offered by the driver');
    }
    const strays = vf.filter((f) => !(f.internalName in want) && !isOff(f));
    add(Object.keys(want).length ? 'other corrections off' : 'corrections off', !strays.length, strays.map((f) => f.internalName).join(', ') || 'yes');
  }
  if (report?.vendorErrors?.length) add('corrections understood', false, report.vendorErrors.join(', '));
  if (r.info) {
    add('pixel size', Math.abs(r.info.width - r.w) <= 2 && Math.abs(r.info.height - r.h) <= 2,
      `${r.info.width} × ${r.info.height} (expected ${r.w} × ${r.h})`);
    add('bits/sample', r.info.bitsPerSample === r.bits, `${r.info.bitsPerSample}`);
    add('RGB', r.info.samplesPerPixel === 3, `${r.info.samplesPerPixel} samples/pixel`);
    add('resolution tag', Math.round(r.info.resolution ?? 0) === r.dpi, `${r.info.resolution}`);
  }
  if (r.bits === 16 && r.previews?.tones) {
    add('genuine 16-bit', r.previews.tones.frac257 < 0.5, `${r.previews.tones.distinctLevels} levels, ${(r.previews.tones.frac257 * 100).toFixed(1)}% multiples of 257`);
  }
  return out;
}

const results = [];
for (const [k, item] of plan.entries()) {
  if (stopRequested) { console.log(`stopped before ${item.name}`); break; }
  console.log(`\n[${k + 1}/${plan.length}] ${item.dpi} dpi · ${item.bits}-bit RGB · ${item.w} × ${item.h} px${item.correction ? ` · ${item.correction.label}` : ''}`);
  const areaArg = area.full ? 'full' : `0,0,${(area.wCm / 2.54).toFixed(5)},${(area.hCm / 2.54).toFixed(5)}`;
  const t0 = Date.now();
  const { code, report } = await runProbe(
    ['scan', '--dpi', String(item.dpi), '--bits', String(item.bits), '--area', areaArg, '--out', runDir, '--name', item.name,
      ...Object.entries(item.correction?.set || {}).flatMap(([name, value]) => ['--set', `${name}=${value}`])],
    path.join(runDir, `${item.name}.log`));
  if (report) fs.writeFileSync(path.join(runDir, `${item.name}.json`), JSON.stringify(report, null, 2));
  meta.device ??= report?.device ?? null;

  const r = {
    ...item, exit: code, wallSeconds: (Date.now() - t0) / 1000, scanSeconds: report?.scanSeconds ?? null,
    accepted: report?.accepted ?? null, error: report?.scanError ?? report?.error ?? (code ? `icprobe exit ${code}` : null),
  };
  const tiff = report?.files?.[0] && fs.existsSync(report.files[0]) ? report.files[0] : findTiff(item.name);
  if (tiff) {
    r.tiff = path.relative(runDir, tiff);
    r.fileBytes = fs.statSync(tiff).size;
    if (haveTiffinfo) r.info = tiffInfo(tiff);
    if (haveMagick && r.info) {
      try { r.previews = makePreviews(tiff, r); } catch (e) { r.previewError = String(e.message).split('\n')[0]; }
    }
    const base = r.baseline && results.find((x) => x.name === r.baseline);
    if (base?.previews && r.previews) {
      try { r.diff = diffAgainst(base, r); } catch (e) { r.diffError = String(e.message).split('\n')[0]; }
    }
  }
  r.checks = checks(r, report);
  const failed = r.checks.filter((c) => !c.ok);
  r.status = !tiff ? 'FAILED' : failed.length ? `CHECK: ${failed.map((c) => c.name).join(', ')}` : 'OK';
  results.push(r);
  writeSummary();

  const levels = r.diff ? ` · differs from plain by ${r.diff.maePct.toFixed(2)}% (mean shift R/G/B ${r.diff.meanShiftPct.map((v) => v.toFixed(2)).join('/')})`
    : r.previews?.tones ? ` · ${r.previews.tones.distinctLevels} tone levels in 1 cm crop` : '';
  console.log(`    ${r.status} · ${r.scanSeconds?.toFixed(1) ?? '?'} s · ${r.fileBytes ? mb(r.fileBytes) + ' MB' : 'no file'}${levels}${r.error ? ` · ${r.error}` : ''}`);
}

// Compression test on the 1200 dpi 16-bit scan (no scanning; re-encodes the file in other formats).
const compressionSource = results.find((r) => r.dpi === 1200 && r.bits === 16 && !r.correction && r.tiff);
if (opt.compression && compressionSource && !stopRequested) {
  console.log('\nCompression test on the 1200 dpi 16-bit scan…');
  const c = spawnSync(process.execPath, [path.join(ROOT, 'validation', 'compression_test.mjs'), '--tiff', path.join(runDir, compressionSource.tiff), '--out', runDir], { stdio: 'inherit' });
  meta.compression = c.status === 0 ? 'compression.json' : null;
}

writeSummary(true);
console.log(`\nDone: ${results.filter((r) => r.status === 'OK').length}/${results.length} OK`);
console.log(`Open ${path.join(runDir, 'index.html')}`);

// ---- summary ---------------------------------------------------------------------------------

function writeSummary(final = false) {
  meta.finished = final ? new Date().toISOString() : null;
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ meta, results }, null, 2));

  const cols = ['dpi', 'bits', 'correction', 'width_px', 'height_px', 'file_mb', 'scan_seconds', 'bits_per_sample', 'compression', 'icc', 'tone_levels_1cm', 'diff_vs_plain_pct', 'status', 'tiff'];
  const rows = results.map((r) => [r.dpi, r.bits, r.correction?.label ?? 'none', r.info?.width ?? '', r.info?.height ?? '', r.fileBytes ? (r.fileBytes / 1e6).toFixed(2) : '',
    r.scanSeconds?.toFixed(1) ?? '', r.info?.bitsPerSample ?? '', r.info?.compression ?? '', r.info?.icc ?? '',
    r.previews?.tones.distinctLevels ?? '', r.diff ? r.diff.maePct.toFixed(3) : '', r.status, r.tiff ?? '']);
  const csv = [cols, ...rows].map((row) => row.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
  fs.writeFileSync(path.join(runDir, 'summary.csv'), csv + '\n');
  fs.writeFileSync(path.join(runDir, 'index.html'), html());
}

function html() {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const statusClass = (s) => (s === 'OK' ? 'ok' : s === 'FAILED' ? 'bad' : 'warn');
  const plain = results.filter((r) => !r.correction);
  const byDpi = [...new Set(plain.map((r) => r.dpi))].sort((a, b) => a - b).map((dpi) => ({ dpi, cells: bitsList.map((bits) => plain.find((r) => r.dpi === dpi && r.bits === bits)) }));
  const corrRows = results.filter((r) => r.correction);
  const corrBase = corr && plain.find((r) => r.dpi === corr.dpi && r.bits === corr.bits);

  const summaryRows = results.map((r) => `<tr>
      <td>${r.dpi}</td><td>${r.bits}-bit</td><td>${esc(r.correction?.label ?? '')}</td><td>${r.info ? `${r.info.width} × ${r.info.height}` : '—'}</td>
      <td class="num">${r.fileBytes ? mb(r.fileBytes) : '—'}</td><td class="num">${r.scanSeconds?.toFixed(1) ?? '—'}</td>
      <td class="num">${r.previews?.tones.distinctLevels ?? '—'}</td>
      <td><span class="pill ${statusClass(r.status)}">${esc(r.status)}</span></td></tr>`).join('');

  const card = (r, bits) => {
    if (!r) return `<div class="card empty">${bits}-bit: not scanned</div>`;
    const p = r.previews;
    const facts = [
      r.info ? `${r.info.width} × ${r.info.height} px` : null,
      r.fileBytes ? `${mb(r.fileBytes)} MB` : null,
      r.scanSeconds != null ? `${r.scanSeconds.toFixed(1)} s` : null,
      p?.tones ? `${p.tones.distinctLevels} tone levels` : null,
      r.info?.compression, r.info?.icc ? 'ICC profile' : null,
    ].filter(Boolean).map(esc).join(' · ');
    const bad = r.checks.filter((c) => !c.ok).map((c) => `<li>${esc(c.name)}: ${esc(c.detail)}</li>`).join('');
    return `<div class="card">
      <div class="cardhead"><strong>${r.bits}-bit RGB</strong> <span class="pill ${statusClass(r.status)}">${esc(r.status)}</span></div>
      <div class="facts">${facts}</div>
      ${p ? `<div class="imgs">
        <figure><a href="${esc(r.tiff)}"><img class="ov" src="${esc(p.overview)}" alt="overview"></a><figcaption>whole area (click: TIFF)</figcaption></figure>
        <figure><a href="${esc(p.crop)}"><img class="crop" src="${esc(p.crop)}" alt="1 cm crop"></a><figcaption>1 × 1 cm, ${p.cropPx.size} px</figcaption></figure>
        <figure><a href="${esc(p.stretch)}"><img class="crop" src="${esc(p.stretch)}" alt="tone-stretched crop"></a><figcaption>same, contrast ×16</figcaption></figure>
      </div>` : `<p class="muted">${esc(r.previewError ?? r.error ?? 'no preview')}</p>`}
      ${bad ? `<ul class="bad">${bad}</ul>` : ''}
    </div>`;
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScanDeck validation</title>
<style>
:root { --bg:#f6f6f3; --fg:#1c1c1a; --muted:#6a6a64; --card:#ffffff; --line:#e1e1da; --ok:#1d7a3a; --warn:#9a5a00; --bad:#b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ebebe6; --muted:#9a9a92; --card:#1e1e1c; --line:#34342f; --ok:#5cc27a; --warn:#e0a040; --bad:#ff7b72; } }
* { box-sizing:border-box; }
body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
main { max-width:1180px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:28px 0 10px; }
.muted, figcaption { color:var(--muted); } figcaption { font-size:12px; margin-top:4px; }
table { border-collapse:collapse; width:100%; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; } th { font-weight:600; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
.scroll { overflow-x:auto; }
.row { display:grid; grid-template-columns:repeat(auto-fit, minmax(330px, 1fr)); gap:12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; min-width:0; }
.card.empty { color:var(--muted); }
.cardhead { display:flex; gap:8px; align-items:center; margin-bottom:4px; } .facts { color:var(--muted); font-size:12px; margin-bottom:8px; }
.imgs { display:flex; flex-wrap:wrap; gap:10px; } figure { margin:0; }
img.ov { width:150px; height:150px; object-fit:contain; background:var(--line); border-radius:4px; }
img.crop { width:150px; height:150px; image-rendering:pixelated; border-radius:4px; }
.pill { font-size:11px; padding:1px 7px; border-radius:99px; border:1px solid currentColor; }
.ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
ul.bad { margin:8px 0 0; padding-left:18px; font-size:12px; }
</style></head>
<body><main>
<h1>ScanDeck validation</h1>
<p class="muted">${esc(meta.started)} · ${esc(meta.device?.name ?? 'Epson V370')} · ICA driver ${esc(meta.driverVersion ?? '?')} · macOS ${esc(meta.macOS ?? '?')} ·
area ${area.wCm.toFixed(1)} × ${area.hCm.toFixed(1)} cm from the top-left corner · Epson auto corrections off${meta.finished ? '' : ' · <strong>run in progress or stopped</strong>'}</p>
<div class="scroll"><table><thead><tr><th>dpi</th><th>depth</th><th>correction</th><th>pixels</th><th>MB</th><th>seconds</th><th>tone levels (1 cm)</th><th>status</th></tr></thead>
<tbody>${summaryRows}</tbody></table></div>
<p class="muted">The crops show the same 1 × 1 cm patch from the center of the scan area at the same size, so higher dpi = more real pixels, drawn unsmoothed.
The ×16 contrast view stretches the mid-tones of that patch: 8-bit scans break into bands there, 16-bit scans stay smooth.
"Tone levels" counts the distinct values in the patch (8-bit ≤ 256).</p>
${byDpi.map(({ dpi, cells }) => `<h2>${dpi} dpi</h2><div class="row">${cells.map((r, i) => card(r, bitsList[i])).join('')}</div>`).join('\n')}
${corrRows.length ? `<h2>Epson corrections at ${corr.dpi} dpi, ${corr.bits}-bit</h2>
<p class="muted">Each scan has one correction on, compared with the plain ${corr.dpi} dpi scan over the same 1 × 1 cm. The difference image is ×8.
"Repeat" has no corrections: its difference is scan-to-scan noise, so a correction that differs about as little did nothing visible.</p>
<div class="row">${[corrBase, ...corrRows].filter(Boolean).map((r) => `<div class="card">
  <div class="cardhead"><strong>${esc(r.correction?.label ?? 'Plain (no corrections)')}</strong> <span class="pill ${statusClass(r.status)}">${esc(r.status)}</span></div>
  <div class="facts">${r.diff ? `differs by ${r.diff.maePct.toFixed(2)}% · mean shift R/G/B ${r.diff.meanShiftPct.map((v) => v.toFixed(2)).join(' / ')}` : 'baseline'}</div>
  ${r.previews ? `<div class="imgs"><figure><a href="${esc(r.previews.crop)}"><img class="crop" src="${esc(r.previews.crop)}" alt=""></a><figcaption>1 × 1 cm</figcaption></figure>
  ${r.diff ? `<figure><a href="${esc(r.diff.image)}"><img class="crop" src="${esc(r.diff.image)}" alt=""></a><figcaption>difference ×8</figcaption></figure>` : ''}</div>` : ''}
</div>`).join('')}</div>` : ''}
</main></body></html>
`;
}
