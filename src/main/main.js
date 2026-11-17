'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Scanner } = require('./scanner');
const { Calibration, removeRun } = require('./calibration');
const leaves = require('./leaves');
const { Saver, normalizeFormats } = require('./save');
const { Detector, captureArea, unionClasses } = require('./detect');
const { Segmenter, DEFAULTS: SEG_DEFAULTS } = require('./segment');
const { QR } = require('./qr');
const models = require('./models');
const measure = require('./measure');
const { checkFringe } = require('./fringe');
const tools = require('./tools');
const { Store } = require('./store');

const CLI_MOCK = process.argv.includes('--mock');
// Separate profile (settings, single-instance lock) for tests or a second copy.
if (process.env.SCANDECK_USER_DATA) { const dir = path.resolve(process.env.SCANDECK_USER_DATA); app.setPath('userData', dir); app.setPath('sessionData', dir); }

const ROOT = path.join(__dirname, '..', '..');
const PROBE = path.join(ROOT, 'probe', 'icprobe');
const RUNNER = path.join(ROOT, 'validation', 'run_validation_tests.mjs');
const COMPRESSOR = path.join(ROOT, 'validation', 'compression_test.mjs');
const CALIB_OUT = path.join(ROOT, 'validation_tests_out');
const DEFAULT_OUTPUT = path.join(os.homedir(), 'ScanDeckScans');
const BED_IN = { w: 8.5, h: 11.7 };
// 75 dpi: the detectors see the glass at ~55 dpi anyway (640 px), and below 75 dpi the head is at full
// speed. Measured 2026-11-12: full-glass prescan 20.2 s at 150 dpi, 18.6 s at 75 and 50, same capture area.
const PRESCAN_DPI = 75;
const SAMPLE_PRESCAN = path.join(ROOT, 'probe', 'out', 't03_fullbed_150dpi.tiff');   // mock prescans reuse a real one if present

