// Time and file size of a scan, predicted from calibration runs (newest run first).
// Sizes follow the formats being saved (profile.formats; calibration scans are TIFF). JPEG XL ratios
// come from the newest compression test, else the 2026-11-12 measurement at 1200 dpi / 16-bit.
// Measured on the V370 (2026-11-12): a scan costs ~9 s of fixed overhead (warm-up, calibration,
// session) plus a per-line time set by the head speed at that dpi (≈5 ms at 600, 9.4 at 1200,
// 12.4 at 2400). Bit depth doesn't change the time, only the size. The driver writes LZW,
// which shrinks 8-bit scans but *grows* 16-bit ones, so sizes use the measured ratio.
import { pixelsFor } from './util.js';

export const OVERHEAD_S = 9;
export const JXL_RATIOS = { jxl: 0.69, jxlLossy: 0.026 };   // of raw RGB size, measured 2026-11-12
export const PRESCAN_SECONDS = 18.6;                          // 75 dpi full-glass prescan, measured 2026-11-12

const usable = (x) => x && !x.error && x.scanSeconds > 0 && x.h > 0;

export function msPerLine(result) {
  return usable(result) ? Math.max(0, (result.scanSeconds - OVERHEAD_S) / result.h) * 1000 : null;
}

export function estimate(profile, runs = []) {
  const { w, h } = pixelsFor(profile.area, profile.dpi);
  const rawBytes = w * h * 3 * (profile.bits / 8);
  const all = runs.flatMap((run) => (run.results || []).filter((x) => !x.correction).map((x) => ({ ...x, runId: run.id })));
  const timing = all.find((x) => x.dpi === profile.dpi && usable(x));
  const seconds = timing ? OVERHEAD_S + (msPerLine(timing) / 1000) * h : null;
  const sizing = all.find((x) => x.dpi === profile.dpi && x.bits === profile.bits && x.fileBytes && x.rawBytes)
    || all.find((x) => x.bits === profile.bits && x.fileBytes && x.rawBytes);
  const ratio = sizing ? sizing.fileBytes / sizing.rawBytes : 1;
  const comp = runs.find((run) => run.compression?.results)?.compression;
  const compRatio = (key) => { const r = comp?.results.find((x) => x.key === key && x.bytes); return r ? r.bytes / comp.source.rawBytes : null; };
  const formats = profile.formats || { tiff: true };
  const parts = [];
  if (formats.jxl) parts.push({ format: 'jxl', bytes: rawBytes * (compRatio('jxl') ?? JXL_RATIOS.jxl) });
  if (formats.tiff) parts.push({ format: 'tiff', bytes: rawBytes * (profile.formats ? 1 : ratio) });   // saved scans: uncompressed; calibration: the driver's LZW
  if (formats.jxlLossy) parts.push({ format: 'jxlLossy', bytes: rawBytes * (compRatio('jxl-d1') ?? JXL_RATIOS.jxlLossy) });
  const bytes = parts.reduce((s, p) => s + p.bytes, 0);
  return { w, h, rawBytes, bytes, parts, ratio, measuredSize: !!sizing, seconds, basis: timing?.runId ?? null };
}
