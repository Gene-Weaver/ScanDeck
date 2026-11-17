import { api, cleanError } from './api.js';
import { $, toast } from './util.js';
import { defaultPattern } from './pattern.js';
import { initScan } from './scan.js';
import { initCalibrate } from './calibrate.js';
import { initMeasure } from './measure.js';
import { initProfile } from './profile.js';

// ---------------------------------------------------------------- settings (settings.json in the user data folder)
const DEFAULTS = {
  tab: 'scan',
  pattern: defaultPattern(),                 // TapeDeck's default: UM / 001–052 / A–C, separator "-"
  current: 1,                                // 1-based position of the current leaf in the pattern
  profile: { dpi: 1200, bits: 16, area: { mode: 'auto', wCm: 10, hCm: 10 }, auto: { threshold: 0.15, paddingCm: 1, leafPaddingCm: 0, mirrorTop: true }, formats: { jxl: false, jxlLossy: true, tiff: false }, segment: true, segPetiole: false },
  migrations: {},
  outputRoot: null,                          // null = ~/ScanDeckScans
  calib: { dpis: [150, 300, 600, 1200, 2400], bits: [8, 16], corrections: true, compression: true, area: { mode: '10cm', wCm: 10, hCm: 10 }, runId: null, view: 'compare' },
  options: { mock: false, sound: true, fringeCheck: false, flipReminder: false, view: 'a', hotkeys: false, dockSort: 'time' },
};
const boot = api.boot();
const config = boot.config || { mock: false, version: '' };
const S = loadSettings(boot.settings);

function loadSettings(stored) {
  const out = deepMerge(structuredClone(DEFAULTS), stored || {});
  if (!Array.isArray(out.pattern?.segments)) out.pattern = defaultPattern();
  out.current = Math.max(1, Math.floor(Number(out.current)) || 1);
  if (!Number.isInteger(out.profile.dpi) || out.profile.dpi < 50 || out.profile.dpi > 12800) out.profile.dpi = DEFAULTS.profile.dpi;
  if (![8, 16].includes(out.profile.bits)) out.profile.bits = 16;
  const f = out.profile.formats;
  if (!f.jxl && !f.jxlLossy && !f.tiff) out.profile.formats = { ...DEFAULTS.profile.formats };
  if (!out.migrations.lossyOnly) { out.profile.formats = { ...DEFAULTS.profile.formats }; out.migrations.lossyOnly = true; }   // 2026-11-13: lossy JXL only; TIFF and lossless JXL are opt-in
  if ('showSegmented' in out.options) { if (out.options.showSegmented) out.options.view = 's'; delete out.options.showSegmented; }   // 2026-11-13: one switch for three products
  if (!out.migrations.barcodeLabel) {     // 2026-11-17: Barcode and Label count toward the Auto area by default (the petiole label and its QR code)
    const a = out.profile.auto.classes?.archival;
    if (Array.isArray(a)) out.profile.auto.classes.archival = [...new Set([...a, 'Barcode', 'Label'])];
    out.migrations.barcodeLabel = true;
  }
  if (!out.migrations.autoArea) { out.profile.area.mode = 'auto'; out.migrations.autoArea = true; }   // 2026-11-12: Auto is the default
  if (!['auto', '10cm', 'custom', 'full'].includes(out.profile.area.mode)) out.profile.area.mode = 'auto';
  if (!['10cm', 'custom', 'full'].includes(out.calib.area.mode)) out.calib.area.mode = '10cm';
  if (!Array.isArray(out.calib.dpis)) out.calib.dpis = [...DEFAULTS.calib.dpis];
  if (!Array.isArray(out.calib.bits)) out.calib.bits = [...DEFAULTS.calib.bits];
  if (!['scan', 'measure', 'calibrate'].includes(out.tab)) out.tab = 'scan';
  return out;
}
function deepMerge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, b[k]); else a[k] = b[k]; } return a; }