// Previews (JPEG/PNG) from the output and calibration folders reach the page through sdimg://, never file://.
protocol.registerSchemesAsPrivileged([{ scheme: 'sdimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win = null;
let store = null;
let S = {};                        // latest settings the page saved (output folder, mock)
const scanner = new Scanner({ probe: PROBE, mock: CLI_MOCK, mockSample: SAMPLE_PRESCAN });
const detector = new Detector({ ovdetect: path.join(ROOT, 'probe', 'ovdetect'), modelsDir: path.join(__dirname, '..', 'models') });
let cancelRequested = false;
let confirmWaiter = null;          // resolves the scan that is waiting for the prescan popup
const calibration = new Calibration({ runner: RUNNER, compressor: COMPRESSOR, outRoot: CALIB_OUT, scanner });
const segmenter = new Segmenter({ ovseg: path.join(ROOT, 'probe', 'ovseg'), modelsDir: path.join(__dirname, '..', 'models'), detector });
const qr = new QR({ qrtool: path.join(ROOT, 'probe', 'qrtool') });
const saver = new Saver({ appVersion: app.getVersion(), segmenter, qr, onProgress: (p) => send('save-progress', { id: p.id, side: p.side, folder: p.folder, pct: p.pct, preview: !!p.preview, quality: p.quality || null }), onDone: (r) => send('save-done', { id: r.id, side: r.side, folder: r.folder, ok: r.ok, error: r.error, note: r.note }) });

const outputRoot = () => (typeof S.outputRoot === 'string' && path.isAbsolute(S.outputRoot) ? S.outputRoot : DEFAULT_OUTPUT);
const scanRoot = () => (scanner.mock ? path.join(outputRoot(), '_mock') : outputRoot());   // mock scans never mix with real ones
const inside = (p, root) => { const r = path.resolve(root) + path.sep; return path.resolve(p).startsWith(r); };
const allowedPath = (p) => inside(p, CALIB_OUT) || inside(p, outputRoot());

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  const background = !!process.env.SCANDECK_BACKGROUND;   // automated UI tests: never show or focus the window
  if (background && app.dock) app.dock.hide();
  const dockIcon = path.join(ROOT, 'launcher', 'ScanDeck.png');     // run through Electron, the Dock would show Electron's own icon
  if (!background && app.dock && fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon);
  win = new BrowserWindow({
    width: 1400, height: 960, minWidth: 1000, minHeight: 680,
    title: 'ScanDeck', backgroundColor: '#15171c', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !background },
  });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  if (!background) { win.maximize(); win.show(); }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

const send = (channel, v) => { if (win && !win.isDestroyed()) win.webContents.send(channel, v); };

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'Show Scans Folder', click: () => { fs.mkdirSync(outputRoot(), { recursive: true }); shell.openPath(outputRoot()); } },
      { label: 'Show Calibration Folder', click: () => { fs.mkdirSync(CALIB_OUT, { recursive: true }); shell.openPath(CALIB_OUT); } },
      { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Scan', accelerator: 'CmdOrCtrl+1', click: () => send('menu', 'tab-scan') },
      { label: 'Measure', accelerator: 'CmdOrCtrl+2', click: () => send('menu', 'tab-measure') },
      { label: 'Calibrate', accelerator: 'CmdOrCtrl+3', click: () => send('menu', 'tab-calibrate') },
      { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [{ label: 'Open logs folder', click: () => shell.openPath(app.getPath('logs')) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC: config and settings ---------------------------------------------------------------------
const config = () => ({ version: app.getVersion(), mock: CLI_MOCK, test: !!process.env.SCANDECK_BACKGROUND, platform: process.platform });
ipcMain.handle('config', config);

// Synchronous so the page has its settings before it draws anything.
ipcMain.on('boot', (e) => {
  e.returnValue = {
    config: config(), settings: S && Object.keys(S).length ? S : null,
    paths: { defaultOutput: DEFAULT_OUTPUT, calibOut: CALIB_OUT, userDir: app.getPath('userData'), probe: PROBE, probeBuilt: fs.existsSync(PROBE) },
    detectorClasses: detectorClasses(), segmenterReady: segmenter.ready, models: modelsState, segDefaults: { maskScore: SEG_DEFAULTS.maskScore },
  };
});
function adopt(s) {
  S = s || {};
  if (!scanner.busy) scanner.mock = CLI_MOCK || !!S.options?.mock;
}
ipcMain.handle('settings:save', (_e, s) => { adopt(s); return store.writeSettings(s); });
ipcMain.on('settings:flush-sync', (e, s) => {
  try { adopt(s); store.writeSettingsSync(s); e.returnValue = { ok: true }; } catch (err) { e.returnValue = { ok: false, error: err.message }; }
});

// ---- IPC: scanner ---------------------------------------------------------------------------------
ipcMain.handle('scanner:status', () => scanner.status());
ipcMain.handle('scanner:caps', () => scanner.caps());

function areaInches(area) {
  if (!area || area.mode === 'full') return { full: true, unit: 'in', w: BED_IN.w, h: BED_IN.h };
  const wCm = area.mode === '10cm' ? 10 : Number(area.wCm), hCm = area.mode === '10cm' ? 10 : Number(area.hCm);
  if (!(wCm > 0 && hCm > 0)) throw new Error('Set a scan area width and height in cm.');
  const w = wCm / 2.54, h = hCm / 2.54;
  if (w > BED_IN.w + 1e-6 || h > BED_IN.h + 1e-6) throw new Error(`A ${wCm} × ${hCm} cm area doesn't fit the ${(BED_IN.w * 2.54).toFixed(1)} × ${(BED_IN.h * 2.54).toFixed(1)} cm glass.`);
  return { full: false, unit: 'in', x: 0, y: 0, w, h, wCm, hCm };
}

ipcMain.handle('scan:run', async (e, { id, side, folder, profile }) => {
  if (calibration.running) throw new Error('A calibration run is using the scanner. Wait for it, or stop it in Calibrate.');
  leaves.checkName(id, 'leaf ID'); leaves.checkName(folder, 'folder');
  if (!leaves.SIDES[side]) throw new Error(`Unknown side "${side}"`);
  const dpi = Number(profile?.dpi), bits = Number(profile?.bits);
  if (!Number.isInteger(dpi) || dpi < 50 || dpi > 12800) throw new Error(`Bad resolution: ${profile?.dpi}`);
  if (bits !== 8 && bits !== 16) throw new Error(`Bad bit depth: ${profile?.bits}`);
  const root = scanRoot(), staging = path.join(root, '.staging');
  const wc = e.sender, t0 = Date.now(), stamp = `${id}_${side}_${Date.now()}`;
  const emit = (channel, v) => { if (!wc.isDestroyed()) wc.send(channel, { id, side, ...v }); };
  cancelRequested = false;
  if (profile?.area?.mode === 'auto' && !detector.ready && modelsState.state !== 'ready') {
    throw new Error(modelsState.state === 'fetching' ? `The models are still downloading (${modelsState.total ? Math.round((100 * modelsState.done) / modelsState.total) : 0}%). Auto area needs them; try again when they are in.`
      : `The models could not be downloaded (${modelsState.error}). Retry from the pill at the top.`);
  }
  let area, prescan = null, stagedBBox = null, stagedBBoxAll = null, prescanJpg = null;
  let areaThreshold = null;                 // the confidence picked in the prescan popup (Auto area with its own prescan)
  const closed = () => { if (confirmWaiter) { const w = confirmWaiter; confirmWaiter = null; w({ action: 'cancel' }); } };
  wc.once('destroyed', closed);

  const reuse = profile.area?.mode === 'auto' && side === 'b' && profile.auto?.mirrorTop !== false ? await topCapture(root, folder, id) : null;
  if (reuse) {
    // Bottom side: no prescan. The flipped leaf lies mirrored across the glass, so its capture area is the
    // top side's mirrored left↔right (x measured from the home corner, y unchanged).
    area = { full: false, unit: 'in', x: BED_IN.w - reuse.area.x - reuse.area.w, y: reuse.area.y, w: reuse.area.w, h: reuse.area.h };
    area.wCm = area.w * 2.54; area.hCm = area.h * 2.54;
    const capture = { x: area.x / BED_IN.w, y: area.y / BED_IN.h, w: area.w / BED_IN.w, h: area.h / BED_IN.h };
    const boxes = (reuse.boxes || []).map((f) => ({ ...f, x: 1 - f.x - f.w }));
    const tr = reuse.ruler;             // the top's ruler, mirrored like the area: where the clean QR code goes (qr.js)
    const ruler = tr?.cm ? { score: tr.score, mirrored: true, cm: [+(BED_IN.w * 2.54 - tr.cm[2]).toFixed(2), tr.cm[1], +(BED_IN.w * 2.54 - tr.cm[0]).toFixed(2), tr.cm[3]] } : null;
    prescan = { reusedFrom: `${id}_t`, mirrored: true, ruler, captureCm: [area.x, area.y, area.w, area.h].map((v) => +(v * 2.54).toFixed(2)) };
    emit('scan-phase', { phase: 'scan', preview: reuse.preview, mirrored: true, capture, boxes, wCm: area.wCm, hCm: area.hCm });
    if (reuse.preview) {                 // the top's prescan, flipped: the box lands exactly on this side's area
      stagedBBox = path.join(staging, `${stamp}_previewbbox.jpg`);
      try { await drawBoxes(reuse.preview, stagedBBox, { capture, boxes, flop: true }); } catch (err) { console.error('previewbbox', err.message); stagedBBox = null; }
    }
  } else if (profile.area?.mode === 'auto') {
    const opts = autoOptions(profile.auto);
    const frac = (b) => ({ x: b.x1 / BED_IN.w, y: b.y1 / BED_IN.h, w: (b.x2 - b.x1) / BED_IN.w, h: (b.y2 - b.y1) / BED_IN.h });
    /** The capture area and what goes into the sidecar, for the prescan's detections at one threshold. */
    const planFor = (det, threshold) => {
      const o = { ...opts, threshold };
      const cap = captureArea(det.boxes, { ...o, bed: BED_IN });
      const a = cap ? { full: false, unit: 'in', x: cap.x, y: cap.y, w: cap.w, h: cap.h, wCm: cap.w * 2.54, hCm: cap.h * 2.54 } : { full: true, unit: 'in', w: BED_IN.w, h: BED_IN.h };
      const used = (cap?.used || []).map((b) => ({ model: b.model, label: b.label, score: +b.score.toFixed(3), cm: [b.x1, b.y1, b.x2, b.y2].map((v) => +(v * 2.54).toFixed(2)), frac: frac(b) }));
      const capture = a.full ? { x: 0, y: 0, w: 1, h: 1 } : { x: a.x / BED_IN.w, y: a.y / BED_IN.h, w: a.w / BED_IN.w, h: a.h / BED_IN.h };
      // The ruler as the prescan sees it (far more reliable than on the scan itself), ticked or not: the clean QR code goes below it.
      const rb = det.boxes.filter((b) => b.model === 'archival' && b.label === 'Ruler' && b.score >= 0.3).sort((p, q) => q.score - p.score)[0];
      const ruler = rb ? { score: +rb.score.toFixed(3), cm: [rb.x1, rb.y1, rb.x2, rb.y2].map((v) => +(v * 2.54).toFixed(2)) } : null;
      const info = { dpi: PRESCAN_DPI, ruler, threshold, thresholdSetting: threshold === opts.threshold ? undefined : opts.threshold, paddingCm: o.paddingCm, leafPaddingCm: o.leafPaddingCm, classes: o.classes,
        detected: used.length, nothingFound: !cap, ms: det.ms, captureCm: a.full ? null : [a.x, a.y, a.w, a.h].map((v) => +(v * 2.54).toFixed(2)), capture, boxes: used };
      const phase = { phase: 'scan', preview: prescanJpg, capture, boxes: modelUnions(used), nothingFound: !cap, wCm: a.w * 2.54, hCm: a.h * 2.54 };
      // every single detection at or above the threshold, before the unions (dashed = class not ticked, did not count)
      const all = det.boxes.filter((b) => b.score >= threshold).map((b) => ({ model: b.model, label: b.label, score: b.score, frac: frac(b),
        counted: o.classes[b.model] === 'all' || (o.classes[b.model] || []).includes(b.label) }));
      return { area: a, info, phase, capture, used, all };
    };
    // Each round: 1. prescan of the whole glass, 2. detect, 3. the page asks for confirmation (a popup with every
    // detection and a confidence slider): Go scans the area at the chosen confidence, Rescan Preview starts another round.
    for (;;) {
      emit('scan-phase', { phase: 'prescan' });
      // The prescan file is complete several seconds before the scanner is free again (the head drives home first), so
      // detection starts as soon as the file appears and the popup opens while the head is still on its way home.
      const tPre = Date.now();
      let analysis = null, fileAt = null;
      prescanJpg = null;
      const round = `${stamp}_${Date.now()}`;
      const decided = new Promise((res) => { confirmWaiter = res; });
      const analyze = (preFile) => (analysis ||= (async () => {
        fileAt = Date.now();
        try {
          const jpg = path.join(staging, `${round}_prescan.jpg`);
          await tools.run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', preFile, '--out', jpg]);
          prescanJpg = jpg;
          emit('scan-phase', { phase: 'detect', preview: prescanJpg });
          const pf = await leaves.tiffFacts(preFile);
          const det = await detector.detect({ image: preFile, width: pf.width, height: pf.height, dpi: pf.dpi || PRESCAN_DPI, workDir: staging });
          const plan = planFor(det, opts.threshold);
          emit('scan-phase', { ...plan.phase, phase: 'detected' });       // show the box now; the head is still on its way home
          emit('scan-confirm', { preview: prescanJpg, bed: BED_IN, threshold: opts.threshold, paddingCm: opts.paddingCm, leafPaddingCm: opts.leafPaddingCm, classes: opts.classes,
            dets: det.boxes.filter((b) => b.score >= 0.05).map((b) => ({ model: b.model, label: b.label, score: b.score, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 })) });
          return { det, readyAt: Date.now() };
        } catch (err) { fileAt = null; throw err; }
      })());   // the prescan TIFF stays until the scanner has finished: scanner.scan() looks for it when icprobe exits
      let pre;
      try {
        pre = await scanner.scan({ dpi: PRESCAN_DPI, bits: 8, area: { full: true }, dir: staging, name: `${round}_prescan`,
          onFile: (f) => { analyze(f).catch(() => {}); },
          onProgress: (pct) => emit('scan-progress', { phase: 'prescan', pct }) });
      } catch (err) { confirmWaiter = null; emit('scan-confirm', null); if (analysis) await analysis.catch(() => {}); throw err; }
      const dropPrescan = async () => {
        confirmWaiter = null; emit('scan-confirm', null);
        if (analysis) await analysis.catch(() => null);
        for (const f of [pre.file, prescanJpg]) if (f) fs.rmSync(f, { force: true });
        return { cancelled: true };
      };
      if (pre.cancelled || cancelRequested) return dropPrescan();
      const homeAt = Date.now();
      let found;
      try { found = await analyze(pre.file); } catch (err) { await dropPrescan(); throw err; } finally { fs.rmSync(pre.file, { force: true }); }
      const choice = await decided;                       // Go { threshold } · Rescan Preview · cancel (×, the cancel button, the window closing)
      if (choice?.action === 'rescan' && !cancelRequested) { if (prescanJpg) fs.rmSync(prescanJpg, { force: true }); continue; }
      if (choice?.action !== 'go' || cancelRequested) return dropPrescan();
      const t = Number(choice.threshold);
      areaThreshold = t > 0 && t < 1 ? t : opts.threshold;      // the popup's confidence: used for this scan's area and its plant crop
      const plan = planFor(found.det, areaThreshold);
      stagedBBox = path.join(staging, `${stamp}_previewbbox.jpg`);
      try { await drawBoxes(prescanJpg, stagedBBox, { capture: plan.capture, boxes: modelUnions(plan.used) }); } catch (err) { console.error('previewbbox', err.message); stagedBBox = null; }
      stagedBBoxAll = path.join(staging, `${stamp}_previewbboxall.jpg`);
      try { await drawAll(prescanJpg, stagedBBoxAll, { capture: plan.capture, dets: plan.all }); } catch (err) { console.error('previewbboxall', err.message); stagedBBoxAll = null; }
      area = plan.area;
      prescan = { ...plan.info, timing: { fileS: +((fileAt - tPre) / 1000).toFixed(1), detectedS: +((found.readyAt - tPre) / 1000).toFixed(1), homeS: +((homeAt - tPre) / 1000).toFixed(1), confirmedS: +((Date.now() - tPre) / 1000).toFixed(1) } };
      emit('scan-phase', plan.phase);
      break;
    }
  } else {
    area = areaInches(profile.area);
    emit('scan-phase', { phase: 'scan' });
  }
  if (Math.round(area.w * dpi) * Math.round(area.h * dpi) * 3 * (bits / 8) > 4e9) throw new Error('This area is over the 4 GB TIFF limit at this resolution.');

  // 4. the real scan. The file is complete several seconds before the scanner is free again (the head drives
  // home first), so checking and saving start as soon as the file appears, in the background.
  let job = null, early = null, giveReport;
  const reportReady = new Promise((res) => { giveReport = res; });
  const begin = (file) => (early ||= (async () => {
    const facts = await leaves.checkStaged({ staged: file, report: {}, profile: { dpi, bits }, area });
    if (prescanJpg) fs.rmSync(prescanJpg, { force: true });
    job = { root, folder, id, side, staged: file, stagedPreview: null, stagedBBox, stagedBBoxAll, formats: normalizeFormats(profile.formats), report: {}, reportReady,
      profile: { dpi, bits }, area, facts, prescan, fringe: !!S.options?.fringeCheck, plant: segmenter.plantReady, plantOpts: areaThreshold == null ? plantOptions(profile.auto) : { ...plantOptions(profile.auto), threshold: areaThreshold }, segment: profile.segment !== false && segmenter.ready, segPetiole: profile.segPetiole === true };
    await saver.enqueue(job);
    emit('scan-phase', { phase: 'homing' });
  })());
  let res;
  try {
    res = await scanner.scan({ dpi, bits, area, dir: staging, name: stamp, onFile: (f) => { begin(f).catch(() => {}); },
      onProgress: (pct) => emit('scan-progress', { phase: 'scan', pct, elapsed: (Date.now() - t0) / 1000 }) });
  } catch (err) {
    giveReport({});
    if (!early) for (const f of [stagedBBox, stagedBBoxAll, prescanJpg]) if (f) fs.rmSync(f, { force: true });      // a scan that never produced a file leaves no prescan images behind
    throw err;
  }
  const { report, file, cancelled } = res;
  giveReport(report || {});
  if (cancelled && !early) { for (const f of [file, stagedBBox, stagedBBoxAll, prescanJpg]) if (f) fs.rmSync(f, { force: true }); return { cancelled: true }; }
  await begin(file);                                   // rethrows a rejected scan (wrong size or depth)
  if (job?.jobFile && fs.existsSync(job.jobFile)) { try { fs.writeFileSync(job.jobFile, JSON.stringify({ ...job, report, reportReady: undefined }, null, 2)); } catch {} }
  return { pending: true, seconds: report.scanSeconds ?? (Date.now() - t0) / 1000, prescan: prescan && { detected: prescan.detected, nothingFound: prescan.nothingFound, captureCm: prescan.captureCm, mirrored: !!prescan.mirrored } };
});

/** The top side's Auto capture area (still saving, or from its sidecar), or null if it has none. */
async function topCapture(root, folder, id) {
  const j = saver.pendingFor(root, folder, id, 't');
  const rulerOf = (pre) => pre.ruler || (pre.boxes || []).filter((b) => b.label === 'Ruler' && b.cm).sort((p, q) => q.score - p.score)[0] || null;
  if (j?.prescan?.capture && !j.prescan.nothingFound && !j.area.full) return { area: j.area, boxes: modelUnions(j.prescan.boxes), preview: j.stagedBBox, ruler: rulerOf(j.prescan) };
  const p = leaves.leafPaths(root, folder, id, 't');
  try {
    const meta = JSON.parse(fs.readFileSync(p.sidecar, 'utf8'));
    const a = meta.profile?.area;
    if (!meta.prescan?.capture || meta.prescan.nothingFound || !a || a.full || a.x == null) return null;
    const preview = fs.existsSync(p.previewBBox) ? p.previewBBox : fs.existsSync(p.preview) ? p.preview : null;   // older sides: the preview was the prescan
    return { area: a, boxes: modelUnions(meta.prescan.boxes), preview, ruler: rulerOf(meta.prescan) };
  } catch { return null; }
}

// Colors of the boxes on the prescan (2026-11-13); the renderer's .det / .cap styles and the key use the same.
const BOX_COLORS = { plant: 'rgb(1,178,130)', archival: 'rgb(112,0,173)', capture: 'rgb(82,164,255)' };
/** One box per model: the union of that model's detections that count toward the scan area ([{ model, frac }]), as fractions of the glass. */
function modelUnions(used = []) {
  return ['plant', 'archival'].map((model) => {
    const bs = (used || []).filter((b) => b.model === model && b.frac).map((b) => b.frac);
    if (!bs.length) return null;
    const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
    return { model, x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
  }).filter(Boolean);
}

/** The prescan with the plant union, the archival union and the scan area (their union + padding) drawn in; boxes are fractions of the image. */
async function drawBoxes(src, dest, { capture, boxes = [], flop = false }) {
  const [w, h] = (await tools.run('magick', ['identify', '-format', '%w %h', src])).trim().split(' ').map(Number);
  const rect = (b) => `rectangle ${Math.round(b.x * w)},${Math.round(b.y * h)} ${Math.round((b.x + b.w) * w)},${Math.round((b.y + b.h) * h)}`;
  await tools.run('magick', [src, ...(flop ? ['-flop'] : []), '-fill', 'none',
    '-strokewidth', '2', ...boxes.flatMap((b) => ['-stroke', BOX_COLORS[b.model] || 'rgba(255,255,255,0.75)', '-draw', rect(b)]),
    '-stroke', BOX_COLORS.capture, '-strokewidth', '3', '-draw', rect(capture), '-quality', '88', dest]);
}

/** The prescan at twice its size with every detection drawn on its own: class and score on each, dashed when its class is not ticked. */
async function drawAll(src, dest, { capture, dets = [] }) {
  const K = 2;
  const [w, h] = (await tools.run('magick', ['identify', '-format', '%w %h', src])).trim().split(' ').map((v) => Number(v) * K);
  const font = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc'].find((f) => fs.existsSync(f));
  const xy = (b) => [Math.round(b.x * w), Math.round(b.y * h), Math.round((b.x + b.w) * w), Math.round((b.y + b.h) * h)];
  const args = [src, '-resize', `${K * 100}%`, ...(font ? ['-font', font] : []), '-pointsize', '15', '-gravity', 'NorthWest'];
  const sorted = [...dets].sort((p, q) => q.frac.w * q.frac.h - p.frac.w * p.frac.h);      // small boxes and their labels on top
  for (const d of sorted) {
    const [x1, y1, x2, y2] = xy(d.frac), color = BOX_COLORS[d.model] || 'white';
    args.push('-fill', 'none', '-stroke', color, '-strokewidth', '2', '-draw', `${d.counted ? '' : 'stroke-dasharray 7 5 '}rectangle ${x1},${y1} ${x2},${y2}`);
  }
  for (const d of sorted) {
    const [x1, y1] = xy(d.frac);
    args.push('-stroke', 'none', '-fill', 'white', '-undercolor', BOX_COLORS[d.model] || 'black', '-annotate', `+${Math.min(x1, w - 150)}+${y1 >= 20 ? y1 - 20 : y1 + 2}`, ` ${d.label.replace(/_/g, ' ')} ${d.score.toFixed(2)}${d.counted ? '' : ' (not ticked)'} `);
  }
  const c = xy(capture);
  args.push('-fill', 'none', '-stroke', BOX_COLORS.capture, '-strokewidth', '3', '-draw', `rectangle ${c[0]},${c[1]} ${c[2]},${c[3]}`, '-quality', '88', dest);
  await tools.run('magick', args);
}

/** The plant crop (<ID>_tp) uses the plant classes, threshold and paddings chosen for the Auto area; the leaf padding also goes to the segmenter. */
function plantOptions(a) { const o = autoOptions(a); return { threshold: o.threshold, paddingCm: o.paddingCm, leafPaddingCm: o.leafPaddingCm, classes: o.classes.plant }; }
function autoOptions(a = {}) {
  const threshold = Number(a.threshold), paddingCm = Number(a.paddingCm), leafPaddingCm = Number(a.leafPaddingCm);
  return { threshold: threshold > 0 && threshold < 1 ? threshold : 0.15, paddingCm: paddingCm >= 0 && paddingCm <= 10 ? paddingCm : 1,
    leafPaddingCm: leafPaddingCm > 0 && leafPaddingCm <= 10 ? leafPaddingCm : 0, classes: unionClasses(a.classes) };
}
ipcMain.handle('scan:cancel', () => { cancelRequested = true; answerConfirm({ action: 'cancel' }); return scanner.cancel(); });
// The prescan popup's answer: { action: 'go', threshold } · { action: 'rescan' } · { action: 'cancel' }.
function answerConfirm(choice) { if (!confirmWaiter) return false; const w = confirmWaiter; confirmWaiter = null; w(choice); return true; }
ipcMain.handle('scan:confirm', (_e, choice) => answerConfirm(choice || { action: 'cancel' }));
ipcMain.handle('detector:status', () => ({ ready: detector.ready, segmenter: segmenter.ready }));

// ---- models: fetched from Hugging Face when missing (models.js) ------------------------------------
// { state: 'ready' | 'fetching' | 'error', done, total, file, error }; the page shows it in a pill and, once ready,
// takes the class names and the segmenter's readiness from the 'models' message.
let modelsState = { state: models.missing().length ? 'fetching' : 'ready' };
function fetchModels() {
  if (!models.missing().length) { modelsState = { state: 'ready' }; return; }
  let last = 0;
  modelsState = { state: 'fetching', done: 0, total: models.missing().reduce((s, x) => s + x.bytes, 0) };
  send('models', modelsState);
  models.ensure({ onProgress: (p) => {
    modelsState = { state: 'fetching', ...p };
    if (Date.now() - last > 400 || p.done === p.total) { last = Date.now(); send('models', modelsState); }
  } }).then(() => {
    modelsState = { state: 'ready' };
    send('models', { ...modelsState, detectorClasses: detectorClasses(), segmenterReady: segmenter.ready });
  }, (e) => {
    console.error('models', e.message);
    modelsState = { state: 'error', error: e.message };
    send('models', modelsState);
  });
}
ipcMain.handle('models:retry', () => { if (modelsState.state !== 'fetching' || !models.missing().length) fetchModels(); return modelsState; });
const detectorClasses = () => { try { return detector.classes; } catch { return []; } };
// Sides saved before the fringing check existed get checked in the background the first time they are shown.
const qualityJobs = new Set();
function backfillQuality(root, folder, id, side, info) {
  const p = leaves.leafPaths(root, folder, id, side);
  if (qualityJobs.has(p.sidecar)) return;
  qualityJobs.add(p.sidecar);
  (async () => {
    const meta = JSON.parse(fs.readFileSync(p.sidecar, 'utf8'));
    if (meta.quality || !meta.tiff?.width) return;
    meta.quality = await checkFringe(info.file, { width: meta.tiff.width, height: meta.tiff.height, dpi: meta.profile.dpi });
    fs.writeFileSync(p.sidecar, JSON.stringify(meta, null, 2));
    send('quality-updated', { folder, id, side });
  })().catch((e) => console.error('fringe check', e.message)).finally(() => qualityJobs.delete(p.sidecar));
}

// A side that is still being saved shows as pending (with its preview) until save.js finishes it.
ipcMain.handle('leaf:get', async (_e, { folder, id }) => {
  const root = scanRoot(), l = await leaves.leaf(root, folder, id);
  if (S.options?.fringeCheck) for (const side of ['t', 'b']) if (l[side] && !l[side].quality && l[side].file) backfillQuality(root, folder, id, side, l[side]);
  for (const side of ['t', 'b']) {
    const j = saver.pendingFor(root, folder, id, side);
    if (j) l[side] = { side, pending: true, preview: j.stagedPreview && fs.existsSync(j.stagedPreview) ? j.stagedPreview : null, previewBBox: j.stagedBBox || null, previewBBoxAll: j.stagedBBoxAll && fs.existsSync(j.stagedBBoxAll) ? j.stagedBBoxAll : null, previewSeg: j.stagedSeg && fs.existsSync(j.stagedSeg) ? j.stagedSeg : null, previewPlant: j.stagedPlant && fs.existsSync(j.stagedPlant) ? j.stagedPlant : null, plantSize: j.plantSize || null, width: j.facts?.width, height: j.facts?.height, mtime: Date.now(), name: `${id}_${side}`, dpi: j.profile.dpi, bits: j.profile.bits, seconds: j.report?.scanSeconds ?? null, formats: j.formats, retakes: l[side]?.retakes ?? 0, quality: j.quality ?? null,
      qr: j.qr ? { value: j.qr.value ?? null, match: !!j.qr.match, inserted: !!j.qr.inserted, code: j.qr.inserted ? j.qr.inserted.value || null : null, note: j.qr.note || j.qr.error || null } : null };
  }
  return l;
});
// ReSeg: a saved side's leaf segmented again at another confidence (no scan).
ipcMain.handle('seg:redo', async (_e, { folder, id, side, maskScore, petiole }) => {
  leaves.checkName(id, 'leaf ID'); leaves.checkName(folder, 'folder');
  if (!leaves.SIDES[side]) throw new Error(`Unknown side "${side}"`);
  const r = await saver.reseg({ root: scanRoot(), folder, id, side, maskScore: Number(maskScore), petiole: petiole === true });
  return { fromScan: r.fromScan, keptFraction: r.keptFraction, previousKeptFraction: r.previousKeptFraction, maskScore: r.maskScore };
});
// The leaf on screen: only its ReSeg sources (the plant crops' scanned pixels) are kept; every other leaf's are deleted.
ipcMain.handle('seg:keep', async (_e, { folder, id }) => {
  leaves.checkName(id, 'leaf ID'); leaves.checkName(folder, 'folder');
  return { removed: await saver.keepSources(scanRoot(), folder, id) };
});
// The modules of a QR code, for the tiny code next to the leaf title.
ipcMain.handle('qr:matrix', (_e, value) => {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error('Bad QR text');
  return qr.matrix(value, app.getPath('temp'));
});
ipcMain.handle('saver:status', () => ({ pending: saver.busy }));

// ---- IPC: measure ---------------------------------------------------------------------------------
ipcMain.handle('measure:image', (_e, q) => measure.measureImage(scanRoot(), q));
ipcMain.handle('measure:load', (_e, q) => measure.load(scanRoot(), q));
ipcMain.handle('measure:save', (_e, q) => measure.save(scanRoot(), q, app.getVersion()));
// Progress grid: which sides every leaf of the folder has (a side still being saved counts).
ipcMain.handle('leaves:status', async (_e, { folder }) => {
  const root = scanRoot(), map = await leaves.statusMap(root, folder);
  for (const j of saver.pending.values()) {
    if (j.root !== root || j.folder !== folder) continue;
    const e = (map[j.id] ||= { s: '', warn: '' });
    if (!e.s.includes(j.side)) e.s = j.side === 't' ? `t${e.s}` : `${e.s}b`;
    const issue = leaves.qrIssue(j.qr);              // the take being saved replaces whatever the old sidecar said
    const rest = e.warn.split('; ').filter((w) => w && !w.startsWith(`${leaves.SIDES[j.side].split(' ')[0]}:`));
    e.warn = [...rest, ...(issue ? [`${leaves.SIDES[j.side].split(' ')[0]}: ${issue}`] : [])].join('; ');
  }
  return map;
});
// The Scanned strip: newest first (sort 'time', the default), or by ID with numbers in numeric order ('name': UM-001-A, UM-001-B, UM-002-A, …).
ipcMain.handle('leaves:list', async (_e, { folder, sort }) => {
  const list = await leaves.listLeaves(scanRoot(), folder);
  if (sort === 'name') list.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true, sensitivity: 'base' }));
  return list.slice(0, sort === 'name' ? 400 : 80);      // by name the whole project is shown; by time, the 80 newest as before
});

// ---- IPC: calibration -----------------------------------------------------------------------------
ipcMain.handle('calib:runs', () => calibration.runs());
ipcMain.handle('calib:start', (_e, opts) => calibration.start({ ...opts, mock: scanner.mock }, {
  onLine: (line) => send('calib-line', line),
  onExit: (r) => send('calib-done', r),
}));
ipcMain.handle('calib:stop', () => calibration.stop());
ipcMain.handle('calib:compress', (_e, id) => calibration.compress(id, {
  onLine: (line) => send('calib-line', line),
  onExit: (r) => send('compress-done', r),
}));
ipcMain.handle('calib:status', () => ({ running: calibration.running }));
ipcMain.handle('calib:remove', async (_e, { id, label }) => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Move to Trash', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Delete the calibration run “${label || id}”?`, detail: 'The folder with its scans goes to the Trash, so you can still get it back from there.' });
  if (r.response !== 0) return { deleted: false };
  await removeRun(CALIB_OUT, id, (dir) => shell.trashItem(dir));
  return { deleted: true };
});

// ---- IPC: files -----------------------------------------------------------------------------------
ipcMain.handle('path:open', (_e, p) => { if (!allowedPath(p)) throw new Error('That file is outside ScanDeck’s folders.'); return shell.openPath(p); });
// HTML reports open in the browser (openPath could hand an .html file to an editor).
ipcMain.handle('path:browse', (_e, p) => { if (!allowedPath(p) || !/\.html$/.test(p)) throw new Error('Not a report.'); return shell.openExternal(pathToFileURL(p).toString()); });
ipcMain.handle('path:reveal', (_e, p) => { if (!allowedPath(p)) throw new Error('That file is outside ScanDeck’s folders.'); shell.showItemInFolder(p); });
ipcMain.handle('folder:open', (_e, which) => {
  const dir = which === 'calibration' ? CALIB_OUT : which === 'userData' ? app.getPath('userData') : scanRoot();
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
ipcMain.handle('dir:choose', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose where ScanDeck saves scans', defaultPath: current || DEFAULT_OUTPUT, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---- quitting while the scanner works -------------------------------------------------------------
let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting) return;
  if (!scanner.busy && saver.busy) {
    e.preventDefault();
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Wait, then quit', 'Quit now'], defaultId: 0, cancelId: 0,
      message: `Saving ${saver.busy} scan${saver.busy === 1 ? '' : 's'}…`, detail: 'Quitting now is safe too: unfinished saves continue the next time ScanDeck opens.' });
    quitting = true;
    if (r.response === 0) { while (saver.busy) await new Promise((res) => setTimeout(res, 300)); }
    app.quit();
    return;
  }
  if (!scanner.busy) return;
  e.preventDefault();
  const what = scanner.busyWith === 'calibration' ? 'A calibration run is in progress.' : 'A scan is in progress.';
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Stop and quit', 'Keep scanning'], defaultId: 1, cancelId: 1, message: what,
    detail: scanner.busyWith === 'calibration' ? 'The run stops after the scan in progress, then ScanDeck quits.' : 'The scan is cancelled cleanly, then ScanDeck quits.' });
  if (r.response !== 0) return;
  quitting = true;
  if (scanner.busyWith === 'calibration') calibration.stop(); else scanner.cancel();
  const t0 = Date.now();
  while (scanner.busy && Date.now() - t0 < 10 * 60 * 1000) await new Promise((res) => setTimeout(res, 300));
  app.quit();
});

app.whenReady().then(() => {
  if (!primary) return;
  store = new Store({ userDir: app.getPath('userData') });
  adopt(store.readSettingsSync());
  saver.recover([outputRoot(), path.join(outputRoot(), '_mock')]).then((n) => { if (n) console.log(`resuming ${n} unfinished save(s)`); });
  protocol.handle('sdimg', (req) => {
    const p = new URL(req.url).searchParams.get('p') || '';
    if (!allowedPath(p) || !/\.(jpe?g|png)$/i.test(p)) return new Response('not allowed', { status: 403 });
    return net.fetch(pathToFileURL(path.resolve(p)).toString());
  });
  buildMenu();
  createWindow();
  win.webContents.once('did-finish-load', fetchModels);      // models missing (a fresh clone): fetch them now, with progress in the page
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
