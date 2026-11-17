// Small helpers shared by the tabs.
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let toastTimer;
export function toast(msg, err = false, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', err); t.classList.remove('hidden');
  // On the Scan tab it sits in the "Scanned" bar, horizontally centered on the gap between the Top and Bottom panels
  // (Measure tab: on the image); elsewhere at the bottom.
  const sides = [document.querySelector('.sides'), document.getElementById('mStage')].find((el) => el && el.offsetParent), bar = document.querySelector('.dock-head');
  const r = sides && sides.offsetParent && bar && bar.offsetParent ? sides.getBoundingClientRect() : null, b = r && bar.getBoundingClientRect();
  t.classList.toggle('centered', !!r);
  t.style.left = r ? `${r.left + r.width / 2}px` : ''; t.style.top = r ? `${b.top + b.height / 2}px` : '';
  clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => t.classList.add('hidden'), err ? Math.max(ms, 6000) : ms);
}

export const fmtBytes = (b) => (b == null ? '—' : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
export function fmtSecs(s) {
  if (s == null || !isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r === 60 ? `${m + 1}:00 min` : `${m}:${String(r).padStart(2, '0')} min`;
}

/** Size of a profile area ({ mode: 'auto' | '10cm' | 'custom' | 'full', wCm, hCm }), in cm. Auto is only
 *  known after the prescan, so it counts as the whole glass (the most it can be). */
export const BED_CM = { w: 8.5 * 2.54, h: 11.7 * 2.54 };
export function areaCm(area) {
  if (!area || area.mode === 'full' || area.mode === 'auto') return { w: BED_CM.w, h: BED_CM.h, full: true, auto: area?.mode === 'auto' };
  if (area.mode === '10cm') return { w: 10, h: 10 };
  return { w: Number(area.wCm) || 10, h: Number(area.hCm) || 10 };
}
export const areaLabel = (area) => { const a = areaCm(area); return a.auto ? 'Auto' : a.full ? 'full glass' : `${+a.w.toFixed(1)} × ${+a.h.toFixed(1)} cm`; };
export const pixelsFor = (area, dpi) => { const a = areaCm(area); return { w: Math.round((a.w / 2.54) * dpi), h: Math.round((a.h / 2.54) * dpi) }; };

/** A short two-note chime (no audio files). */
export function chime() {
  try {
    const ctx = new AudioContext();
    [[880, 0], [1320, 0.16]].forEach(([f, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.35);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.4);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch { /* no audio device */ }
}
