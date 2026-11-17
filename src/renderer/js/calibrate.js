// Calibrate tab: scanner facts, calibration runs (their own settings) and the test-image gallery.
import { api, cleanError, imgUrl } from './api.js';
import { $, esc, toast, fmtBytes, fmtSecs, areaLabel } from './util.js';
import { estimate, msPerLine } from './estimate.js';
import { seg, bindDims } from './profile.js';

const DPIS = [150, 300, 600, 1200, 2400, 4800];
const AREAS = [['10cm', '10 × 10 cm'], ['custom', 'Custom'], ['full', 'Full glass']];
const CORR = { dpi: 1200, bits: 16, scans: 7 };   // the runner's corrections set: repeat + 5 singles + all
const VIEWS = [
  ['compare', 'Detail', 'The same 1 × 1 cm at every dpi, unsmoothed. The ×16 contrast rows show banding: 8-bit breaks up, 16-bit stays smooth.'],
  ['grid', 'By dpi', 'Whole area, 1 cm crop and ×16 contrast for every scan.'],
  ['corrections', 'Corrections', 'Each Epson correction compared with the plain scan. The repeat (no corrections) is the noise floor.'],
  ['compression', 'Compression', 'The 1200 dpi 16-bit scan saved in other formats, decoded and checked bit-for-bit. Crops come from the decoded files.'],
];