let settingsTimer = null, settingsDirty = false;
function save() { settingsDirty = true; clearTimeout(settingsTimer); settingsTimer = setTimeout(saveNow, 300); }
async function saveNow() {
  clearTimeout(settingsTimer);
  settingsDirty = false;
  try { await api.saveSettings(S); } catch (e) { settingsDirty = true; console.error('saving settings', e); }
}
window.addEventListener('beforeunload', () => { if (settingsDirty) api.flushSettingsSync(S); });

// ---------------------------------------------------------------- shared context for the tabs
const busy = { scan: false, calib: false };
let status = null;
let scan = null, calibrate = null, profile = null, measure = null;   // the two tabs and the scan-settings popover, created at the bottom
const ctx = {
  S, config, paths: boot.paths || {}, detectorClasses: boot.detectorClasses || [], segmenterReady: !!boot.segmenterReady, segDefaults: boot.segDefaults || { maskScore: 0.3 },
  save, saveNow,
  busy, runs: [],
  get status() { return status; },
  mock: () => !!(config.mock || S.options.mock),
  setBusy(kind, on) {
    busy[kind] = on;
    document.body.classList.toggle('scanning', busy.scan || busy.calib);
    renderPill(); scan?.onBusy(); calibrate?.onBusy();
    if (!on) setTimeout(refreshStatus, 500);
  },
  profileChanged() { profile?.refresh(); scan?.onProfile(); calibrate?.onProfile(); },
  outputChanged() { scan?.onOutput(); measure?.onOutput(); },
  viewChanged() { measure?.onView(); },                 // Archival / Plant / Leaf switch (shared by Scan and Measure)
  pickLeaf(id) { measure?.pick(id); },                  // a leaf clicked in the Scanned strip while measuring
  get measureId() { return measure?.id ?? null; },
  openLightbox,
};

// ---------------------------------------------------------------- scanner pill
async function refreshStatus() {
  try { status = await api.scanner.status(); } catch (e) { status = { connected: false, error: cleanError(e) }; }
  renderPill(); calibrate?.onStatus();
}
function renderPill() {
  const p = $('scannerPill'), t = p.querySelector('.txt');
  p.className = 'pill';
  if (busy.scan || busy.calib || status?.busy) { p.classList.add('pill-busy'); t.textContent = busy.calib || status?.busy === 'calibration' ? 'Calibrating…' : 'Scanning…'; }
  else if (ctx.mock()) { p.classList.add('pill-mock'); t.textContent = 'Mock scanner'; }
  else if (status?.connected) { p.classList.add('pill-on'); t.textContent = `${status.name || 'Scanner'} · ICA ${status.driver || '?'}`; }
  else if (status) { p.classList.add('pill-off'); t.textContent = status.error || 'Scanner not found'; }
  else { p.classList.add('pill-off'); t.textContent = 'Looking for scanner…'; }
}
setInterval(() => { if (!busy.scan && !busy.calib && !document.hidden) refreshStatus(); }, 15000);

// ---------------------------------------------------------------- models (fetched from Hugging Face when missing)
function renderModels(m) {
  const p = $('modelsPill'), t = p.querySelector('.txt');
  p.classList.toggle('hidden', !m || m.state === 'ready');
  if (!m || m.state === 'ready') return;
  p.classList.toggle('pill-busy', m.state === 'fetching'); p.classList.toggle('pill-off', m.state === 'error');
  const mb = (b) => Math.round((b || 0) / 1e6);
  t.textContent = m.state === 'fetching' ? `Downloading models ${m.total ? Math.round((100 * m.done) / m.total) : 0}% · ${mb(m.done)} / ${mb(m.total)} MB` : 'Models: download failed · retry';
  p.dataset.tip = m.state === 'fetching' ? `From Hugging Face (LeafMachine3), once: ${m.file || ''}. Auto area and the plant / leaf products need them.` : `${m.error || ''} · click to try again`;
}
$('modelsPill').onclick = () => { if ($('modelsPill').classList.contains('pill-off')) api.retryModels().then(renderModels); };
api.onModels((m) => {
  if (m.state === 'ready' && m.detectorClasses) {
    ctx.detectorClasses = m.detectorClasses; ctx.segmenterReady = !!m.segmenterReady;
    profile?.refresh(); scan?.onBusy();
    toast('Models ready.');
  }
  renderModels(m);
});
renderModels(boot.models);


