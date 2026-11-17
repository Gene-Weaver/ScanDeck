// Scan settings: the popover that opens from the profile chip in the top bar. These are the
// everyday settings the Scan tab uses; calibration runs have their own (Calibrate tab).
import { api } from './api.js';
import { $, esc, toast, fmtBytes, fmtSecs, areaLabel, pixelsFor, BED_CM } from './util.js';
import { estimate, PRESCAN_SECONDS } from './estimate.js';

const DPIS = [150, 300, 600, 1200, 2400, 4800];
const BITS = [[8, '8-bit'], [16, '16-bit']];
const AREAS = [['auto', 'Auto'], ['10cm', '10 × 10 cm'], ['custom', 'Custom'], ['full', 'Full glass']];
const AREA_TIPS = { auto: 'A quick 75 dpi prescan of the whole glass, then only what the plant and archival detectors find (boxes of the ticked classes above the threshold, plus padding).' };
const FORMATS = [
  ['tiff', 'TIFF', 'Uncompressed, lossless. Saves in about a second; checked pixel-for-pixel against the scan.'],
  ['jxlLossy', 'JPEG XL lossy', 'Distance 1: visually lossless, about 3% of the raw size.'],
  ['jxl', 'JPEG XL lossless', 'About 30% smaller than the TIFF, but roughly 10× slower to save. Checked pixel-for-pixel.'],
];
const MODEL_LABELS = { plant: 'Plant', archival: 'Archival' };
export const FORMAT_LABELS = { jxl: 'JXL', jxlLossy: 'JXL lossy', tiff: 'TIFF' };

export function seg(id, options, value, onPick, tips = {}) {
  const root = $(id);
  root.innerHTML = options.map(([v, label]) => `<button data-v="${esc(v)}" class="${String(v) === String(value) ? 'active' : ''}"${tips[v] ? ` data-tip="${esc(tips[v])}"` : ''}>${esc(label)}</button>`).join('');
  root.querySelectorAll('button').forEach((b) => { b.onclick = () => onPick(b.dataset.v); });
}

export function bindDims(wId, hId, area, onChange) {
  $(wId).value = area.wCm ?? 10; $(hId).value = area.hCm ?? 10;
  const h = () => {
    const w = Number($(wId).value), hh = Number($(hId).value);
    if (w > 0) area.wCm = Math.min(w, +BED_CM.w.toFixed(2));
    if (hh > 0) area.hCm = Math.min(hh, +BED_CM.h.toFixed(2));
    onChange();
  };
  $(wId).oninput = h; $(hId).oninput = h;
}

