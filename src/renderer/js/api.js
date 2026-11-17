// Thin adapter over the preload bridge so the rest of the UI never touches IPC directly.
const bridge = window.scandeck;
if (!bridge) throw new Error('ScanDeck must run inside the Electron app (preload bridge missing).');

// Errors thrown in the main process arrive as "Error invoking remote method 'x': Error: message".
export const cleanError = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

export const api = bridge;

/** URL for a preview image in the output or calibration folders (served by the main process). */
export const imgUrl = (absPath, bust = '') => `sdimg://img/?p=${encodeURIComponent(absPath)}${bust ? `&v=${encodeURIComponent(bust)}` : ''}`;