// ---------------------------------------------------------------- tabs
function setTab(name) {
  S.tab = name; save();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('tab-scan').classList.toggle('hidden', name !== 'scan');
  $('tab-measure').classList.toggle('hidden', name !== 'measure');
  $('dock').classList.toggle('hidden', name === 'calibrate');          // the Scanned strip serves Scan and Measure
  $('tab-calibrate').classList.toggle('hidden', name !== 'calibrate');
  if (name === 'scan') scan.onShow(); else if (name === 'measure') { scan.refreshDock(); measure.onShow(); } else calibrate.onShow();
}
document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
api.onMenu((cmd) => { if (cmd === 'tab-scan') setTab('scan'); if (cmd === 'tab-measure') setTab('measure'); if (cmd === 'tab-calibrate') setTab('calibrate'); });

// ---------------------------------------------------------------- lightbox
// Items carry a grid position { r, c }: ← → move along the row, ↑ ↓ to the nearest row with an image
// in the same column (or the closest column in that row).
let lbItems = [], lbIndex = 0;
const lbOpen = () => !$('lightbox').classList.contains('hidden');
function openLightbox(items, index = 0) {
  lbItems = (Array.isArray(items) ? items : [items]).map((it, i) => ({ r: 0, c: i, ...it }));
  lbIndex = index;
  showLightbox();
  $('lightbox').classList.remove('hidden');
}
function showLightbox() {
  const it = lbItems[lbIndex];
  $('lbImg').src = it.src; $('lbImg').classList.toggle('px', !!it.pixelated);
  $('lbTitle').textContent = it.title || ''; $('lbCaption').textContent = it.caption || '';
  $('lbOpen').classList.toggle('hidden', !it.tiff);
  for (const [id, d] of [['lbLeft', 'left'], ['lbRight', 'right'], ['lbUp', 'up'], ['lbDown', 'down']]) {
    const target = lbStep(d);
    $(id).disabled = target < 0;
    $(id).classList.toggle('hidden', (d === 'up' || d === 'down') && new Set(lbItems.map((x) => x.r)).size < 2);
  }
}
function lbStep(dir) {
  const cur = lbItems[lbIndex];
  let best = -1, bestScore = Infinity;
  lbItems.forEach((it, i) => {
    if (i === lbIndex) return;
    let score;
    if (dir === 'left' || dir === 'right') {
      if (it.r !== cur.r) return;
      const dc = it.c - cur.c;
      if ((dir === 'right' && dc <= 0) || (dir === 'left' && dc >= 0)) return;
      score = Math.abs(dc);
    } else {
      const dr = it.r - cur.r;
      if ((dir === 'down' && dr <= 0) || (dir === 'up' && dr >= 0)) return;
      score = Math.abs(dr) * 1000 + Math.abs(it.c - cur.c);
    }
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
function lbMove(dir) { const i = lbStep(dir); if (i >= 0) { lbIndex = i; showLightbox(); } }
const closeLightbox = () => { $('lightbox').classList.add('hidden'); $('lbImg').src = ''; };
$('lbClose').onclick = closeLightbox;
$('lbLeft').onclick = () => lbMove('left'); $('lbRight').onclick = () => lbMove('right');
$('lbUp').onclick = () => lbMove('up'); $('lbDown').onclick = () => lbMove('down');
$('lightbox').onclick = (e) => { if (e.target === $('lightbox') || e.target.classList.contains('lb-body')) closeLightbox(); };
$('lbOpen').onclick = () => { const t = lbItems[lbIndex]?.tiff; if (t) api.openPath(t).catch((e) => toast(cleanError(e), true)); };

// ---------------------------------------------------------------- hover hints ([data-tip])
let tipFor = null;
document.addEventListener('mouseover', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
  if (el === tipFor) return;
  tipFor = el;
  const box = $('tipBox');
  if (!el || !el.dataset.tip) { box.classList.add('hidden'); return; }
  box.textContent = el.dataset.tip; box.classList.remove('hidden');
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left + r.width / 2 - b.width / 2), window.innerWidth - b.width - 8);
  const top = r.bottom + 8 + b.height > window.innerHeight ? r.top - b.height - 8 : r.bottom + 8;
  box.style.left = `${left}px`; box.style.top = `${top}px`;
});
document.addEventListener('mousedown', () => { $('tipBox').classList.add('hidden'); tipFor = null; });