export function initProfile(ctx) {
  const { S } = ctx;
  const chip = $('profileChip'), pop = $('profilePop');

  function renderChip() {
    chip.innerHTML = `<b>${S.profile.dpi} dpi</b> · ${S.profile.bits}-bit · ${esc(areaLabel(S.profile.area))}`;
  }
  function render() {
    seg('profDpi', DPIS.map((d) => [d, d]), S.profile.dpi, (v) => { S.profile.dpi = Number(v); changed(); });
    seg('profBits', BITS, S.profile.bits, (v) => { S.profile.bits = Number(v); changed(); }, { 8: '24-bit color', 16: '48-bit color' });
    seg('profArea', AREAS, S.profile.area.mode, (v) => { S.profile.area.mode = v; changed(); }, AREA_TIPS);
    $('profCustom').classList.toggle('hidden', S.profile.area.mode !== 'custom');
    $('profAuto').classList.toggle('hidden', S.profile.area.mode !== 'auto');
    $('profFormats').innerHTML = FORMATS.map(([k, label, tip]) => `<label class="toggle" data-tip="${esc(tip)}"><input type="checkbox" data-f="${k}" ${S.profile.formats[k] ? 'checked' : ''}><span class="sw"></span>${label}</label>`).join('');
    if (ctx.segmenterReady) $('profFormats').insertAdjacentHTML('beforeend', `<label class="toggle" data-tip="The main product, named _tl / _bl: the plant crop (_tp / _bp) with everything but the leaf black (background and holes). Same quality as the JPEG XL; made in the background."><input type="checkbox" id="profSegment" ${S.profile.segment !== false ? 'checked' : ''}><span class="sw"></span>Segmented leaf</label>`);
    $('profFormats').querySelectorAll('input[data-f]').forEach((inp) => {
      inp.onchange = () => {
        const f = { ...S.profile.formats, [inp.dataset.f]: inp.checked };
        if (!f.jxl && !f.jxlLossy && !f.tiff) { inp.checked = true; toast('Keep at least one format on.', true); return; }
        S.profile.formats = f; changed();
      };
    });
    $('profPetioleRow').classList.toggle('hidden', !ctx.segmenterReady);
    $('profPetiole').checked = S.profile.segPetiole === true; $('profPetiole').disabled = S.profile.segment === false;
    if ($('profPetiole')) $('profPetiole').onchange = () => { S.profile.segPetiole = $('profPetiole').checked; changed(); };
    if ($('profSegment')) $('profSegment').onchange = () => { S.profile.segment = $('profSegment').checked; changed(); };
    const e = estimate(S.profile, ctx.runs);
    const { w, h } = pixelsFor(S.profile.area, S.profile.dpi);
    const size = e.parts.length > 1 ? e.parts.map((p) => fmtBytes(p.bytes)).join(' + ') : fmtBytes(e.bytes);
    $('profEstimate').classList.toggle('hidden', S.profile.area.mode === 'auto');     // Auto: the size is not known before the prescan
    $('profEstimate').innerHTML = S.profile.area.mode === 'auto' ? ''
      : `${w.toLocaleString()} × ${h.toLocaleString()} px · ${e.seconds ? `≈ <b>${fmtSecs(e.seconds)}</b> · ` : ''}≈ <b>${size}</b> per side`
        + (e.rawBytes > 4e9 ? '<br><span class="danger">Over the 4 GB TIFF limit</span>' : '');
    renderClasses();
    $('outDir').textContent = (S.outputRoot || ctx.paths.defaultOutput) + (ctx.mock() ? '/_mock' : '');
  }
  function changed() { ctx.save(); render(); renderChip(); ctx.profileChanged(); }
  // Which detection classes define the Auto area, per model (stored only once changed from the defaults).
  let models = ctx.detectorClasses || [];          // updated when the models arrive (first run): see refresh()
  const chosen = (m) => (Array.isArray(S.profile.auto.classes?.[m.key]) ? S.profile.auto.classes[m.key] : m.defaults);
  function renderClasses() {
    models = ctx.detectorClasses || [];
    $('profClasses').classList.toggle('hidden', !models.length || S.profile.area.mode !== 'auto');
    $('profClassCount').textContent = models.map((m) => `${chosen(m).length}/${m.names.length}`).join(' · ');
    $('profClassList').innerHTML = models.map((m) => `<div><h5>${esc(MODEL_LABELS[m.key] || m.key)} <button class="small" data-all="${esc(m.key)}">${chosen(m).length === m.names.length ? 'None' : 'All'}</button></h5>`
      + m.names.map((n) => `<label class="check"><input type="checkbox" data-m="${esc(m.key)}" data-c="${esc(n)}" ${chosen(m).includes(n) ? 'checked' : ''}> ${esc(n.replace(/_/g, ' '))}</label>`).join('') + '</div>').join('');
    const set = (m, list) => { S.profile.auto.classes = { ...(S.profile.auto.classes || {}), [m.key]: m.names.filter((n) => list.includes(n)) }; ctx.save(); renderClasses(); };
    $('profClassList').querySelectorAll('input').forEach((inp) => {
      inp.onchange = () => { const m = models.find((x) => x.key === inp.dataset.m); set(m, inp.checked ? [...chosen(m), inp.dataset.c] : chosen(m).filter((n) => n !== inp.dataset.c)); };
    });
    $('profClassList').querySelectorAll('button').forEach((b) => {
      b.onclick = () => { const m = models.find((x) => x.key === b.dataset.all); set(m, chosen(m).length === m.names.length ? [] : m.names); };
    });
  }
  bindDims('profW', 'profH', S.profile.area, changed);
  $('profThr').value = S.profile.auto.threshold; $('profPad').value = S.profile.auto.paddingCm;
  $('profThr').oninput = () => { const v = Number($('profThr').value); if (v > 0 && v < 1) { S.profile.auto.threshold = v; ctx.save(); } };
  $('profPad').oninput = () => { const v = Number($('profPad').value); if (v >= 0 && v <= 10) { S.profile.auto.paddingCm = v; ctx.save(); } };
  $('profLeafPad').value = S.profile.auto.leafPaddingCm ?? 0;
  $('profLeafPad').oninput = () => { const v = Number($('profLeafPad').value); if (v >= 0 && v <= 10) { S.profile.auto.leafPaddingCm = v; ctx.save(); } };
  $('profMirror').checked = S.profile.auto.mirrorTop !== false;
  $('profMirror').onchange = () => { S.profile.auto.mirrorTop = $('profMirror').checked; ctx.save(); };
  $('btnOutDir').onclick = async () => {
    const dir = await api.chooseDir(S.outputRoot || ctx.paths.defaultOutput);
    if (!dir) return;
    S.outputRoot = dir; ctx.saveNow(); render(); ctx.outputChanged();
  };
  $('btnOutShow').onclick = () => api.openFolder('scans');

  const isOpen = () => pop.classList.contains('open');
  function open() { render(); pop.classList.add('open'); chip.setAttribute('aria-expanded', 'true'); }
  function close() { pop.classList.remove('open'); chip.setAttribute('aria-expanded', 'false'); }
  chip.onclick = (e) => { e.stopPropagation(); if (isOpen()) close(); else open(); };
  document.addEventListener('mousedown', (e) => { if (isOpen() && !pop.contains(e.target) && !chip.contains(e.target)) close(); });

  renderChip();
  return { renderChip, refresh() { renderChip(); if (isOpen()) render(); }, isOpen, close };
}
