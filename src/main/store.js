'use strict';
// App state is one JSON file in the per-user data folder, which app updates never touch:
//   <userData>/settings.json   scan profile, leaf-ID pattern, current leaf, calibration choices, options
// Scans themselves never live here: they go to the output folder chosen in Calibrate (~/ScanDeckScans).
const fs = require('node:fs');
const path = require('node:path');

function writeFileAtomicSync(file, text) {
  const tmp = `${file}.${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

class Store {
  constructor({ userDir }) {
    this.userDir = userDir;
    this.settingsFile = path.join(userDir, 'settings.json');
    this.queue = Promise.resolve();
  }

  readSettingsSync() {
    try { return JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') console.error('settings.json unreadable:', e.message); return null; }
  }

  /** Writes queue up so an older write never lands after a newer one. */
  writeSettings(s) {
    const text = JSON.stringify(s, null, 2);
    this.queue = this.queue.then(() => { fs.mkdirSync(this.userDir, { recursive: true }); writeFileAtomicSync(this.settingsFile, text); });
    return this.queue;
  }

  writeSettingsSync(s) {
    fs.mkdirSync(this.userDir, { recursive: true });
    writeFileAtomicSync(this.settingsFile, JSON.stringify(s, null, 2));
  }
}

module.exports = { Store };