// ---------------------------------------------------------------- settings modal
$('btnSettings').onclick = () => {
  $('optSound').checked = !!S.options.sound;
  $('optFlip').checked = !!S.options.flipReminder;
  $('optFringe').checked = !!S.options.fringeCheck;
  $('optHotkeys').checked = S.options.hotkeys === true;
  $('optMock').checked = ctx.mock(); $('optMock').disabled = !!config.mock;
  $('optMock').parentElement.dataset.tip = config.mock ? 'Started with --mock' : '';
  $('dataDir').textContent = ctx.paths.userDir || '';
  $('verTxt').textContent = `ScanDeck ${config.version || ''}`;
  $('settings').classList.remove('hidden');
};
$('settingsClose').onclick = () => $('settings').classList.add('hidden');
$('optSound').onchange = () => { S.options.sound = $('optSound').checked; save(); };
$('optFlip').onchange = () => { S.options.flipReminder = $('optFlip').checked; save(); scan.onShow(); };
$('optFringe').onchange = async () => { S.options.fringeCheck = $('optFringe').checked; await saveNow(); scan.onShow(); };
$('optHotkeys').onchange = () => { S.options.hotkeys = $('optHotkeys').checked; save(); scan.onShow(); };
$('optMock').onchange = async () => {
  if (busy.scan || busy.calib) { $('optMock').checked = ctx.mock(); toast('Wait for the scanner to finish first.', true); return; }
  S.options.mock = $('optMock').checked;
  await saveNow();                      // the main process switches scanner and output folder on save
  renderPill(); refreshStatus(); scan.onOutput(); calibrate.onMock();
};
$('btnShowData').onclick = () => api.openFolder('userData');

// With hot keys off, a button clicked in the Scan tab does not keep the focus: otherwise Space or Enter would press it
// again (the big button would start the next scan, ▶ would move on).
document.addEventListener('click', (e) => {
  if (S.options.hotkeys === true || !(e.target instanceof Element)) return;
  const b = e.target.closest('button');
  if (b && b.closest('#tab-scan')) b.blur();
});

// ---------------------------------------------------------------- keys
const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
document.addEventListener('keydown', (e) => {
  if (lbOpen()) {
    if (e.key === 'Escape') closeLightbox();
    else if (ARROWS[e.key]) { e.preventDefault(); lbMove(ARROWS[e.key]); }
    return;
  }
  if (!$('prescanConfirm').classList.contains('hidden')) return;      // the prescan popup takes no keys (hot keys off means off): Go, Rescan Preview and × are clicked
  if (!$('reseg').classList.contains('hidden')) { if (e.key === 'Escape') $('resegCancel').click(); return; }
  if (e.key === 'Escape') {
    if (profile.isOpen()) { profile.close(); return; }
    if (!$('settings').classList.contains('hidden')) { $('settings').classList.add('hidden'); return; }
  }
  if (!$('settings').classList.contains('hidden') || profile.isOpen()) return;
  if (S.tab === 'scan') { if (S.options.hotkeys === true) scan.onKey(e); }      // Scan-tab hot keys are opt-in (Settings): a stray key must not start a scan
  else if (S.tab === 'measure') measure.onKey(e);
});

// ---------------------------------------------------------------- start
profile = initProfile(ctx);
scan = initScan(ctx);
calibrate = initCalibrate(ctx);
measure = initMeasure(ctx, { folder: scan.folder, currentId: scan.currentId, markDock: scan.markDock, paintView: scan.paintView });
renderPill();
setTab(S.tab);
refreshStatus();
if (config.test) window.__scandeck = { S, ctx, scan, calibrate, profile, measure };
