'use strict';
// The OpenVINO models, fetched from Hugging Face when they are missing (they are not kept in the repo).
//
// src/models/models.json lists, per model, the Hugging Face repo, a pinned revision and each file's size and
// sha256. A missing file is downloaded to <file>.part, checked against both, and only then renamed into place;
// best.xml comes last, so a model counts as present only once all of its files are. A file already present with
// the right size is kept (the download resumes per file after an interruption).
//
//   npm run models:fetch        the same from the command line
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MODELS_DIR = path.join(__dirname, '..', 'models');
const MANIFEST = path.join(MODELS_DIR, 'models.json');
const HF = 'https://huggingface.co';

function manifest(file = MANIFEST) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** The files still to fetch: [{ model, file, dest, url, bytes, sha256 }]. */
function missing({ modelsDir = MODELS_DIR, list = manifest().models, base = HF } = {}) {
  const out = [];
  for (const m of list) {
    for (const f of m.files) {
      const dest = path.join(modelsDir, m.dir, f.name);
      let ok = false;
      try { ok = fs.statSync(dest).size === f.bytes; } catch { /* not there */ }
      if (!ok) out.push({ model: m.dir, file: f.name, dest, url: `${base}/${m.repo}/resolve/${m.revision}/${f.src}`, bytes: f.bytes, sha256: f.sha256 });
    }
  }
  // per model: metadata and weights first, best.xml last (it is what "present" is checked by)
  const rank = (x) => (x.file === 'best.xml' ? 1 : 0);
  return out.sort((a, b) => a.model.localeCompare(b.model) || rank(a) - rank(b));
}

/** Download one file to dest via dest.part, checking size and sha256. onBytes(n) is called as data arrives. */
async function fetchFile(item, { onBytes = () => {}, signal } = {}) {
  await fsp.mkdir(path.dirname(item.dest), { recursive: true });
  const part = `${item.dest}.part`;
  const res = await fetch(item.url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`${item.model}/${item.file}: HTTP ${res.status}`);
  const hash = crypto.createHash('sha256');
  let got = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (b) => { hash.update(b); got += b.length; onBytes(b.length); });
  try {
    await pipeline(body, fs.createWriteStream(part));
    if (got !== item.bytes) throw new Error(`${item.model}/${item.file}: got ${got} bytes, expected ${item.bytes}`);
    const sum = hash.digest('hex');
    if (sum !== item.sha256) throw new Error(`${item.model}/${item.file}: sha256 does not match (the file on Hugging Face changed?)`);
    await fsp.rename(part, item.dest);
  } catch (e) { await fsp.rm(part, { force: true }); throw e; }
}

/**
 * Fetch whatever is missing. onProgress({ done, total, file }) in bytes. Resolves { fetched: [names], bytes }.
 * Only one run at a time: a second call while one runs gets the same promise.
 */
let running = null;
function ensure(opts = {}) {
  if (running) return running;
  running = (async () => {
    const todo = missing(opts);
    const total = todo.reduce((s, x) => s + x.bytes, 0);
    let done = 0;
    const tell = (file) => { if (opts.onProgress) opts.onProgress({ done, total, file }); };
    for (const item of todo) {
      tell(`${item.model}/${item.file}`);
      await fetchFile(item, { signal: opts.signal, onBytes: (n) => { done += n; tell(`${item.model}/${item.file}`); } });
    }
    return { fetched: todo.map((x) => `${x.model}/${x.file}`), bytes: total };
  })().finally(() => { running = null; });
  return running;
}

module.exports = { MODELS_DIR, manifest, missing, fetchFile, ensure };

// npm run models:fetch
if (require.main === module) {
  const todo = missing();
  if (!todo.length) { console.log('All models are present.'); process.exit(0); }
  const mb = (b) => (b / 1e6).toFixed(1);
  console.log(`Fetching ${todo.length} file(s), ${mb(todo.reduce((s, x) => s + x.bytes, 0))} MB, from Hugging Face…`);
  let last = 0;
  ensure({ onProgress: ({ done, total, file }) => { if (Date.now() - last > 1000 || done === total) { last = Date.now(); process.stdout.write(`\r${mb(done)} / ${mb(total)} MB  ${file}        `); } } })
    .then((r) => { console.log(`\nDone: ${r.fetched.join(', ')}`); }, (e) => { console.error(`\n${e.message}`); process.exit(1); });
}
