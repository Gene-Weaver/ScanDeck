// Scan tab: pick the leaf ID (TapeDeck-style pattern), scan top then bottom, move on.
import { api, cleanError, imgUrl } from './api.js';
import { $, esc, toast, fmtBytes, fmtSecs, chime, areaCm } from './util.js';
import { patternSeries, segmentValues } from './pattern.js';
import { estimate, OVERHEAD_S, PRESCAN_SECONDS } from './estimate.js';
import { FORMAT_LABELS } from './profile.js';

const SIDES = [
  { key: 't', name: 'Top', face: 'adaxial' },
  { key: 'b', name: 'Bottom', face: 'abaxial' },
];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function initScan(ctx) {
  const { S } = ctx;
  let leaf = { id: null, t: null, b: null };
  let scanning = null;           // { side, t0, pct, est, cancelling }
  let leafReq = 0, tick = null, keptLeaf = null;

  // ---------------------------------------------------------------- IDs
  const total = () => patternSeries({ ...S.pattern, from: 1, to: 1 }).total;
  const idAt = (n) => (n >= 1 && n <= total() ? patternSeries({ ...S.pattern, from: n, to: n }).values[0]?.text ?? '' : '');
  const currentId = () => idAt(S.current);
  /** Scans go to <output>/<first text segment, e.g. UM>/. */
  function folder() {
    const seg = S.pattern.segments.find((s) => s.type === 'text' && String(s.value ?? '').trim());
    const f = seg ? String(seg.value).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '') : '';
    return f || 'scans';
  }
  const outRoot = () => (S.outputRoot || ctx.paths.defaultOutput) + (ctx.mock() ? '/_mock' : '');

  function indexOfId(text) {
    const want = String(text).trim().toLowerCase();
    if (!want) return 0;
    if (/^\d+$/.test(want)) { const n = Number(want); return n >= 1 && n <= total() ? n : 0; }
    const n = total();
    if (n > 200000) return 0;
    const all = patternSeries({ ...S.pattern, from: 1, to: n }).values;
    const hit = all.find((v) => v.text.toLowerCase() === want);
    return hit ? hit.n : 0;
  }

  // ---------------------------------------------------------------- pattern editor (as in TapeDeck)
  function renderSegments() {
    const root = $('segments'); root.innerHTML = '';
    S.pattern.segments.forEach((sg, k) => {
      const row = document.createElement('div'); row.className = 'segrow';
      const vals = sg.type === 'text' ? `<input data-k="value" value="${esc(sg.value ?? '')}" placeholder="text">`
        : sg.type === 'letters' ? `<input data-k="start" value="${esc(sg.start ?? 'A')}" placeholder="A" style="width:4.5em"><span class="muted">→</span><input data-k="end" value="${esc(sg.end ?? 'C')}" placeholder="C" style="width:4.5em">`
        : `<input data-k="start" type="number" value="${sg.start ?? 1}" style="width:4em"><span class="muted">→</span><input data-k="end" type="number" value="${sg.end ?? 3}" style="width:4em"><input data-k="pad" type="number" class="pad" min="0" max="9" value="${sg.pad ?? 2}" title="Zero-pad to this many digits">`;
      row.innerHTML = `<input data-k="name" value="${esc(sg.name ?? '')}" placeholder="name">
        <select data-k="type"><option value="text" ${sg.type === 'text' ? 'selected' : ''}>Text</option><option value="letters" ${sg.type === 'letters' ? 'selected' : ''}>Letters</option><option value="number" ${sg.type === 'number' ? 'selected' : ''}>Numbers</option></select>
        <div class="vals">${vals}</div><button class="x" title="Remove segment">×</button>`;
      row.querySelectorAll('[data-k]').forEach((inp) => {
        inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => {
          const key = inp.dataset.k; let v = inp.value;
          if (inp.type === 'number') v = v === '' ? '' : Number(v);
          if (key === 'type' && v !== sg.type) {
            sg.type = v;
            if (v === 'letters') { sg.start = sg.start && isNaN(sg.start) ? sg.start : 'A'; sg.end = sg.end && isNaN(sg.end) ? sg.end : 'C'; }
            if (v === 'number') { sg.start = Number(sg.start) || 1; sg.end = Number(sg.end) || 3; sg.pad = sg.pad ?? 2; }
            renderSegments();
          } else sg[key] = v;
          ctx.save(); afterPatternChange();
        });
      });
      row.querySelector('.x').onclick = () => { S.pattern.segments.splice(k, 1); ctx.save(); renderSegments(); afterPatternChange(); };
      root.appendChild(row);
    });
  }
  const reload = debounce(() => { loadLeaf(); refreshDock(); }, 250);
  function afterPatternChange() {
    const n = total();
    if (S.current > n) S.current = Math.max(1, n);
    const first = idAt(1), last = idAt(n);
    $('patSummary').textContent = n ? `${n} IDs · ${first} … ${last}` : 'Add a segment.';
    renderCurrent();
    reload();
  }
  $('segAdd').onclick = () => { S.pattern.segments.push({ name: `Part${S.pattern.segments.length + 1}`, type: 'number', start: 1, end: 9, pad: 0 }); ctx.save(); renderSegments(); afterPatternChange(); };
  $('patSep').value = S.pattern.separator ?? '-';
  $('patSep').addEventListener('input', () => { S.pattern.separator = $('patSep').value; ctx.save(); afterPatternChange(); });

  // ---------------------------------------------------------------- current leaf
  function renderCurrent() {
    const id = currentId(), n = total();
    $('curId').textContent = id || '—';
    $('curPos').textContent = n ? `${S.current} of ${n}` : '';
    $('leafTitle').textContent = id;
    $('patternTip').dataset.tip = `Each leaf saves as <ID>_ta / _tp / _tl (top, adaxial) and <ID>_ba / _bp / _bl (bottom, abaxial) in ${outRoot()}/${folder()}/scans/; previews/ and retakes/ are beside it`;
    const hot = S.options.hotkeys === true;                    // key hints only while the hot keys are on (Settings)
    $('idPrev').dataset.tip = `Previous leaf${hot ? ' (←)' : ''}`; $('idNext').dataset.tip = `Next leaf${hot ? ' (→)' : ''}`;
    $('btnPrimary').dataset.tip = hot ? 'Space · T / B scan a side · ← → change leaf' : '';
    if (S.current !== progFor) { progFor = S.current; progTab = null; }      // a new leaf: the grid shows its letter again
    renderProgress();
    $('idPrev').disabled = !!scanning || S.current <= 1;
    $('idNext').disabled = !!scanning || S.current >= n;
  }
  // ---------------------------------------------------------------- progress grid
  // Below the pattern: a tab per value of the first Letters segment, a box per leaf of that letter labeled with its
  // first Numbers segment. Empty = not scanned, checkered = one side saved, full = both. Click a box to go to that leaf.
  let progTab = null, progFor = null, progStatus = {}, progKey = null, progModel = null;
  function progressModel() {
    const key = JSON.stringify(S.pattern);
    if (key === progKey) return progModel;
    progKey = key; progModel = null;
    const segs = (S.pattern.segments || []).filter(Boolean), n = total();
    const li = segs.findIndex((s) => s.type === 'letters'), ni = segs.findIndex((s) => s.type === 'number');
    if (!n || n > 6000 || ni < 0) return null;                  // needs a Numbers segment; huge patterns get no grid
    const name = (k) => segs[k].name || `s${k + 1}`;
    const all = patternSeries({ ...S.pattern, from: 1, to: n }).values;
    const tabs = li >= 0 ? segmentValues(segs[li]) : [''];
    progModel = { tabs, tabOf: (v) => (li >= 0 ? v.fields[name(li)] : ''), label: (v) => String(Number(v.fields[name(ni)])), all };
    return progModel;
  }
  function renderProgress() {
    const m = progressModel();
    $('prog').classList.toggle('hidden', !m);
    if (!m) return;
    const cur = m.all[S.current - 1], st = (v) => Math.min(2, (progStatus[v.text]?.s || '').length);
    const warnOf = (v) => progStatus[v.text]?.warn || '';       // a side's label QR code was not read or is another leaf's: the box turns warn orange
    const tab = progTab != null && m.tabs.includes(progTab) ? progTab : cur ? m.tabOf(cur) : m.tabs[0];
    const doneIn = (t) => m.all.filter((v) => m.tabOf(v) === t && st(v) === 2).length;
    const cells = m.all.filter((v) => m.tabOf(v) === tab);
    const done = cells.filter((v) => st(v) === 2).length, half = cells.filter((v) => st(v) === 1).length;
    $('progTabs').classList.toggle('hidden', m.tabs.length === 1 && m.tabs[0] === '');      // no Letters segment: one untabbed grid
    $('progTabs').innerHTML = m.tabs.map((t) => `<button class="${t === tab ? 'active' : ''}" data-t="${esc(t)}" data-tip="${esc(`${doneIn(t)} leaves of ${t} done`)}">${esc(t)}<small>${doneIn(t)}</small></button>`).join('');
    const warned = cells.filter((v) => st(v) && warnOf(v)).length;
    $('progCount').innerHTML = `<b>${done}</b> of ${cells.length} done${half ? ` · <b>${half}</b> half` : ''}${warned ? ` · <b class="warn">${warned}</b> QR` : ''}`;
    $('progGrid').innerHTML = cells.map((v) => {
      const s = st(v), sides = progStatus[v.text]?.s || '', warn = s ? warnOf(v) : '';
      const what = s === 2 ? 'both sides' : s === 1 ? `${sides === 't' ? 'top' : 'bottom'} only` : 'not scanned';
      return `<button class="cell ${s === 2 ? 'done' : s === 1 ? 'half' : ''} ${warn ? 'warn' : ''} ${cur && v.n === cur.n ? 'cur' : ''}" data-n="${v.n}" data-tip="${esc(`${v.text} · ${what}${warn ? ` · ${warn}` : ''}`)}"><span>${esc(m.label(v))}</span></button>`;
    }).join('');
    $('progTabs').querySelectorAll('button').forEach((b) => { b.onclick = () => { progTab = b.dataset.t; renderProgress(); }; });
    $('progGrid').querySelectorAll('.cell').forEach((c) => {
      c.onclick = () => {
        if (scanning) return;
        const n = Number(c.dataset.n);
        if (n === S.current) return;
        S.current = n; progFor = n; ctx.save(); renderCurrent(); loadLeaf(); markDock();      // the tab stays where it is: the leaf is in it
      };
    });
  }
  async function refreshProgress() {
    try { progStatus = await api.leafStatus(folder()); } catch (e) { console.error('progress', cleanError(e)); }
    renderProgress();
  }

  function go(delta) {
    if (scanning) return;
    const n = total();
    const next = Math.min(Math.max(1, S.current + delta), Math.max(1, n));
    if (next === S.current) return;
    S.current = next; ctx.save(); renderCurrent(); loadLeaf(); markDock();
  }
  function jump() {
    if (scanning) return;
    const n = indexOfId($('idJump').value);
    if (!n) { toast(`Not in the pattern: ${$('idJump').value}`, true); return; }
    S.current = n; $('idJump').value = ''; ctx.save(); renderCurrent(); loadLeaf(); markDock();
  }
  $('idPrev').onclick = () => go(-1);
  $('idNext').onclick = () => go(1);
  $('idGo').onclick = jump;
  $('idJump').addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); });

  async function loadLeaf() {
    const id = currentId();
    const req = ++leafReq;
    if (!id || !SAFE_ID.test(id)) { leaf = { id, invalid: true, t: null, b: null }; renderLeaf(); return; }
    // Moving to another leaf deletes the previous leaf's ReSeg sources (lossless plant crops); this leaf's stay.
    const where = `${ctx.mock() ? 'mock' : 'real'}|${folder()}|${id}`;
    if (where !== keptLeaf) { keptLeaf = where; api.resegKeep(folder(), id).catch((e) => console.error('reseg sources', cleanError(e))); }
    try {
      const l = await api.leaf(folder(), id);
      if (req === leafReq) { leaf = l; renderLeaf(); }
    } catch (e) { if (req === leafReq) { leaf = { id, t: null, b: null, error: cleanError(e) }; renderLeaf(); } }
  }

  // ---------------------------------------------------------------- the two sides
  const nextSide = () => (leaf.invalid ? null : !leaf.t ? 't' : !leaf.b ? 'b' : null);

  // Background saving progress per side ("<id>_<side>" → percent), shown on the side's status pill.
  const savePct = new Map();
  const saveLabel = (id, side) => { const p = savePct.get(`${id}_${side}`); return p == null ? 'saving…' : `saving ${p}%`; };

  function renderLeaf() {
    const ns = nextSide();
    for (const sd of SIDES) {
      const info = leaf[sd.key];
      const el = $(`side-${sd.key}`);
      const isActive = scanning?.side === sd.key && !scanning.homing;   // once the file is in, show it while the head drives home
      el.classList.toggle('next', !scanning && ns === sd.key);
      el.classList.toggle('active', isActive);
      // The two panels are independent: while this side is being scanned its live glass view stays as it is (nothing about
      // it changes until its file is in), so the other side can refresh as its save progresses without disturbing it.
      if (isActive && el.querySelector('[data-bed]')) continue;
      // While scanning: the live glass view. Afterwards: the real scan's thumbnail, with red bars on any rows where
      // the color-fringing check found the head stuttering. (Older sides saved the prescan as their preview.)
      const q = S.options.fringeCheck ? info?.quality : null;          // the fringing check is optional (Settings)
      const bars = (q?.ranges || []).filter(() => q.verdict !== 'ok')
        .map((r) => `<div class="fringe ${q.verdict}" style="top:${r.from * 100}%;height:${Math.max(0.6, (r.to - r.from) * 100)}%" data-tip="Color fringing ${r.mm[0]}–${r.mm[1]} mm from the top of the scan"></div>`).join('');
      const legacy = info?.preview && info.capture && !info.previewBBox;
      const pv = shown(info);                          // thumbnail of the product picked in the Leaf card's switch
      const whole = pv === info?.preview;              // the plant crop and the leaf have the plant box's shape
      const onGlass = !!pv && (pv === info?.previewBBoxAll || pv === info?.previewBBox);      // Boxes / Boxes U: the prescan of the whole glass
      const aspect = onGlass ? BED.w / BED.h : info?.width ? (whole || !info.plantSize ? info.width / info.height : info.plantSize.w / info.plantSize.h) : 0;
      const thumb = isActive ? '<div class="bed" data-bed></div>'
        : legacy ? `<div class="bed" data-static data-aspect="${BED.w / BED.h}"><img class="bed-img" src="${imgUrl(info.preview, ver(info))}" alt="${esc(info.name)}" data-act="zoom"><div class="cap" style="${boxStyle(info.capture)}"></div></div>`
        : info?.preview && info.width ? `<div class="bed shot" data-static data-aspect="${aspect}"><img class="bed-img" src="${imgUrl(pv, ver(info))}" alt="${esc(info.name)}" data-act="zoom">${whole ? bars : ''}</div>`
        : info?.preview ? `<img src="${imgUrl(pv, ver(info))}" alt="${esc(info.name)}" data-act="zoom">`
        : `<div class="empty">${info ? 'No preview' : 'Not scanned'}</div>`;
      const files = info?.files?.map((f) => `${FORMAT_LABELS[f.format] || f.format} ${fmtBytes(f.bytes)}`).join(' · ');
      const meta = info ? [info.dpi && `${info.dpi} dpi`, info.bits && `${info.bits}-bit`, info.pending ? '' : files, info.seconds != null && fmtSecs(info.seconds),
        info.retakes && `${info.retakes} retake${info.retakes === 1 ? '' : 's'}`].filter(Boolean).join(' · ') : '';
      const fringe = q?.verdict === 'bad' ? `<span class="status bad" data-tip="${esc(`Color fringing: the scan head stuttered (${q.badBands} bad row bands, worst ${q.worstUm} µm). Retake (${sd.key.toUpperCase()}).`)}">fringing</span>`
        : q?.verdict === 'warn' ? `<span class="status warn" data-tip="${esc(`A little color fringing (${q.badBands} row bands, worst ${q.worstUm} µm)`)}">check</span>` : '';
      const state = !info ? '' : fringe + (info.pending ? ` <span class="status busy" data-savepct="${sd.key}" data-tip="Saving in the background; you can keep scanning">${saveLabel(leaf.id, sd.key)}</span>`
        : info.note ? ` <span class="status warn" data-tip="${esc(info.note)}">TIFF kept</span>` : fringe ? '' : '<span class="status ok">saved</span>');
      const names = info?.files ? [...info.files.map((f) => f.name), baseName(info.plant), baseName(info.segmented)].filter(Boolean).join('\n') : `${leaf.id || ''}_${sd.key}`;
      el.innerHTML = `
        <div class="side-head"><strong>${sd.name}</strong><span class="hint">${sd.face}</span><span class="suffix" data-tip="${esc(names)}">_${sd.key}${pv && pv === info?.previewBBoxAll ? '_previewbboxall' : pv && pv === info?.previewBBox ? '_previewbbox' : boxView() ? 'a' : { a: 'a', p: 'p', s: 'l' }[view()]}</span>
          <span class="spacer"></span>${state}${qrMark(sd, info)}</div>
        <div class="thumb">${thumb}</div>
        <div class="meta"${info?.retakes ? ' data-tip="Earlier takes are kept in retakes/"' : ''}>${esc(meta)}</div>
        <div class="acts">
          <button data-act="scan" class="small" data-tip="${S.options.hotkeys === true ? sd.key.toUpperCase() : ''}" ${scanning || leaf.invalid || ctx.busy.calib ? 'disabled' : ''}>${info ? 'Retake' : 'Scan'}</button>
          ${info && !info.pending && info.plant && ctx.segmenterReady ? `<button data-act="reseg" class="small" data-tip="Segment the leaf again at another confidence (no new scan)" ${resegBusy.has(`${leaf.id}_${sd.key}`) ? 'disabled' : ''}>${resegBusy.has(`${leaf.id}_${sd.key}`) ? 'ReSeg…' : 'ReSeg'}</button>` : ''}
          ${info && !info.pending ? `<button data-act="open" class="small" data-tip="${esc(`Open ${info.name}`)}">Open</button><button data-act="reveal" class="small">Finder</button>` : ''}
        </div>`;
      el.querySelector('[data-act="scan"]').onclick = () => doScan(sd.key);
      const rs = el.querySelector('[data-act="reseg"]');
      if (rs) rs.onclick = () => askReseg(sd.key, info);
      if (info && !info.pending) {
        el.querySelector('[data-act="open"]').onclick = () => api.openPath(info.file).catch((e) => toast(cleanError(e), true));
        el.querySelector('[data-act="reveal"]').onclick = () => api.revealPath(info.file).catch((e) => toast(cleanError(e), true));
      }
      const img = el.querySelector('[data-act="zoom"]');
      // Viewer: ← → top/bottom; ↓ the prescan with the capture box (Auto)
      if (img) img.onclick = () => {
        const items = [];
        SIDES.forEach((x, c) => {
          const s = leaf[x.key];
          if (!s?.preview) return;
          const prod = {
            a: { src: imgUrl(s.preview, ver(s)), title: s.name, caption: `${x.face} · archival (whole scan)`, tiff: s.pending ? null : s.file, c },
            p: s.previewPlant && { src: imgUrl(s.previewPlant, ver(s)), title: baseName(s.plant) || s.name, caption: `${x.face} · plant`, tiff: s.pending ? null : s.plant, c },
            s: s.previewSeg && { src: imgUrl(s.previewSeg, ver(s)), title: baseName(s.segmented) || s.name, caption: `${x.face} · leaf`, tiff: s.pending ? null : s.segmented, c },
          };
          const all = s.previewBBoxAll && { src: imgUrl(s.previewBBoxAll, ver(s)), title: s.name, caption: `${x.face} · prescan, every detection before the unions (dashed = class not ticked)`, tiff: s.pending ? null : s.file, c };
          const uni = s.previewBBox && { src: imgUrl(s.previewBBox, ver(s)), title: s.name, caption: `${x.face} · prescan and capture area`, tiff: s.pending ? null : s.file, c };
          const v = view();
          // ↓ steps through the column: the picked view first, then the other products, then the prescans (a prescan view: prescans first)
          const col = (v === 'x' ? [all, uni, prod.a, prod.p, prod.s] : v === 'u' ? [uni, all, prod.a, prod.p, prod.s]
            : [prod[v], ...['s', 'p', 'a'].filter((k) => k !== v).map((k) => prod[k]), uni, all]).filter(Boolean);
          col.forEach((it, r) => items.push({ ...it, r, key: r === 0 ? x.key : undefined }));
        });
        ctx.openLightbox(items, Math.max(0, items.findIndex((it) => it.key === sd.key)));
      };
    }
    // Red window while this leaf has a side that failed the fringing check (retake it); deep gold for a warning.
    const verdicts = S.options.fringeCheck ? SIDES.map((x) => leaf[x.key]?.quality?.verdict) : [];
    document.body.classList.toggle('alarm', !scanning && verdicts.includes('bad'));
    document.body.classList.toggle('caution', !scanning && !verdicts.includes('bad') && verdicts.includes('warn'));
    const done = (leaf.t ? 1 : 0) + (leaf.b ? 1 : 0);
    $('leafState').textContent = leaf.invalid ? 'ID not usable as a file name' : leaf.error ? leaf.error : '';
    renderPrimary();
    renderCurrent();
    document.querySelectorAll('.bed[data-static]').forEach(fitBed);
    if (scanning) { const bed = document.querySelector('[data-bed]'); if (bed && !bed.querySelector('.edge')) buildBed(); }   // only a fresh live view; an existing one keeps its image
  }

  // Each side's QR mark, right of its status pill: the code that was laid onto that side's archival image (<ID>_t / <ID>_b),
  // drawn small from its real modules, in green. A gray QR-ish placeholder while nothing is known yet (pulsing while the
  // side is being scanned or saved); an orange crossed box for every problem (not read, another leaf's label, not added).
  const qrMatrices = new Map();         // text → { n, rows } | 'loading' | null (could not be made)
  const QR_GHOST = '<svg viewBox="0 0 21 21" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M0 0h7v7h-7zM1 1v5h5v-5zM2 2h3v3h-3z M14 0h7v7h-7zM15 1v5h5v-5zM16 2h3v3h-3z M0 14h7v7h-7zM1 15v5h5v-5zM2 16h3v3h-3z M9 9h3v3h-3z M14 14h2v2h-2z M18 18h3v3h-3z"/></svg>';
  const QR_CROSS = '<svg viewBox="0 0 21 21" aria-hidden="true"><path d="M1.5 1.5h18v18h-18z M5 5l11 11 M16 5L5 16" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  function tinyQR(value) {
    const m = qrMatrices.get(value);
    if (m === undefined) {
      qrMatrices.set(value, 'loading');
      api.qrMatrix(value).then((r) => qrMatrices.set(value, r), () => qrMatrices.set(value, null)).then(() => renderLeaf());
    }
    if (!m || m === 'loading') return QR_GHOST;
    let d = '';
    m.rows.forEach((row, y) => { for (let x = 0; x < m.n; x++) { if (row[x] !== '1') continue; let e = x; while (e + 1 < m.n && row[e + 1] === '1') e++; d += `M${x} ${y}h${e - x + 1}v1h-${e - x + 1}z`; x = e; } });
    return `<svg viewBox="0 0 ${m.n} ${m.n}" shape-rendering="crispEdges" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
  }
  function qrMark(sd, info) {
    const mark = (cls, tip, svg) => `<span class="qr-mini ${cls}" data-tip="${esc(tip)}">${svg}</span>`;
    const live = scanning?.side === sd.key && !scanning.homing;            // being scanned right now: whatever an earlier take had no longer counts
    const q = live ? null : info?.qr, busy = live || !!info?.pending;
    if (q && !q.match) return mark('warn', q.value == null ? `The label's QR code was not read${q.note ? ` (${q.note})` : ''}. Nothing was added to the archival image.`
      : `The label's QR code says ${q.value}, not ${leaf.id}: wrong label or wrong leaf ID. Nothing was added to the archival image.`, QR_CROSS);
    if (q && q.code) return mark('ok', `${q.code}: the label's QR code is this leaf's ID, and this code is on the archival image`, tinyQR(q.code));
    if (busy) return mark('wait busy', live ? 'Scanning: no QR code yet' : 'Saving: the QR code is not ready yet', QR_GHOST);
    if (q) return mark('warn', `The label's QR code is this leaf's ID, but the clean code was not added to the archival image${q.note ? ` (${q.note})` : ''}`, QR_CROSS);
    return mark('wait', info ? 'No QR check was made for this side (saved before the check existed, or the reader is not available)' : 'No QR code yet: this side has not been scanned', QR_GHOST);
  }

  // ---------------------------------------------------------------- ReSeg: the leaf segmented again, no new scan
  const resegBusy = new Set();          // "<id>_<side>" being re-segmented
  let resegFor = null;
  function askReseg(side, info) {
    resegFor = { id: leaf.id, side, folder: folder() };
    const def = ctx.segDefaults.maskScore;
    $('resegName').textContent = `${leaf.id}_${side}l`;
    $('resegConf').value = def;
    $('resegPetiole').checked = S.profile.segPetiole === true;
    $('resegHint').textContent = `Default ${def}${info.maskScore != null && info.maskScore !== def ? ` · now ${info.maskScore}` : ''} · lower keeps more`;
    $('resegHint').dataset.tip = info.resegSource ? 'Made from the scanned pixels, like the first save: no quality loss.' : 'The scanned pixels of this side are gone (they are kept only while its leaf is the current one). The saved plant crop is re-encoded: a slight extra loss, once.';
    $('resegSrc').textContent = info.resegSource ? 'from the scanned pixels' : 'from the saved crop (re-encoded)';
    $('resegSrc').className = info.resegSource ? 'status ok' : 'status warn';
    $('reseg').classList.remove('hidden');
    $('resegConf').focus(); $('resegConf').select();
  }
  const closeReseg = () => { $('reseg').classList.add('hidden'); resegFor = null; };
  $('resegCancel').onclick = closeReseg;
  $('reseg').addEventListener('mousedown', (e) => { if (e.target === $('reseg')) closeReseg(); });
  $('resegConf').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('resegGo').click(); });
  $('resegGo').onclick = async () => {
    const q = resegFor, conf = Number($('resegConf').value), petiole = $('resegPetiole').checked;
    if (!q) return;
    if (!(conf >= 0.01 && conf <= 0.95)) { toast('Confidence must be between 0.01 and 0.95.', true); return; }
    closeReseg();
    const key = `${q.id}_${q.side}`, pct = (f) => (f == null ? '?' : `${(f * 100).toFixed(1)}%`);
    resegBusy.add(key); renderLeaf();
    try {
      const r = await api.reseg({ folder: q.folder, id: q.id, side: q.side, maskScore: conf, petiole });
      toast(`${key}l re-segmented at ${conf}${petiole ? ', with petiole' : ''}${r.fromScan ? '' : ' (from the saved crop)'}: kept ${pct(r.keptFraction)} of the crop (was ${pct(r.previousKeptFraction)})`);
    } catch (e) { toast(cleanError(e), true, 10000); }
    finally { resegBusy.delete(key); if (q.id === leaf.id) await loadLeaf(); refreshDock(); }
  };

  /** A saved side that failed the fringing check: the next step is retaking it (▶ still moves on). */
  const badSide = () => (leaf.invalid || !S.options.fringeCheck ? null : SIDES.map((x) => x.key).find((k) => leaf[k]?.quality?.verdict === 'bad') || null);

  const topDoneAt = new Map();          // leaf ID → when its top scan finished
  let flipSince = null;
  function paintFlipClock() {
    if (flipSince == null) return;
    const s = Math.max(0, Math.floor((Date.now() - flipSince) / 1000));
    const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;      // minutes:seconds only; minutes keep counting past 59
    if ($('flipClock').textContent !== text) $('flipClock').textContent = text;
  }
  setInterval(paintFlipClock, 250);
  function renderPrimary() {
    const b = $('btnPrimary');
    const ns = nextSide(), bad = badSide();
    // Flip reminder (optional): the top is scanned, the bottom is next and nothing is scanning. A ghost: it never takes clicks.
    // Only between the top and the bottom: the top exists, the bottom does not (a bottom that is still saving counts as done).
    const flip = !!(S.options.flipReminder && leaf.t && !leaf.b && ns === 'b' && !bad && !scanning && !ctx.busy.calib);
    // Its clock counts from when the top scan finished (this session), else from when the top's file was saved.
    flipSince = flip ? (topDoneAt.get(leaf.id) ?? (leaf.t.pending ? Date.now() : leaf.t.mtime)) : null;
    if (flip && !topDoneAt.has(leaf.id)) topDoneAt.set(leaf.id, flipSince);
    $('flipGhost').classList.toggle('hidden', !flip);
    paintFlipClock();
    const nextId = idAt(S.current + 1);
    // Both sides done: the button rests (redos go through each side's Retake; ▶ or → moves to the next leaf).
    const rest = !scanning && !leaf.invalid && !ctx.busy.calib && !bad && !ns;
    b.disabled = !!scanning || leaf.invalid || ctx.busy.calib || rest;
    const row = $('primaryRow');
    row.classList.toggle('resting', rest); row.classList.toggle('scanning', !!scanning); row.classList.toggle('off', b.disabled && !rest && !scanning);
    b.classList.toggle('resting', rest);
    b.setAttribute('aria-label', $('primaryLabel').textContent = scanning?.homing ? 'Scan head returning home…' : scanning ? `Scanning ${scanning.side === 't' ? 'top' : 'bottom'}…`
      : leaf.invalid ? 'Fix the leaf ID'
      : ctx.busy.calib ? 'Calibrating…'
      : bad ? `Retake ${bad === 't' ? 'top' : 'bottom'} (color fringing)`
      : ns === 't' ? 'Scan TOP'
      : ns === 'b' ? 'Scan BOTTOM'
      : nextId ? 'Ready for next specimen...' : 'End of pattern');
  }
  $('btnPrimary').onclick = primary;
  function primary() {
    if (scanning || leaf.invalid) return;
    const bad = badSide(), ns = nextSide();
    if (bad) doScan(bad); else if (ns) doScan(ns);      // both sides done: nothing (▶ / → for the next leaf)
  }

  // ---------------------------------------------------------------- scanning
  // A scan runs in phases. Auto area: prescan (150 dpi, whole glass) → detect → scan of the capture box.
  // Other areas: just the scan. The active side shows the glass (or the area), the prescan once there is
  // one, the plant and archival unions, the scan area (blue) and the scan head (teal) at the real
  // leading edge, which moves only inside the capture box.
  /**
   * What the previews show. Products: 'a' archival (whole scan), 'p' plant crop, 's' leaf (segmented plant crop).
   * Prescan views (Leaf card only): 'x' Boxes = every detection on its own, 'u' Boxes U = the unions and the scan area.
   */
  function view() { return ['x', 'u', 'a', 'p', 's'].includes(S.options.view) ? S.options.view : S.options.showSegmented ? 's' : 'a'; }
  const boxView = () => view() === 'x' || view() === 'u';
  /** Which thumbnail a side shows: the picked view's, or the nearest one that exists. `products` = never a prescan view (the Scanned strip). */
  function shown(info, products = false) {
    const v = view();
    if (v === 'x' && !products) return info?.previewBBoxAll || info?.previewBBox || info?.preview;
    if (v === 'u' && !products) return info?.previewBBox || info?.preview;
    if (v === 'x' || v === 'u') return info?.preview;
    return (v === 's' && info?.previewSeg) || (v !== 'a' && info?.previewPlant) || info?.preview;
  }
  function baseName(f) { return f ? f.split('/').pop() : ''; }
  const ver = (s) => s?.v ?? s?.mtime;             // cache key for a side's previews: changes with any of its products (ReSeg)
  const BED = { w: 8.5, h: 11.7 };                  // glass in inches; prescan and capture boxes are fractions of it
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const boxStyle = (b) => `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;

  /** Expected head speed (% of the area per second) and duration, until the driver's updates refine them. */
  function expected(profile) {
    const e = estimate(profile, ctx.runs);
    return { est: e.seconds, rate: e.seconds && e.seconds > OVERHEAD_S + 1 ? 100 / (e.seconds - OVERHEAD_S) : null };
  }
  function startPhase(phase, info = {}) {
    const s = scanning;
    if (!s || s.phase === phase) return;
    Object.assign(s, { phase, lastPct: 0, lastT: Date.now(), step: null, phaseT0: Date.now() });
    if (phase === 'prescan') {
      Object.assign(s, { est: PRESCAN_SECONDS, rate: 100 / (PRESCAN_SECONDS - OVERHEAD_S) });
      s.view = { aspect: BED.w / BED.h, box: FULL, img: null, boxes: [] };
    } else if (phase === 'detect') {
      s.view = { ...s.view, img: info.preview };
    } else if (info.capture) {                       // Auto: scan the capture box on the prescan (the top's, mirrored, for a bottom side)
      Object.assign(s, expected({ ...S.profile, area: { mode: 'custom', wCm: info.wCm, hCm: info.hCm } }));
      if (phase === 'detected') s.est = null;      // box found while the prescan's head is still returning; the scan starts when it is home
      s.view = { aspect: BED.w / BED.h, box: info.capture, img: info.preview, mirrored: !!info.mirrored, boxes: info.boxes || [] };
    } else {
      Object.assign(s, expected(S.profile));
      const a = areaCm(S.profile.area);
      s.view = { aspect: a.w / a.h, box: FULL, img: null, boxes: [] };
    }
    buildBed();
  }
  function buildBed() {
    const bed = document.querySelector('[data-bed]');
    if (!bed || !scanning?.view) return;
    const v = scanning.view;
    bed.dataset.aspect = v.aspect;
    bed.innerHTML = `${v.img ? `<img class="bed-img${v.mirrored ? ' mirrored' : ''}" src="${imgUrl(v.img, scanning.t0)}" alt="">` : ''}`
      + v.boxes.map((b) => `<div class="det ${b.model || ''}" style="${boxStyle(b)}"></div>`).join('')
      + (v.img && (scanning.phase === 'scan' || scanning.phase === 'detected') ? `<div class="cap" style="${boxStyle(v.box)}"></div>` : '')
      + '<div class="covered"></div><div class="edge"></div><div class="bed-label"></div>';
    fitBed(bed);
  }
  /** Size a .bed to the largest box of its aspect ratio that fits its parent. */
  function fitBed(bed) {
    const r = bed.parentElement.getBoundingClientRect(), a = Number(bed.dataset.aspect) || 1;
    const h = Math.min(r.height, r.width / a);
    bed.style.height = `${Math.floor(h)}px`; bed.style.width = `${Math.floor(h * a)}px`;
  }
  window.addEventListener('resize', () => document.querySelectorAll('.bed').forEach(fitBed));

  async function doScan(side) {
    if (scanning) return;
    if (ctx.busy.calib) { toast('Calibration is using the scanner.', true); return; }
    if (!leaf.id || leaf.invalid) return;
    scanning = { side, t0: Date.now(), phase: null, lastPct: 0, lastT: Date.now(), cancelling: false, view: null };
    ctx.setBusy('scan', true);
    $('scanBar').style.width = '0%'; $('scanStatus').textContent = '';
    $('btnCancelScan').classList.remove('hidden');
    $('btnCancelScan').disabled = false;
    renderLeaf();
    // A bottom side reuses the top's Auto area (mirrored) when it has one: the main process skips the prescan
    // and sends the scan phase right away.
    const mirrored = S.profile.area.mode === 'auto' && side === 'b' && S.profile.auto.mirrorTop !== false && leaf.t?.capture;
    if (!mirrored) startPhase(S.profile.area.mode === 'auto' ? 'prescan' : 'scan');
    updateProgress();
    tick = setInterval(updateProgress, 500);
    requestAnimationFrame(drawEdge);
    try {
      const r = await api.scan({ id: leaf.id, side, folder: folder(), profile: S.profile });
      if (r.cancelled) toast('Cancelled.');
      else {
        const cap = r.prescan?.captureCm;
        toast(`${side === 't' ? 'Top' : 'Bottom'} scanned${cap ? ` (${cap[2].toFixed(1)} × ${cap[3].toFixed(1)} cm${r.prescan?.mirrored ? ', top’s area mirrored' : ''})` : ''} · saving in the background`);
        if (S.options.sound) chime();
        if (side === 't') topDoneAt.set(leaf.id, Date.now()); else topDoneAt.delete(leaf.id);
      }
    } catch (e) {
      toast(cleanError(e), true, 10000);
    } finally {
      clearInterval(tick); scanning = null; closeConfirm();
      ctx.setBusy('scan', false);
      $('btnCancelScan').classList.add('hidden'); $('scanBar').style.width = '0%';
      await loadLeaf(); refreshDock();
    }
  }
  // Where the scan head is, in % of the area being scanned. The driver reports progress in ~14% steps;
  // between steps the edge moves on at the measured head speed, but never past the next step, so it is
  // never ahead of the real head by more than one update. It sits at 0 while the scanner warms up.
  function headPct() {
    const s = scanning;
    if (!s || !s.lastPct || !s.rate) return s?.lastPct || 0;
    const ahead = Math.min(s.rate * ((Date.now() - s.lastT) / 1000), s.step || 14);
    return Math.min(99.5, s.lastPct + ahead);
  }
  function drawEdge() {
    if (!scanning) return;
    const bed = document.querySelector('[data-bed]');
    if (bed && scanning.view) {
      if (!bed.querySelector('.edge')) buildBed();
      fitBed(bed);
      const s = scanning, b = s.view.box, detecting = s.phase === 'detect' || s.phase === 'detected', pct = detecting ? 0 : headPct();
      Object.assign(bed.querySelector('.covered').style, { left: `${b.x * 100}%`, width: `${b.w * 100}%`, top: `${b.y * 100}%`, height: `${b.h * pct}%` });
      Object.assign(bed.querySelector('.edge').style, { left: `calc(${b.x * 100}% - 6px)`, width: `calc(${b.w * 100}% + 12px)`, top: `${(b.y + (b.h * pct) / 100) * 100}%`, display: detecting ? 'none' : '' });
      const what = s.phase === 'prescan' ? 'prescan ' : '';
      bed.querySelector('.bed-label').textContent = s.cancelling ? 'cancelling…' : s.phase === 'detected' ? 'head returning home…' : detecting ? 'finding leaves…'
        : !s.lastPct ? `${what}warming up…` : pct >= 99 ? `${what}finishing…` : `${what}${Math.round(pct)}%`;
      $('scanBar').style.width = `${pct.toFixed(1)}%`;
    }
    requestAnimationFrame(drawEdge);
  }
  function updateProgress() {
    const s = scanning;
    if (!s) return;
    const el = (Date.now() - s.t0) / 1000, inPhase = (Date.now() - (s.phaseT0 || s.t0)) / 1000;
    const left = s.est && s.phase !== 'detect' && s.phase !== 'detected' ? Math.max(0, s.est - inPhase) : null;
    // Short: it sits inside the big button, left of its centered label (which already says what is being scanned).
    const phase = s.phase === 'prescan' ? 'Prescan' : s.phase === 'detect' ? 'Finding leaves' : s.phase === 'detected' ? 'Area found' : s.side === 't' ? 'Top' : 'Bottom';
    $('scanStatus').textContent = s.cancelling ? 'Cancelling…' : s.homing ? `Saving started · ${fmtSecs(el)}` : `${phase} · ${fmtSecs(el)}${left != null ? ` · ~${fmtSecs(left)} left` : ''}`;
  }
  // ---------------------------------------------------------------- prescan confirmation
  // After the prescan (Auto area with its own prescan), the main process sends the detections and waits. The popup shows
  // every detection at or above the slider on the prescan, and the scan area they give; Go scans it at that confidence
  // (this scan only: the slider starts at the Scan settings threshold every time), Rescan Preview runs the prescan again.
  let confirmData = null;
  const inClasses = (p, b) => p.classes[b.model] === 'all' || (p.classes[b.model] || []).includes(b.label);
  function confirmArea(p, thr) {        // as captureArea() in the main process: leaf boxes padded first, then the union, then the padding
    const lp = (p.leafPaddingCm || 0) / 2.54, pad = p.paddingCm / 2.54, leafBox = (b) => b.model === 'plant' && (b.label === 'Leaf_WHOLE' || b.label === 'Leaf_PARTIAL');
    const used = p.dets.filter((b) => b.score >= thr && inClasses(p, b))
      .map((b) => (lp > 0 && leafBox(b) ? { ...b, x1: Math.max(0, b.x1 - lp), y1: Math.max(0, b.y1 - lp), x2: Math.min(p.bed.w, b.x2 + lp), y2: Math.min(p.bed.h, b.y2 + lp) } : b));
    if (!used.length) return null;
    return { x1: Math.max(0, Math.min(...used.map((b) => b.x1)) - pad), y1: Math.max(0, Math.min(...used.map((b) => b.y1)) - pad),
      x2: Math.min(p.bed.w, Math.max(...used.map((b) => b.x2)) + pad), y2: Math.min(p.bed.h, Math.max(...used.map((b) => b.y2)) + pad), n: used.length };
  }
  function renderConfirm() {
    const p = confirmData;
    if (!p) return;
    const thr = Number($('pcThr').value), a = confirmArea(p, thr);
    const at = (b) => `left:${(b.x1 / p.bed.w) * 100}%;top:${(b.y1 / p.bed.h) * 100}%;width:${((b.x2 - b.x1) / p.bed.w) * 100}%;height:${((b.y2 - b.y1) / p.bed.h) * 100}%`;
    const same = Math.abs(thr - p.threshold) < 1e-9;
    $('pcThrOut').textContent = thr.toFixed(2);
    $('pcThrHint').textContent = same ? `The threshold from Scan settings (${p.threshold.toFixed(2)})` : `Scan settings say ${p.threshold.toFixed(2)}; this scan uses ${thr.toFixed(2)}`;
    $('pcThrReset').disabled = same;
    const shown = p.dets.filter((b) => b.score >= thr).sort((x, y) => (y.x2 - y.x1) * (y.y2 - y.y1) - (x.x2 - x.x1) * (x.y2 - x.y1));     // small boxes on top
    $('pcGlass').querySelectorAll('.pc-box, .pc-area').forEach((e) => e.remove());
    $('pcGlass').insertAdjacentHTML('beforeend', shown.map((b) => `<div class="pc-box ${b.model} ${inClasses(p, b) ? '' : 'off'} ${b.y1 / p.bed.h < 0.03 ? 'low' : ''}" style="${at(b)}"><b>${esc(b.label.replace(/_/g, ' '))} ${b.score.toFixed(2)}</b></div>`).join('')
      + `<div class="pc-area" style="${a ? at(a) : 'inset:0'}"></div>`);
    $('pcList').innerHTML = [...p.dets].sort((x, y) => y.score - x.score).map((b) => `<div class="pc-row ${b.model} ${b.score >= thr ? '' : 'out'} ${inClasses(p, b) ? '' : 'off'}"><i></i><span class="nm">${esc(b.label.replace(/_/g, ' '))}</span><span class="sc">${b.score.toFixed(2)}</span></div>`).join('');
    const cm = (v) => (v * 2.54).toFixed(1);
    $('pcSum').innerHTML = a ? `Scan area <b>${cm(a.x2 - a.x1)} × ${cm(a.y2 - a.y1)} cm</b> · ${a.n} box${a.n === 1 ? '' : 'es'} count${shown.length > a.n ? ` · ${shown.length - a.n} shown but not ticked` : ''}`
      : '<span class="warn">Nothing counts at this confidence: Go would scan the whole glass.</span>';
  }
  function closeConfirm() { confirmData = null; $('prescanConfirm').classList.add('hidden'); }
  api.onScanConfirm((p) => {
    if (!p || !scanning) { closeConfirm(); return; }        // null = the scan ended some other way (cancelled, failed)
    confirmData = p;
    $('pcId').textContent = `${p.id} · ${p.side === 't' ? 'top' : 'bottom'}`;
    $('pcImg').src = imgUrl(p.preview, Date.now());
    $('pcThr').value = Math.min(0.95, Math.max(0.05, p.threshold));     // back at the setting every time
    renderConfirm();
    $('prescanConfirm').classList.remove('hidden');
  });
  $('pcThr').oninput = renderConfirm;
  $('pcThrReset').onclick = () => { if (confirmData) { $('pcThr').value = confirmData.threshold; renderConfirm(); } };
  const answerConfirm = (choice) => { if (!confirmData) return; closeConfirm(); api.confirmScan(choice).catch((e) => toast(cleanError(e), true)); };
  $('pcGo').onclick = () => answerConfirm({ action: 'go', threshold: Number($('pcThr').value) });
  $('pcRescan').onclick = () => answerConfirm({ action: 'rescan' });
  $('pcCancel').onclick = () => answerConfirm({ action: 'cancel' });

  api.onQualityUpdated((r) => { if (r.id === leaf.id) loadLeaf(); });
  api.onSaveProgress((r) => {
    savePct.set(`${r.id}_${r.side}`, r.pct);
    if (r.id !== leaf.id) return;
    const pill = document.querySelector(`[data-savepct="${r.side}"]`);
    if (pill) pill.textContent = saveLabel(r.id, r.side);
    if (r.quality?.verdict === 'bad' && S.options.fringeCheck) toast(`Color fringing on the ${r.side === 't' ? 'top' : 'bottom'}: retake with ${r.side.toUpperCase()}.`, true, 12000);
    if (r.preview || r.quality) loadLeaf();           // also during a scan: the other side's panel shows its save as it goes
  });
  api.onScanPhase((p) => {
    if (!scanning) return;
    if (p.phase === 'homing') {                      // file is in and saving has started; the scanner is busy until the head is home
      scanning.homing = true; scanning.phase = 'homing';
      $('scanBar').style.width = '100%';
      updateProgress(); loadLeaf(); refreshProgress();
      return;
    }
    startPhase(p.phase, p);
    if (p.nothingFound && p.phase !== 'detected') toast('Nothing detected above the threshold: scanning the whole glass.', true, 6000);
  });
  api.onScanProgress(({ pct, phase }) => {
    const s = scanning;
    if (!s || (phase && phase !== s.phase) || pct <= s.lastPct) return;
    const now = Date.now();
    if (s.lastPct > 0) { s.rate = (pct - s.lastPct) / ((now - s.lastT) / 1000); s.step = pct - s.lastPct; }
    s.lastPct = pct; s.lastT = now; s.pct = pct;
    updateProgress();
  });
  api.onSaveDone((r) => {
    savePct.delete(`${r.id}_${r.side}`);
    if (!r.ok) toast(`Saving ${r.id}_${r.side} failed: ${r.error}`, true, 10000);
    else if (r.note) toast(`${r.id}_${r.side}: ${r.note}`, true, 10000);
    if (r.id === leaf.id) loadLeaf();
    refreshDock();
  });
  $('btnCancelScan').onclick = async () => {
    if (!scanning) return;
    scanning.cancelling = true; $('btnCancelScan').disabled = true; updateProgress();
    try { await api.cancelScan(); } catch (e) { toast(cleanError(e), true); }
  };

  // ---------------------------------------------------------------- dock: scanned leaves
  // Order of the strip: 'time' = newest first (as always), 'name' = by leaf ID (the switch left of "Scanned").
  let dockReq = 0;
  const dockSort = () => (S.options.dockSort === 'name' ? 'name' : 'time');
  const paintDockSort = () => $('dockSort').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.sort === dockSort()));
  $('dockSort').querySelectorAll('button').forEach((b) => { b.onclick = () => { if (dockSort() === b.dataset.sort) return; S.options.dockSort = b.dataset.sort; ctx.save(); paintDockSort(); refreshDock(); }; });
  paintDockSort();
  async function refreshDock() {
    refreshProgress();                                 // same moments: a scan or a save finished, the folder changed
    let list = [];
    const sort = dockSort(), req = ++dockReq;
    try { list = await api.leaves(folder(), sort); } catch (e) { $('dockStats').textContent = cleanError(e); }
    if (req !== dockReq) return;                       // a newer refresh (e.g. the sort switch) is on its way
    $('dockStats').textContent = `${list.length}${list.length >= (sort === 'name' ? 400 : 80) ? '+' : ''} in ${folder()}/`;
    const strip = $('leafStrip');
    if (!list.length) { strip.innerHTML = ''; return; }
    strip.innerHTML = list.map((l) => `<div class="leaf-chip" data-id="${esc(l.id)}" title="${esc(l.id)}">
      <div class="pair">${['t', 'b'].map((k) => `<div>${l[k]?.preview ? `<img src="${imgUrl(shown(l[k], true), ver(l[k]))}" alt="">` : l[k] ? k : '—'}</div>`).join('')}</div>
      <div class="nm">${esc(l.id)}</div></div>`).join('');
    strip.querySelectorAll('.leaf-chip').forEach((chip) => {
      chip.onclick = () => {
        if (S.tab === 'measure') { ctx.pickLeaf(chip.dataset.id); return; }      // Measure tab: pick the leaf to measure
        if (scanning) return;
        const n = indexOfId(chip.dataset.id);
        if (!n) { toast(`Not in the pattern: ${chip.dataset.id}`, true); return; }
        S.current = n; ctx.save(); renderCurrent(); loadLeaf(); markDock();
      };
    });
    markDock();
  }
  function markDock() {
    const id = S.tab === 'measure' ? ctx.measureId : currentId();
    document.querySelectorAll('.leaf-chip').forEach((c) => c.classList.toggle('cur', c.dataset.id === id));
  }
  $('btnShowScans').onclick = () => api.openFolder('scans');

  // ---------------------------------------------------------------- keys
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea, button')) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') { e.preventDefault(); primary(); }
    else if (k === 't' || k === 'T') { e.preventDefault(); doScan('t'); }
    else if (k === 'b' || k === 'B') { e.preventDefault(); doScan('b'); }
    else if (k === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); go(1); }
  }

  renderSegments();
  afterPatternChange();

  // "Segmented" switch on the Leaf card: previews show the leaf-only version where one exists.
  // The flip reminder's two comets: an arrowhead with a tail that thins and fades behind it, turning clockwise (CSS).
  $('flipGhost').querySelector('svg').innerHTML = [0, 180].map((end) => {
    const R = 84, W = 12, LEN = 150, N = 14, f = (n) => n.toFixed(2);
    const pt = (r, a) => [100 + r * Math.cos(a * Math.PI / 180), 100 + r * Math.sin(a * Math.PI / 180)];
    let s = '';
    for (let i = 0; i < N; i++) {
      const k = (i + 1) / N, [x0, y0] = pt(R, end - LEN + (LEN * i) / N), [x1, y1] = pt(R, end - LEN + (LEN * (i + 1)) / N + 0.6);
      s += `<path d="M${f(x0)} ${f(y0)} A${R} ${R} 0 0 1 ${f(x1)} ${f(y1)}" fill="none" stroke="currentColor" stroke-width="${f(W * (0.25 + 0.75 * k))}" opacity="${f(k * k)}"/>`;
    }
    const hw = W * 1.5, hl = W * 1.85, [ix, iy] = pt(R - hw, end), [ox, oy] = pt(R + hw, end), [ex, ey] = pt(R, end);
    return `${s}<path d="M${f(ix)} ${f(iy)} L${f(ox)} ${f(oy)} L${f(ex - Math.sin(end * Math.PI / 180) * hl)} ${f(ey + Math.cos(end * Math.PI / 180) * hl)} Z" fill="currentColor"/>`;
  }).join('');
  const viewButtons = [...document.querySelectorAll('.prod-seg button')];      // the Leaf card's switch and the Measure tab's
  // The Measure tab's switch has only the products: with a prescan view picked it measures (and marks) the archival image.
  const paintView = () => { viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === (b.closest('#prodSeg') || !boxView() ? view() : 'a'))); };
  viewButtons.forEach((b) => { b.onclick = () => { S.options.view = b.dataset.view; delete S.options.showSegmented; ctx.save(); paintView(); renderLeaf(); refreshDock(); ctx.viewChanged(); }; });
  paintView();

  return {
    onShow() { loadLeaf(); refreshDock(); },
    onProfile() { renderPrimary(); },
    onBusy() { renderLeaf(); },
    onOutput() { renderCurrent(); loadLeaf(); refreshDock(); },
    onKey, folder, currentId, markDock, refreshDock, paintView,
    get scanning() { return !!scanning; },
  };
}

function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }
