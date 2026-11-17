// Measure tab: draw lines and paths on a scanned image and read them in mm / cm.
//
// The image's dpi gives CF, the pixels-per-cm conversion factor (dpi / 2.54). Points live in pixels of the
// full-resolution product image (archival, plant or leaf), whatever is on screen: first the preview, then a sharper
// measuring image the main process makes on demand. "Record" writes everything measured on a specimen (both
// sides, every product) plus its notes to <folder>/<ID>.json.
import { api, cleanError, imgUrl } from './api.js';
import { $, esc, toast } from './util.js';

const COLORS = ['#fbbf24', '#52a4ff', '#f87171', '#4ade80', '#c084fc', '#fb923c', '#2ec4b6', '#e8eaf0'];
const SIDES = [['t', 'Top', 'adaxial'], ['b', 'Bottom', 'abaxial']];
const LETTER = { a: 'a', p: 'p', s: 'l' };                         // view → file suffix letter
const VIEW_NAME = { a: 'archival', p: 'plant', s: 'leaf' };
const baseName = (f) => (f ? f.split('/').pop() : '');
const fmt = (n, d) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const lengthPx = (pts) => pts.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0);

export function initMeasure(ctx, hooks) {
  const S = ctx.S;
  S.measure = { id: null, side: 't', tool: 'line', ...(S.measure || {}) };
  const stage = $('mStage'), world = $('mWorld'), svg = $('mSvg'), image = $('mImg');
  const specimens = new Map();        // leaf ID → { notes, list, dirty, file } (kept while the app runs, so nothing drawn is lost by switching leaf)
  let leaf = null;                    // api.leaf() of the selected specimen
  let img = null;                     // { name, width, height, dpi, pxPerCm } of the image on screen
  let imgReq = 0, leafReq = 0;
  let view = { s: 1, tx: 0, ty: 0, fitted: true };
  let draft = null, hover = null, drag = null, pan = null, selected = null, spaceDown = false, lastClick = null;

  const prod = () => (['a', 'p', 's'].includes(S.options.view) ? S.options.view : 'a');
  const spec = () => specimens.get(S.measure.id) || null;
  const here = (m) => img && m.image === img.name;                 // drawn on the image on screen
  const mm = (px, cf = img?.pxPerCm) => (cf ? (px / cf) * 10 : null);
  const valueText = (px, cf) => { const v = mm(px, cf); return v == null ? `${fmt(px, 0)} px` : `${fmt(v, 2)} mm`; };

  // ---------------------------------------------------------------- leaf, side, image
  async function refreshLeaves() {
    let list = [];
    try { list = await api.leaves(hooks.folder()); } catch (e) { toast(cleanError(e), true); }
    const ids = list.map((l) => l.id);
    if (!ids.includes(S.measure.id)) S.measure.id = ids.includes(hooks.currentId()) ? hooks.currentId() : ids[0] || null;
    $('mLeaf').innerHTML = ids.length ? ids.map((id) => `<option value="${esc(id)}"${id === S.measure.id ? ' selected' : ''}>${esc(id)}</option>`).join('') : '<option value="">No scans yet</option>';
    $('mLeaf').disabled = !ids.length;
    await selectLeaf(S.measure.id);
  }

  async function selectLeaf(id) {
    const req = ++leafReq;
    S.measure.id = id || null; ctx.save();
    if ($('mLeaf').value !== (id || '')) $('mLeaf').value = id || '';
    hooks.markDock();
    draft = null; selected = null; leaf = null;
    if (!id) { showImage(); renderList(); return; }
    try {
      const [l, stored] = await Promise.all([api.leaf(hooks.folder(), id), specimens.has(id) ? null : api.measure.load(hooks.folder(), id)]);
      if (req !== leafReq) return;
      leaf = l;
      if (!specimens.has(id)) {
        specimens.set(id, { notes: stored?.notes || '', file: stored?.file || null, dirty: false,
          list: (stored?.measurements || []).map((m) => ({ id: m.id, label: m.label || '', side: m.side, view: m.view, image: m.image, points: m.points, cf: m.CF, recordedAt: m.recordedAt, imageSha256: m.imageSha256, saved: true })) });
      }
    } catch (e) { if (req === leafReq) toast(cleanError(e), true); return; }
    if (!leaf[S.measure.side] && leaf[S.measure.side === 't' ? 'b' : 't']) S.measure.side = S.measure.side === 't' ? 'b' : 't';
    $('mNotes').value = spec().notes;
    renderSides(); showImage(); renderList();
  }

  function renderSides() {
    $('mSide').innerHTML = SIDES.map(([k, name, face]) => `<button data-side="${k}" class="${S.measure.side === k ? 'active' : ''}" ${leaf?.[k] ? '' : 'disabled'} data-tip="${face}">${name}</button>`).join('');
    $('mSide').querySelectorAll('button').forEach((b) => { b.onclick = () => { S.measure.side = b.dataset.side; ctx.save(); draft = null; renderSides(); showImage(); renderList(); }; });
  }

  /** Put the selected leaf / side / product on the stage: the preview at once, the sharper measuring image when it is ready. */
  async function showImage() {
    const req = ++imgReq, v = prod(), side = S.measure.side, info = leaf?.[side];
    const file = info && !info.pending ? (v === 'a' ? info.file : v === 'p' ? info.plant : info.segmented) : null;
    const preview = info && (v === 'a' ? info.preview : v === 'p' ? info.previewPlant : info.previewSeg);
    const size = info && (v === 'a' ? (info.width ? { w: info.width, h: info.height } : null) : info.plantSize);
    $('mSuffix').textContent = S.measure.id ? `_${side}${LETTER[v]}` : '';
    img = null; draft = null;
    const empty = (text) => { world.classList.add('hidden'); $('mEmpty').textContent = text; $('mEmpty').classList.remove('hidden'); $('mCF').textContent = ''; render(); };
    if (!S.measure.id) return empty('Scan a leaf first, then measure it here.');
    if (!info) return empty(`The ${side === 't' ? 'top' : 'bottom'} of ${S.measure.id} is not scanned.`);
    if (info.pending) return empty('Still saving… it will appear here when the save finishes.');
    if (!file) return empty(`No ${VIEW_NAME[v]} image for this side. Pick another view above.`);
    $('mEmpty').classList.add('hidden');
    const pxPerCm = info.dpi ? info.dpi / 2.54 : null;
    if (size && preview) { img = { name: baseName(file), width: size.w, height: size.h, dpi: info.dpi, pxPerCm }; image.src = imgUrl(preview, info.mtime); layout(true); }
    $('mBusy').classList.remove('hidden');
    try {
      const r = await api.measure.image({ folder: hooks.folder(), id: S.measure.id, side, product: v });
      if (req !== imgReq) return;
      if (!r) return empty(`No ${VIEW_NAME[v]} image for this side.`);
      const first = !img;
      img = { name: r.name, width: r.width, height: r.height, dpi: r.dpi, pxPerCm: r.pxPerCm };
      image.src = imgUrl(r.proxy, r.mtime);
      layout(first || view.fitted);
    } catch (e) { if (req === imgReq) toast(cleanError(e), true, 8000); }
    finally { if (req === imgReq) $('mBusy').classList.add('hidden'); }
  }

  function layout(fit) {
    world.classList.remove('hidden');
    world.style.width = `${img.width}px`; world.style.height = `${img.height}px`;
    svg.setAttribute('viewBox', `0 0 ${img.width} ${img.height}`);
    $('mCF').innerHTML = img.pxPerCm ? `<b>${img.dpi} dpi</b> · CF ${fmt(img.pxPerCm, 2)} px/cm · ${img.width.toLocaleString()} × ${img.height.toLocaleString()} px` : `dpi unknown: lengths in pixels · ${img.width} × ${img.height} px`;
    if (fit) fitView(); else applyView();
    renderList();
  }

  // ---------------------------------------------------------------- view: fit, zoom, pan
  function fitView() {
    if (!img) return;
    const r = stage.getBoundingClientRect();
    const s = Math.min(r.width / img.width, r.height / img.height) * 0.96;
    view = { s, tx: (r.width - img.width * s) / 2, ty: (r.height - img.height * s) / 2, fitted: true };
    applyView();
  }
  function zoomAt(factor, cx, cy) {
    if (!img) return;
    const r = stage.getBoundingClientRect();
    const min = Math.min(r.width / img.width, r.height / img.height) * 0.5, s = Math.min(Math.max(view.s * factor, min), 12);
    view = { s, tx: cx - ((cx - view.tx) * s) / view.s, ty: cy - ((cy - view.ty) * s) / view.s, fitted: false };
    applyView();
  }
  function applyView() {
    world.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
    $('mZoom').textContent = `${Math.round(view.s * 100)}%`;
    render();
  }
  const toImage = (e) => {
    const r = stage.getBoundingClientRect();
    return [Math.min(Math.max((e.clientX - r.left - view.tx) / view.s, 0), img.width), Math.min(Math.max((e.clientY - r.top - view.ty) / view.s, 0), img.height)];
  };

  // ---------------------------------------------------------------- drawing
  /** Lines, handles and labels, in image pixels; sizes are divided by the zoom so they stay the same on screen. */
  function render() {
    if (!img) { svg.innerHTML = ''; renderReadout(); return; }
    const k = 1 / view.s, list = spec()?.list || [];
    const line = (pts, color, cls = '') => `<polyline class="${cls}" points="${pts.map((q) => q.join(',')).join(' ')}" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="${4.5 * k}" stroke-linejoin="round"/>`
      + `<polyline class="${cls}" points="${pts.map((q) => q.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${2 * k}" stroke-linejoin="round"/>`;
    // End points: a hollow circle with 1 px crosshairs that stop short of the center, so the exact pixel stays visible.
    // Points along a path: a small hollow circle. The line itself stops at the end circles (trim()).
    const R = 8, ARM = 15, GAP = 2.5;
    const ring = (q, color, r, w) => `<circle cx="${q[0]}" cy="${q[1]}" r="${r * k}" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="${(w + 1.2) * k}"/><circle cx="${q[0]}" cy="${q[1]}" r="${r * k}" fill="none" stroke="${color}" stroke-width="${w * k}"/>`;
    const cross = (q, color) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => {
      const seg = `x1="${q[0] + dx * GAP * k}" y1="${q[1] + dy * GAP * k}" x2="${q[0] + dx * ARM * k}" y2="${q[1] + dy * ARM * k}"`;
      return `<line ${seg} stroke="#000" stroke-opacity=".55" stroke-width="${2.2 * k}"/><line ${seg} stroke="${color}" stroke-width="${1 * k}"/>`;
    }).join('');
    const dots = (pts, color, big = false, open = false) => pts.map((q, i) => (i === 0 || (i === pts.length - 1 && !open)
      ? ring(q, color, R, big ? 1.8 : 1.2) + cross(q, color) : ring(q, color, 3.5, 1.2))).join('');
    /** The points with the first and last moved in by the end circle's radius, so the line does not cover the target. */
    const trim = (pts, open = false) => {
      const out = pts.map((q) => [...q]), cut = (a, b) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]); return d > 2 * R * k ? [a[0] + ((b[0] - a[0]) * R * k) / d, a[1] + ((b[1] - a[1]) * R * k) / d] : a; };
      if (out.length > 1) { out[0] = cut(pts[0], pts[1]); if (!open) out[out.length - 1] = cut(pts[pts.length - 1], pts[pts.length - 2]); }
      return out;
    };
    const label = (pts, text, color) => {
      const a = pts[Math.floor((pts.length - 1) / 2)], b = pts[Math.floor((pts.length - 1) / 2) + 1] || a;
      return `<text x="${(a[0] + b[0]) / 2}" y="${(a[1] + b[1]) / 2 - 9 * k}" font-size="${13 * k}" text-anchor="middle" fill="${color}" stroke="#000" stroke-width="${3 * k}" stroke-linejoin="round" paint-order="stroke" font-weight="700">${esc(text)}</text>`;
    };
    let out = '';
    list.forEach((m, i) => {
      if (!here(m)) return;
      const color = COLORS[i % COLORS.length], sel = selected === m;
      out += line(trim(m.points), color) + dots(m.points, color, sel) + label(m.points, `${m.label ? `${m.label} · ` : ''}${valueText(lengthPx(m.points))}`, color);
    });
    if (draft?.length) {
      const pts = hover ? [...draft, hover] : draft;
      out += line(trim(pts, true), '#ffffff') + dots(draft, '#ffffff', false, true) + (pts.length > 1 ? label(pts.slice(-2).length === 2 && S.measure.tool === 'line' ? pts : pts, valueText(lengthPx(pts)), '#ffffff') : '');
    }
    svg.innerHTML = out;
    renderReadout();
  }
  function renderReadout() {
    const pts = draft?.length ? (hover ? [...draft, hover] : draft) : null;
    $('mReadout').textContent = !img ? '' : pts && pts.length > 1 ? `${valueText(lengthPx(pts))}${img.pxPerCm ? ` · ${fmt(mm(lengthPx(pts)) / 10, 3)} cm` : ''}`
      : draft?.length ? (S.measure.tool === 'line' ? 'Click the other end' : 'Click to add points · double-click or Enter to finish')
      : S.measure.tool === 'line' ? 'Click two points' : 'Click along the path · double-click or Enter to finish';
  }

  function finish() {
    const sp = spec();
    if (!sp || !draft || draft.length < 2) { draft = null; hover = null; render(); return; }
    const n = Math.max(0, ...sp.list.map((m) => Number(/^m(\d+)$/.exec(m.id)?.[1]) || 0)) + 1;
    const m = { id: `m${n}`, label: '', side: S.measure.side, view: prod(), image: img.name, points: draft.map((q) => [+q[0].toFixed(1), +q[1].toFixed(1)]), cf: img.pxPerCm, saved: false };
    sp.list.push(m); sp.dirty = true; selected = m;
    draft = null; hover = null;
    render(); renderList();
    $('mList').scrollTop = $('mList').scrollHeight;          // the new row; only the list scrolls, never the page
  }

  /** The handle of a measurement on this image under the pointer (within 9 px on screen), if any. */
  function handleAt(e) {
    const p = toImage(e), reach = 10 / view.s;
    for (const m of spec()?.list || []) {
      if (!here(m)) continue;
      const i = m.points.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= reach);
      if (i >= 0) return { m, i };
    }
    return null;
  }

  stage.addEventListener('wheel', (e) => {
    if (!img) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);     // pinch, or ⌘/Ctrl + wheel
    else { view = { ...view, tx: view.tx - e.deltaX, ty: view.ty - e.deltaY, fitted: false }; applyView(); }      // two-finger scroll pans
  }, { passive: false });
  stage.addEventListener('mousedown', (e) => {
    if (!img) return;
    if (e.button === 1 || e.button === 2 || spaceDown || e.altKey) { pan = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; stage.classList.add('panning'); e.preventDefault(); return; }
    if (e.button !== 0) return;
    const h = !draft && handleAt(e);
    if (h) {            // keep the grab offset: the point moves with the mouse, it does not jump to it
      const p = toImage(e);
      drag = { ...h, dx: h.m.points[h.i][0] - p[0], dy: h.m.points[h.i][1] - p[1] }; selected = h.m; stage.classList.add('moving'); renderList(); e.preventDefault(); return;
    }
    lastClick = { x: e.clientX, y: e.clientY, down: true, t: lastClick?.t, px: lastClick?.px, py: lastClick?.py };
  });
  window.addEventListener('mousemove', (e) => {
    if (pan) { view = { ...view, tx: pan.tx + e.clientX - pan.x, ty: pan.ty + e.clientY - pan.y, fitted: false }; applyView(); return; }
    if (!img || S.tab !== 'measure') return;
    if (drag) {
      const p = toImage(e);
      drag.m.points[drag.i] = [Math.min(Math.max(p[0] + drag.dx, 0), img.width), Math.min(Math.max(p[1] + drag.dy, 0), img.height)].map((v) => +v.toFixed(1)); drag.m.saved = false; spec().dirty = true; render(); renderList(true); return;
    }
    if (draft?.length) { hover = toImage(e); render(); }
    stage.classList.toggle('on-handle', !draft && stage.contains(e.target) && !!handleAt(e));      // over an end point: the next press moves it
  });
  window.addEventListener('mouseup', (e) => {
    if (pan) { pan = null; stage.classList.remove('panning'); return; }
    if (drag) { drag = null; stage.classList.remove('moving'); renderList(); return; }
    if (!img || !lastClick?.down || e.button !== 0) return;
    lastClick.down = false;
    if (Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) > 4 || !stage.contains(e.target)) return;      // that was a drag, not a click
    const now = Date.now(), double = lastClick.t && now - lastClick.t < 350 && Math.hypot(e.clientX - lastClick.px, e.clientY - lastClick.py) < 5;
    lastClick.t = now; lastClick.px = e.clientX; lastClick.py = e.clientY;
    if (double && draft?.length >= 2 && S.measure.tool === 'path') { finish(); return; }
    const p = toImage(e);
    draft = draft ? [...draft, p] : [p]; hover = null;
    if (S.measure.tool === 'line' && draft.length === 2) finish(); else render();
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  new ResizeObserver(() => { if (img && view.fitted && S.tab === 'measure') fitView(); }).observe(stage);

  // ---------------------------------------------------------------- list, notes, record
  /** Every measurement of the specimen; the ones on other images are dimmed and switch to their image when clicked. */
  function renderList(valuesOnly = false) {
    const sp = spec(), list = sp?.list || [];
    if (valuesOnly) {
      list.forEach((m) => { const el = $('mList').querySelector(`[data-id="${m.id}"] .m-val`); if (el) el.innerHTML = valueHtml(m); });
      renderRecord(); return;
    }
    $('mList').innerHTML = list.length ? list.map((m, i) => `
      <div class="m-row${here(m) ? '' : ' other'}${selected === m ? ' sel' : ''}" data-id="${esc(m.id)}">
        <span class="m-dot" style="--c:${COLORS[i % COLORS.length]}"></span>
        <input class="m-label" placeholder="label" maxlength="80" value="${esc(m.label)}" spellcheck="false">
        <span class="m-val">${valueHtml(m)}</span>
        <button class="m-tag" data-tip="${esc(`${m.image}${here(m) ? '' : ' · click to show this image'}`)}">_${m.side}${LETTER[m.view]}</button>
        <span class="m-state${m.saved ? ' saved' : ''}" data-tip="${m.saved ? 'Recorded' : 'Not recorded yet'}"></span>
        <button class="m-x" data-tip="Remove">×</button>
      </div>`).join('') : '<div class="m-none">No measurements yet.</div>';
    $('mList').querySelectorAll('.m-row').forEach((row) => {
      const m = list.find((x) => x.id === row.dataset.id);
      row.querySelector('.m-label').oninput = (e) => { m.label = e.target.value; m.saved = false; sp.dirty = true; row.querySelector('.m-state').classList.remove('saved'); render(); renderRecord(); };
      row.querySelector('.m-label').onfocus = () => { if (selected !== m) { selected = m; document.querySelectorAll('.m-row').forEach((r) => r.classList.toggle('sel', r === row)); render(); } };
      row.querySelector('.m-tag').onclick = () => { selected = m; goTo(m); };
      row.querySelector('.m-x').onclick = () => { sp.list.splice(sp.list.indexOf(m), 1); sp.dirty = true; if (selected === m) selected = null; render(); renderList(); };
    });
    renderRecord();
  }
  function valueHtml(m) {
    const px = lengthPx(m.points), cf = here(m) ? img.pxPerCm : m.cf;
    return cf ? `${fmt((px / cf) * 10, 2)} mm<small>${fmt(px / cf, 3)} cm</small>` : `${fmt(px, 0)} px`;
  }
  function goTo(m) {
    if (here(m)) { renderList(); render(); return; }
    S.measure.side = m.side; S.options.view = m.view; ctx.save();
    hooks.paintView(); renderSides(); showImage(); renderList();
  }
  function renderRecord() {
    const sp = spec(), n = sp ? sp.list.filter((m) => !m.saved).length : 0;
    $('mRecord').disabled = !sp;
    $('mRecord').textContent = !sp ? 'Record' : sp.dirty ? `Record${n ? ` · ${n} new` : ' changes'}` : sp.file ? 'Recorded' : 'Record';
    $('mRecord').classList.toggle('done', !!sp && !sp.dirty && !!sp.file);
    $('mFile').textContent = sp ? `${S.measure.id}.json` : '';
    $('mFileShow').classList.toggle('hidden', !sp?.file);
  }
  $('mNotes').oninput = () => { const sp = spec(); if (sp) { sp.notes = $('mNotes').value; sp.dirty = true; renderRecord(); } };
  $('mRecord').onclick = async () => {
    const sp = spec(), id = S.measure.id;
    if (!sp) return;
    $('mRecord').disabled = true;
    try {
      const r = await api.measure.save({ folder: hooks.folder(), id, notes: sp.notes,
        measurements: sp.list.map((m) => ({ id: m.id, label: m.label, side: m.side, view: m.view, points: m.points, recordedAt: m.recordedAt, imageSha256: m.imageSha256 })) });
      sp.file = r.file; sp.dirty = false;
      sp.list.forEach((m) => { const s = r.measurements.find((x) => x.id === m.id); m.saved = true; if (s) { m.recordedAt = s.recordedAt; m.imageSha256 = s.imageSha256; m.image = s.image; m.cf = s.CF; } });
      toast(`Recorded ${sp.list.length} measurement${sp.list.length === 1 ? '' : 's'} in ${id}.json`);
    } catch (e) { toast(cleanError(e), true, 9000); }
    if (S.measure.id === id) renderList();
  };
  $('mFileShow').onclick = () => { const f = spec()?.file; if (f) api.revealPath(f).catch((e) => toast(cleanError(e), true)); };

  // ---------------------------------------------------------------- controls
  $('mLeaf').onchange = () => selectLeaf($('mLeaf').value);
  const step = (d) => { const o = [...$('mLeaf').options].map((x) => x.value), i = o.indexOf(S.measure.id) + d; if (o[i]) selectLeaf(o[i]); };
  $('mLeafPrev').onclick = () => step(-1); $('mLeafNext').onclick = () => step(1);
  const paintTool = () => $('mTool').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tool === S.measure.tool));
  $('mTool').querySelectorAll('button').forEach((b) => { b.onclick = () => { S.measure.tool = b.dataset.tool; ctx.save(); draft = null; hover = null; paintTool(); render(); }; });
  paintTool();
  const center = () => { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
  $('mZoomIn').onclick = () => zoomAt(1.4, ...center()); $('mZoomOut').onclick = () => zoomAt(1 / 1.4, ...center()); $('mFit').onclick = fitView;

  function onKey(e) {
    const typing = e.target instanceof Element && e.target.closest('input, select, textarea');
    if (e.key === 'Escape') { if (draft) { draft = null; hover = null; render(); } else if (typing) e.target.blur(); return; }
    if (typing || e.metaKey || e.ctrlKey) return;
    if (e.key === ' ') { spaceDown = true; stage.classList.add('can-pan'); e.preventDefault(); return; }
    if (e.key === 'Enter') { if (draft?.length >= 2) { e.preventDefault(); finish(); } return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      if (draft?.length) { draft = draft.slice(0, -1); if (!draft.length) draft = null; render(); }
      else if (selected && spec()) { const sp = spec(); sp.list.splice(sp.list.indexOf(selected), 1); sp.dirty = true; selected = null; render(); renderList(); }
      return;
    }
    if (e.key === '+' || e.key === '=') zoomAt(1.4, ...center());
    else if (e.key === '-') zoomAt(1 / 1.4, ...center());
    else if (e.key === '0') fitView();
    else if (e.key === 'l' || e.key === 'L') $('mTool').querySelector('[data-tool="line"]').click();
    else if (e.key === 'p' || e.key === 'P') $('mTool').querySelector('[data-tool="path"]').click();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  }
  window.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; stage.classList.remove('can-pan'); } });

  return {
    onShow() { refreshLeaves(); },
    onView() { if (S.tab === 'measure') { showImage(); renderList(); } },      // Archival / Plant / Leaf changed
    onOutput() { specimens.clear(); if (S.tab === 'measure') refreshLeaves(); },
    pick(id) { selectLeaf(id); },                                              // a leaf clicked in the Scanned strip
    onKey,
    get id() { return S.measure.id; },
  };
}