export function initCalibrate(ctx) {
  const { S } = ctx;
  let caps = null;

  // ---------------------------------------------------------------- scanner facts
  function renderFacts() {
    const st = ctx.status || {};
    const rows = [
      ['Status', st.busy ? (st.busy === 'calibration' ? 'calibrating' : 'scanning') : st.mock ? 'mock' : st.connected ? 'connected' : (st.error || 'not found')],
      ['Device', st.name || caps?.device?.name || '—'],
      ['ICA driver', st.driver || caps?.driver || '—'],
    ];
    const fb = caps?.functionalUnits?.find((u) => u.type === 'flatbed');
    if (fb) {
      rows.push(['Glass', `${(fb.physicalSize.w * 2.54).toFixed(1)} × ${(fb.physicalSize.h * 2.54).toFixed(1)} cm`]);
      rows.push(['Bit depths', (fb.supportedBitDepths || []).join(', ')]);
      rows.push(['Optical', `${fb.nativeXResolution ?? '—'} dpi`]);
      const vf = fb.vendorFeatures || [];
      if (vf.length) rows.push(['Corrections', `${vf.length}, always off`]);
    }
    $('scannerFacts').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }
  $('btnCaps').onclick = async () => {
    $('btnCaps').disabled = true;
    try { caps = await api.scanner.caps(); renderFacts(); } catch (e) { toast(cleanError(e), true); } finally { $('btnCaps').disabled = false; }
  };

  // ---------------------------------------------------------------- calibration run settings
  function checks(id, options, chosen, onToggle) {
    $(id).innerHTML = options.map(([v, label]) => `<label class="check"><input type="checkbox" value="${v}" ${chosen.includes(v) ? 'checked' : ''}> ${esc(label)}</label>`).join('');
    $(id).querySelectorAll('input').forEach((inp) => { inp.onchange = () => onToggle(Number(inp.value), inp.checked); });
  }
  function renderCalControls() {
    const toggle = (list) => (v, on) => { const i = list.indexOf(v); if (on && i < 0) list.push(v); if (!on && i >= 0) list.splice(i, 1); list.sort((a, b) => a - b); ctx.save(); renderPlan(); };
    checks('calDpis', DPIS.map((d) => [d, d]), S.calib.dpis, toggle(S.calib.dpis));
    checks('calBits', [[8, '8-bit'], [16, '16-bit']], S.calib.bits, toggle(S.calib.bits));
    seg('calArea', AREAS, S.calib.area.mode, (v) => { S.calib.area.mode = v; ctx.save(); renderCalControls(); });
    $('calCustom').classList.toggle('hidden', S.calib.area.mode !== 'custom');
    $('calCorr').checked = S.calib.corrections !== false;
    $('calComp').checked = S.calib.compression !== false;
    $('calCorr').onchange = () => { S.calib.corrections = $('calCorr').checked; ctx.save(); renderPlan(); };
    $('calComp').onchange = () => { S.calib.compression = $('calComp').checked; ctx.save(); renderPlan(); };
    renderPlan();
  }
  bindDims('calW', 'calH', S.calib.area, () => { ctx.save(); renderPlan(); });
  function renderPlan() {
    const items = S.calib.dpis.flatMap((dpi) => S.calib.bits.map((bits) => ({ dpi, bits })));
    if (S.calib.corrections !== false && items.length) {
      if (!items.some((it) => it.dpi === CORR.dpi && it.bits === CORR.bits)) items.push({ ...CORR });
      for (let i = 0; i < CORR.scans; i++) items.push({ ...CORR });
    }
    let secs = 0, known = true, bytes = 0, tooBig = 0;
    for (const it of items) {
      const e = estimate({ dpi: it.dpi, bits: it.bits, area: S.calib.area }, ctx.runs);
      if (e.seconds) secs += e.seconds; else known = false;
      bytes += e.bytes; if (e.rawBytes > 4e9) tooBig++;
    }
    $('calPlan').textContent = !items.length ? 'Pick a resolution and a color depth.'
      : `${items.length} scans · ${areaLabel(S.calib.area)} · ≈ ${fmtBytes(bytes)}${secs ? ` · ${known ? '≈' : '>'} ${fmtSecs(secs)}` : ''}`
        + (tooBig ? `\n${tooBig} over the 4 GB TIFF limit` : '');
    $('btnCalStart').disabled = !items.length || ctx.busy.calib || ctx.busy.scan || ctx.mock();
    $('btnCalStart').dataset.tip = ctx.mock() ? 'Needs the real scanner: turn off mock mode in Settings' : '';
  }

  const log = (line) => { const el = $('calLog'); el.classList.remove('hidden'); el.textContent += `${line}\n`; el.scrollTop = el.scrollHeight; };
  $('btnCalStart').onclick = async () => {
    $('calLog').textContent = '';
    try {
      await api.calib.start({ area: S.calib.area, dpis: S.calib.dpis, bits: S.calib.bits, corrections: S.calib.corrections !== false, compression: S.calib.compression !== false });
      follow = true;
      setRunning(true);
    } catch (e) { toast(cleanError(e), true); }
  };
  $('btnCalStop').onclick = async () => { await api.calib.stop(); $('btnCalStop').disabled = true; log('Stopping after this scan…'); };
  let follow = false;                          // keep showing the newest run while one is going
  function setRunning(on) {
    ctx.setBusy('calib', on);
    $('btnCalStop').classList.toggle('hidden', !on); $('btnCalStop').disabled = false;
    renderPlan();
  }
  const refreshSoon = debounce(() => refreshRuns(), 400);
  api.onCalibLine((line) => { log(line); if (/^\s+(OK|CHECK|FAILED)/.test(line)) refreshSoon(); });
  api.onCalibDone(({ code, stopped }) => {
    setRunning(false);
    log(stopped ? 'Stopped.' : code === 0 ? 'Done.' : `Exit code ${code}.`);
    toast(stopped ? 'Calibration stopped.' : code === 0 ? 'Calibration done.' : 'Calibration failed; see the log.', code !== 0 && !stopped);
    refreshRuns().then(() => { follow = false; });
  });
  api.onCompressDone(({ code }) => {
    compressing = false;
    toast(code === 0 ? 'Compression test done.' : 'Compression test failed; see the log.', code !== 0);
    refreshRuns();
  });

  // ---------------------------------------------------------------- runs + gallery
  const runLabel = (r) => {
    const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})_(.+)$/.exec(r.id);
    const when = m ? `${m[1]} ${m[2]}:${m[3]}` : r.id;
    const area = m ? m[5].replace(/^(\d+(?:\.\d+)?)cm$/, '$1 × $1 cm').replace('fullbed', 'full glass').replace(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)cm$/, '$1 × $2 cm') : '';
    return `${when} · ${area} · ${r.ok}/${r.total} OK${r.finished ? '' : ' · unfinished'}`;
  };
  async function refreshRuns() {
    try { ctx.runs = await api.calib.runs(); } catch (e) { ctx.runs = []; toast(cleanError(e), true); }
    if (follow && ctx.runs[0]) S.calib.runId = ctx.runs[0].id;
    if (!ctx.runs.find((r) => r.id === S.calib.runId)) S.calib.runId = ctx.runs[0]?.id ?? null;
    $('runSelect').innerHTML = ctx.runs.length ? ctx.runs.map((r) => `<option value="${esc(r.id)}" ${r.id === S.calib.runId ? 'selected' : ''}>${esc(runLabel(r))}</option>`).join('') : '<option>No runs yet</option>';
    $('runSelect').disabled = !ctx.runs.length;
    $('btnRunFolder').disabled = $('btnRunDelete').disabled = !ctx.runs.length;
    renderRun(); renderPlan(); ctx.profileChanged();
  }
  $('runSelect').onchange = () => { S.calib.runId = $('runSelect').value; follow = false; ctx.save(); renderRun(); };
  const currentRun = () => ctx.runs.find((r) => r.id === S.calib.runId);
  $('btnRunFolder').onclick = () => { const r = currentRun(); if (r) api.openPath(r.dir); };
  $('btnRunDelete').onclick = async () => {
    const r = currentRun(); if (!r) return;
    try { const res = await api.calib.remove(r.id, runLabel(r)); if (res.deleted) { toast('Moved to the Trash.'); refreshRuns(); } } catch (e) { toast(cleanError(e), true); }
  };

  const fileOf = (run, rel) => `${run.dir}/${rel}`;
  const statusPill = (s) => `<span class="status ${s === 'OK' ? 'ok' : s === 'FAILED' ? 'bad' : 'warn'}" ${s !== 'OK' ? `data-tip="${esc(s)}"` : ''}>${s === 'OK' ? 'OK' : s === 'FAILED' ? 'failed' : 'check'}</span>`;
  let compressing = false;

  function renderRun() {
    const run = currentRun();
    const body = $('runBody');
    if (!run) { body.innerHTML = '<div class="empty-gallery">No runs yet.</div>'; return; }
    const all = run.results;
    const plain = all.filter((r) => !r.correction).sort((a, b) => a.dpi - b.dpi || a.bits - b.bits);
    const corrected = all.filter((r) => r.correction);              // in scan order: repeat, singles, all
    const dpis = [...new Set(plain.map((r) => r.dpi))];
    const bitsList = [...new Set(plain.map((r) => r.bits))];
    const hasSource = plain.some((r) => r.dpi === 1200 && r.bits === 16 && r.tiff);

    const row = (r) => {
      const ml = msPerLine(r);
      const inProfile = !r.correction && r.dpi === S.profile.dpi && r.bits === S.profile.bits;
      return `<tr class="${inProfile ? 'inprofile' : ''}">
        <td class="num">${r.dpi}</td><td>${r.bits}-bit</td><td>${esc(r.correction?.label ?? '')}</td>
        <td class="num">${r.info ? `${r.info.width} × ${r.info.height}` : '—'}</td>
        <td class="num">${fmtBytes(r.fileBytes)}</td><td class="num">${fmtSecs(r.scanSeconds)}</td>
        <td class="num">${ml != null ? ml.toFixed(1) : '—'}</td>
        <td class="num">${r.diff ? `Δ ${r.diff.maePct.toFixed(2)}%` : r.previews?.tones?.distinctLevels?.toLocaleString() ?? '—'}</td>
        <td>${statusPill(r.status)}</td>
        <td>${r.correction ? '' : inProfile ? '<span class="hint">in use</span>' : `<button class="small" data-use="${r.dpi}:${r.bits}" data-tip="Use for scanning">Use</button>`}</td></tr>`;
    };
    const views = VIEWS.filter(([v]) => v === 'compare' || v === 'grid' || (v === 'corrections' && corrected.length) || (v === 'compression' && (run.compression || hasSource)));
    const view = views.some(([v]) => v === S.calib.view) ? S.calib.view : 'compare';
    body.innerHTML = `
      <table class="sum"><thead><tr><th class="num">dpi</th><th>depth</th><th>correction</th><th class="num">pixels</th><th class="num">size</th><th class="num">time</th><th class="num">ms/line</th>
        <th class="num">levels <span class="tip" data-tip="Distinct tone values in a 1 × 1 cm patch (8-bit tops out at 256). Correction rows: Δ = how much the patch differs from the plain scan.">i</span></th><th>status</th><th></th></tr></thead>
      <tbody>${[...plain, ...corrected].map(row).join('')}</tbody></table>
      <div class="row view-seg"><div class="seg" id="viewSeg">${views.map(([v, label, tip]) => `<button data-v="${v}" class="${view === v ? 'active' : ''}" data-tip="${esc(tip)}">${label}</button>`).join('')}</div></div>
      <div id="viewBody"></div>`;
    body.querySelectorAll('[data-use]').forEach((b) => {
      b.onclick = () => { const [d, bt] = b.dataset.use.split(':').map(Number); S.profile.dpi = d; S.profile.bits = bt; ctx.save(); ctx.profileChanged(); renderRun(); toast(`Scanning at ${d} dpi, ${bt}-bit.`); };
    });
    body.querySelectorAll('#viewSeg button').forEach((b) => { b.onclick = () => { S.calib.view = b.dataset.v; ctx.save(); renderRun(); }; });

    // Lightbox items: every image gets a row and a column, so the arrow keys move along a row (← →)
    // and between rows in the same column (↑ ↓).
    const lb = [];
    const img = (rel, { r, c, cls = 'px', title, caption, pixelated = true, tiff = null }) => {
      if (!rel) return '<div class="tile"></div>';
      const i = lb.push({ src: imgUrl(fileOf(run, rel)), title, caption, pixelated, tiff, r, c }) - 1;
      return `<img class="tile ${cls}" src="${imgUrl(fileOf(run, rel))}" data-li="${i}" alt="">`;
    };
    const tiffOf = (r) => (r.tiff ? fileOf(run, r.tiff) : null);
    const name = (r) => `${r.dpi} dpi · ${r.bits}-bit${r.correction ? ` · ${r.correction.label}` : ''}`;
    const vb = $('viewBody');

    if (view === 'compare') {
      const find = (dpi, bits) => plain.find((r) => r.dpi === dpi && r.bits === bits);
      let html = `<div class="compare" style="grid-template-columns: 90px repeat(${dpis.length}, minmax(80px, 1fr))"><div></div>`
        + dpis.map((d) => `<div class="hd">${d} dpi</div>`).join('');
      bitsList.forEach((bits, bi) => {
        const cell = (d, c, kind) => {
          const r = find(d, bits);
          const rel = kind === 'stretch' ? r?.previews?.stretch : r?.previews?.crop;
          return `<figure>${img(rel, { r: bi * 2 + (kind === 'stretch' ? 1 : 0), c, title: r ? name(r) : '', caption: kind === 'stretch' ? '1 × 1 cm · contrast ×16' : '1 × 1 cm · actual pixels', tiff: r && tiffOf(r) })}</figure>`;
        };
        html += `<div class="rl">${bits}-bit</div>` + dpis.map((d, c) => cell(d, c, 'crop')).join('');
        html += `<div class="rl">×16</div>` + dpis.map((d, c) => cell(d, c, 'stretch')).join('');
      });
      vb.innerHTML = `${html}</div>`;
    } else if (view === 'grid') {
      let rowIx = 0;
      vb.innerHTML = dpis.map((d) => `<div class="gal-row"><h3>${d} dpi</h3><div class="gal">${bitsList.map((bits) => {
        const r = plain.find((x) => x.dpi === d && x.bits === bits);
        if (!r) return '';
        const p = r.previews, ri = rowIx++;
        const meta = [r.info && `${r.info.width} × ${r.info.height}`, fmtBytes(r.fileBytes), fmtSecs(r.scanSeconds)].filter(Boolean).join(' · ');
        const o = (c, caption, pixelated = true) => ({ r: ri, c, title: name(r), caption, pixelated, tiff: tiffOf(r) });
        return `<div class="gal-card"><div class="head"><strong>${bits}-bit</strong>${statusPill(r.status)}</div><div class="meta">${esc(meta)}</div>
          ${p ? `<div class="imgs">
            <figure>${img(p.overview, { ...o(0, 'whole area', false), cls: 'ov' })}<figcaption>area</figcaption></figure>
            <figure>${img(p.crop, o(1, '1 × 1 cm · actual pixels'))}<figcaption>1 cm</figcaption></figure>
            <figure>${img(p.stretch, o(2, '1 × 1 cm · contrast ×16'))}<figcaption>×16</figcaption></figure>
          </div>` : `<p class="hint">${esc(r.previewError || r.error || 'no preview')}</p>`}</div>`;
      }).join('')}</div></div>`).join('');
    } else if (view === 'corrections') {
      const base = plain.find((r) => r.name === corrected[0].baseline);
      const noise = corrected.find((r) => r.correction.key === 'repeat')?.diff?.maePct;
      vb.innerHTML = `<div class="gal">${[base, ...corrected].filter(Boolean).map((r, ri) => {
        const d = r.diff;
        const verdict = !r.correction ? 'baseline' : !d ? esc(r.diffError || r.error || '—')
          : r.correction.key === 'repeat' ? `noise floor Δ ${d.maePct.toFixed(2)}%`
          : `Δ ${d.maePct.toFixed(2)}%${noise ? ` · ${(d.maePct / noise).toFixed(1)}× noise` : ''}`;
        const shift = d ? `<span data-tip="Mean color shift, percentage points (+ = brighter)">RGB ${d.meanShiftPct.map((v) => (v >= 0 ? '+' : '') + v.toFixed(1)).join(' ')}</span>` : '';
        const o = (c, caption) => ({ r: ri, c, title: name(r), caption, tiff: tiffOf(r) });
        return `<div class="gal-card"><div class="head"><strong>${esc(r.correction?.label ?? 'Plain')}</strong>${statusPill(r.status)}</div>
          <div class="meta">${verdict}${shift ? ` · ${shift}` : ''}</div>
          <div class="imgs">
            <figure>${img(r.previews?.crop, o(0, '1 × 1 cm'))}<figcaption>1 cm</figcaption></figure>
            <figure>${img(r.previews?.stretch, o(1, 'contrast ×16'))}<figcaption>×16</figcaption></figure>
            <figure>${d ? img(d.image, o(2, 'difference from plain ×8')) : '<div class="tile"></div>'}<figcaption>${d ? 'diff ×8' : ''}</figcaption></figure>
          </div></div>`;
      }).join('')}</div>`;
    } else {
      const comp = run.compression;
      if (!comp) {
        vb.innerHTML = `<div class="empty-gallery"><button id="btnCompress" class="primary" ${compressing ? 'disabled' : ''}>${compressing ? 'Testing…' : 'Test compression'}</button></div>`;
        $('btnCompress').onclick = async () => {
          try { compressing = true; await api.calib.compress(run.id); $('calLog').textContent = ''; renderRun(); } catch (e) { compressing = false; toast(cleanError(e), true); }
        };
      } else {
        const raw = comp.source.rawBytes;
        const rows = comp.results.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${fmtBytes(r.bytes)}</td><td class="num">${r.bytes ? Math.round((r.bytes / raw) * 100) + '%' : '—'}</td>
          <td class="num">${r.encodeS != null ? r.encodeS.toFixed(1) + ' s' : '—'}</td><td class="num">${r.decodeS != null ? r.decodeS.toFixed(1) + ' s' : '—'}</td>
          <td class="${r.error ? 'warn' : r.exact ? 'ok' : 'warn'}">${r.error ? esc(r.error) : r.exact ? 'exact' : `lossy · ${r.psnr?.toFixed(1)} dB`}</td>
          <td>${r.opensInPreview ? 'yes' : '<span class="hint">no</span>'}</td><td><span class="tip" data-tip="${esc(r.note)}">i</span></td></tr>`).join('');
        const cards = [{ label: 'Original', ref: true, crops: comp.reference }, ...comp.results.filter((r) => r.key !== 'tiff-lzw')];
        vb.innerHTML = `<div class="row" style="margin-bottom:10px"><span class="spacer"></span><button id="btnCompPage" class="small">Open compression.html</button></div>
          <table class="sum"><thead><tr><th>format</th><th class="num">size</th><th class="num">of raw</th><th class="num">encode</th><th class="num">decode</th><th>pixels</th><th>Preview</th><th></th></tr></thead><tbody>${rows}</tbody></table>
          <div class="comp-grid">${cards.map((r, ri) => {
            const o = (c, caption) => ({ r: ri, c, title: r.label, caption, pixelated: c > 0 });
            return `<div class="comp-card ${r.ref ? 'ref' : r.lossless ? '' : 'lossy'}"><div class="head"><strong>${esc(r.label)}</strong><span class="hint">${r.ref ? '' : `${fmtBytes(r.bytes)}${r.exact ? ' · exact' : ''}`}</span></div>
              <div class="imgs">${img(r.crops?.stamp, { ...o(0, 'stamp'), cls: 'stamp' })}${img(r.crops?.detail, o(1, 'detail · actual pixels'))}${r.crops?.diff ? img(r.crops.diff, o(2, 'difference ×16')) : '<div class="tile"></div>'}</div></div>`;
          }).join('')}</div>`;
        $('btnCompPage').onclick = () => api.browse(`${run.dir}/compression.html`).catch((e) => toast(cleanError(e), true));
      }
    }
    vb.querySelectorAll('[data-li]').forEach((el) => { el.onclick = () => ctx.openLightbox(lb, Number(el.dataset.li)); });
  }

  // ---------------------------------------------------------------- startup
  renderFacts(); renderCalControls();
  refreshRuns();
  api.calib.status().then((s) => { if (s.running) { follow = true; setRunning(true); log('Calibration running…'); } });

  return {
    onShow() { refreshRuns(); renderFacts(); },
    onStatus() { renderFacts(); },
    onProfile() { if (currentRun()) renderRun(); },
    onBusy() { renderPlan(); },
    onMock() { renderPlan(); },
  };
}

function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }
