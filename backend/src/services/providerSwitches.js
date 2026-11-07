// Providers switched off in the admin panel. A switched-off provider is not
// asked for sources and its cached links are not served. Saved in .local (a
// volume), so the choice survives rebuilds and restarts.
const fs = require('fs');
const path = require('path');

const file = () => process.env.PROVIDER_SWITCH_FILE || path.resolve(__dirname, '../../.local/provider-switches.json');
let cache = { at: 0, off: new Set(), changed: {} };

function read() {
  if (Date.now() - cache.at < 3000) return cache;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* none switched off */ }
  cache = { at: Date.now(), off: new Set(Array.isArray(data.off) ? data.off : []), changed: data.changed || {} };
  return cache;
}

const isOff = id => read().off.has(id);
const offList = () => [...read().off];
const changedAt = id => read().changed[id] || null;

function set(id, on) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw Object.assign(new Error('Invalid provider'), { code: 'INVALID_PROVIDER' });
  const current = read();
  const off = new Set(current.off);
  if (on) off.delete(id); else off.add(id);
  const data = { off: [...off].sort(), changed: { ...current.changed, [id]: new Date().toISOString() } };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const temp = file() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file());
  cache = { at: 0, off: new Set(), changed: {} };
  return { id, on: !off.has(id) };
}

module.exports = { isOff, offList, changedAt, set, _reset: () => { cache = { at: 0, off: new Set(), changed: {} }; } };
