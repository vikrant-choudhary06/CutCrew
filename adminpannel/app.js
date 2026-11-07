// CutCrew admin panel. Talks to /api/admin/* with the admin token; every
// value from the server is put on the page as text, never as HTML.
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const TOKEN_KEY = 'cutcrew-admin-token';
  let token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* storage blocked */ }
  let tab = 'overview', timer = null, lastOk = 0;

  // ---------- helpers ----------
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Authorization: 'Bearer ' + token };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CutCrew-Admin'] = '1'; }
    const response = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    if (response.status === 401) { signOut('That token was not accepted.'); throw new Error('Signed out'); }
    let data = null;
    try { data = await response.json(); } catch { /* empty body */ }
    if (!response.ok) throw new Error((data && (data.error || data.message)) || 'Request failed (' + response.status + ')');
    lastOk = Date.now();
    return data;
  }
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
    return node;
  }
  const say = text => { $('#status').textContent = text || ''; };
  const num = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
  const bytes = b => { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1000 && i < 4) { b /= 1000; i++; } return b.toFixed(i > 1 ? 1 : 0) + ' ' + u[i]; };
  const ago = t => { if (!t) return '—'; const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  const since = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'; };
  const duration = s => { if (!s) return '—'; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? h + 'h ' + m + 'm' : m + 'm ' + (s % 60) + 's'; };
  const flag = code => (/^[A-Z]{2}$/.test(code || '') ? code : '—');
  const what = w => (w ? w.title + (w.season != null ? ` · S${w.season} E${w.episode}` : '') : '—');
  const stat = (value, label, cls = '') => el('div', { class: 'stat ' + cls }, el('b', {}, value), el('span', {}, label));
  function table(target, headers, rows, empty = 'Nothing to show yet.') {
    const node = $(target);
    node.replaceChildren(el('thead', {}, el('tr', {}, headers.map(h => el('th', {}, h)))),
      el('tbody', {}, rows.length ? rows.map(cells => el('tr', {}, cells.map(c => (c instanceof Node && c.tagName === 'TD' ? c : el('td', {}, c))))) : el('tr', {}, el('td', { class: 'empty', colspan: headers.length }, empty))));
  }
  const td = (value, cls) => el('td', { class: cls }, value);
  const facts = (target, pairs) => $(target).replaceChildren(...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

  // ---------- sign in ----------
  function signOut(message) {
    token = '';
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    clearTimeout(timer);
    $('#shell').hidden = true; $('#login').hidden = false;
    $('#login-error').textContent = message || '';
    $('#token').focus();
  }
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    token = $('#token').value.trim();
    try {
      await api('/admin/panel/overview');
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* this tab only */ }
      $('#token').value = '';
      start();
    } catch (error) { if (token) $('#login-error').textContent = error.message; }
  });
  $('#logout').addEventListener('click', () => signOut(''));

  // ---------- tabs ----------
  const loaders = { overview, live, downloads, providers, storage, catalogue: () => {}, logs };
  const refreshMs = { overview: 5000, live: 3000, downloads: 30000, providers: 10000, storage: 15000, logs: 3000 };
  function show(name) {
    tab = name;
    for (const button of document.querySelectorAll('#nav button')) button.classList.toggle('active', button.dataset.tab === name);
    for (const section of document.querySelectorAll('.tab')) section.hidden = section.id !== 'tab-' + name;
    say('');
    tick();
  }
  for (const button of document.querySelectorAll('#nav button')) button.addEventListener('click', () => show(button.dataset.tab));
  async function tick() {
    clearTimeout(timer);
    try { await loaders[tab](); } catch (error) { if (token) say(error.message); }
    $('#pulse').classList.toggle('stale', Date.now() - lastOk > 20000);
    $('#updated').textContent = lastOk ? 'Updated ' + new Date(lastOk).toLocaleTimeString() : '—';
    if (token && refreshMs[tab] && !document.hidden) timer = setTimeout(tick, refreshMs[tab]);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) tick(); });
  function start() { $('#login').hidden = true; $('#shell').hidden = false; show(tab); }

  // ---------- overview ----------
  async function overview() {
    const d = await api('/admin/panel/overview');
    const dl = Object.fromEntries((d.downloads || []).map(x => [x.platform, x]));
    $('#ov-stats').replaceChildren(
      stat(num(d.live.online), 'online now', 'live'),
      stat(`${num(d.live.byClient.app)} / ${num(d.live.byClient.web)}`, 'app / website'),
      stat(num(d.live.streaming), 'streaming now', 'live'),
      stat(d.live.bandwidthMbps + ' Mbps', 'video going out'),
      stat(num(d.registeredUsers), 'registered accounts'),
      stat(num(dl.android?.today || 0), 'APK downloads today'),
      stat(num(d.storage?.assets?.ready || 0), 'stored videos ready'),
      stat(`${d.providers.on} on · ${d.providers.off} off`, 'providers'));
    const s = d.server;
    facts('#ov-server', [
      ['Uptime', duration(s.uptimeSeconds)], ['Load (1/5/15 min)', s.load.join(' / ') + ` on ${s.cpus} CPUs`],
      ['Memory', `${num(s.memory.usedMb)} / ${num(s.memory.totalMb)} MB (backend ${num(s.memory.backendMb)} MB)`],
      ['Disk free', s.disk ? `${s.disk.freeGb} of ${s.disk.totalGb} GB` : '—'], ['Conversions running', num(s.conversions)], ['Node', s.node]]);
    const a = d.autoArchive || {};
    facts('#ov-app', [
      ['Android version', d.app ? `${d.app.version} (build ${d.app.versionCode})` : '—'], ['Release notes', d.app?.notes || '—'],
      ['APK downloads (all time)', num(dl.android?.total || 0)], ['Windows downloads (all time)', num(dl.windows?.total || 0)],
      ['Auto-archive', a.enabled ? `on · ${a.phase || 'idle'}${a.current ? ' · ' + (a.current.imdbId || '') : ''}` : 'off']]);
  }

  // ---------- live ----------
  async function live() {
    const d = await api('/admin/panel/live');
    $('#live-stats').replaceChildren(stat(num(d.online), 'online now', 'live'), stat(num(d.byClient.app), 'in the app'), stat(num(d.byClient.web), 'on the website'),
      stat(num(d.byClient.desktop || 0), 'Windows app'), stat(num(d.streaming), 'streaming', 'live'), stat(d.bandwidthMbps + ' Mbps', 'video going out'));
    table('#live-streams', ['Viewer', 'Country', 'Client', 'Watching', 'Type', 'Speed', 'Sent', 'For'],
      d.streams.map(s => [td(s.ip, 'mono'), flag(s.country), el('span', { class: 'tag ' + s.client }, s.client), what(s.watching), s.kind,
        td(s.mbps + ' Mbps', 'num'), td(bytes(s.bytes), 'num'), td(since(s.startedAt), 'num')]), 'Nobody is streaming right now.');
    table('#live-visitors', ['IP', 'Country', 'Client', 'Last page', 'Watching', 'Requests', 'Online for', 'Last seen'],
      d.visitors.map(v => [td(v.ip, 'mono'), flag(v.country), el('span', { class: 'tag ' + v.client }, v.client), td(v.path || '—', 'mono'), what(v.watching),
        td(num(v.requests), 'num'), td(since(v.firstSeen), 'num'), td(ago(v.lastSeen), 'num')]), 'Nobody online in the last 2 minutes.');
  }

  // ---------- downloads ----------
  async function downloads() {
    const d = await api('/admin/panel/downloads');
    const t = Object.fromEntries(d.totals.map(x => [x.platform, x]));
    const a = t.android || {}, w = t.windows || {};
    $('#dl-stats').replaceChildren(stat(num(a.live || 0), 'APK in the last 10 min', 'live'), stat(num(a.today || 0), 'APK today'), stat(num(a.week || 0), 'APK this week'),
      stat(num(a.total || 0), 'APK all time'), stat(num(a.people || 0), 'different IPs (APK)'), stat(num(w.total || 0), 'Windows all time'));
    const days = [];
    for (let i = 13; i >= 0; i--) { const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); days.push({ day, total: d.days.find(x => x.day === day)?.total || 0 }); }
    const max = Math.max(1, ...days.map(x => x.total));
    $('#dl-days').replaceChildren(...days.map(x => el('div', { class: 'bar', title: `${x.day}: ${x.total}` }, el('em', {}, x.total || ''), el('i', { style: `height:${Math.round(x.total / max * 100)}%` }), el('small', {}, x.day.slice(8)))));
    table('#dl-versions', ['Platform', 'Version', 'From', 'Downloads'], d.versions.map(v => [v.platform, v.version, v.source, td(num(v.total), 'num')]));
    table('#dl-countries', ['Country', 'Downloads'], d.countries.map(c => [flag(c.country), td(num(c.total), 'num')]));
    table('#dl-recent', ['When', 'IP', 'Country', 'Platform', 'Version', 'From', 'Device'],
      d.recent.map(r => [td(ago(r.created_at), 'num'), td(r.ip, 'mono'), flag(r.country), r.platform, r.version || '—', r.source, td((r.user_agent || '—').slice(0, 70), 'mono')]),
      'No downloads counted yet. New downloads are counted from now on.');
    table('#dl-github', ['Release', 'File', 'Size', 'Downloads'], d.github.flatMap(r => r.files.map(f => [r.tag, td(f.name, 'mono'), td(f.sizeMb + ' MB', 'num'), td(num(f.downloads), 'num')])), 'GitHub counts are not available right now.');
  }

  // ---------- providers ----------
  async function providers() {
    const d = await api('/admin/panel/providers');
    table('#providers', ['On', 'Provider', 'Kind', 'Weekly check', 'Tries since restart', 'Changed'], d.data.map(p => {
      const toggle = el('button', { class: 'toggle', role: 'switch', 'aria-checked': String(p.on), 'aria-label': (p.on ? 'Turn off ' : 'Turn on ') + p.label });
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try { const r = await api('/admin/panel/providers/' + encodeURIComponent(p.id), { method: 'POST', body: { on: !p.on } }); say(`${p.label} is now ${r.on ? 'on' : 'off'}.`); await providers(); }
        catch (error) { say(error.message); toggle.disabled = false; }
      });
      const rate = p.attempts ? `${p.successes}/${p.attempts} found sources` : '—';
      return [toggle, el('span', {}, el('b', {}, p.label), p.label !== p.id ? el('div', { class: 'mono', style: 'color:var(--muted)' }, p.id) : null), p.kind,
        el('span', { class: 'tag ' + (p.weeklyCheck === 'failed' ? 'bad' : p.weeklyCheck === 'passed' ? 'good' : '') }, p.weeklyCheck), td(rate, 'num'), td(p.changedAt ? ago(p.changedAt) : '—', 'num')];
    }));
  }

  // ---------- storage ----------
  let storageQuery = '';
  async function storage() {
    const [summary, list, queue] = await Promise.all([api('/admin/storage/summary'), api('/admin/storage/assets' + storageQuery), api('/admin/storage/auto-archive')]);
    const c = summary.counts || {};
    $('#st-stats').replaceChildren(stat(num(c.assets?.ready || 0), 'ready'), stat(num(c.assets?.failed || 0), 'failed'), stat(num(c.assets?.unavailable || 0), 'unavailable'),
      stat(bytes(c.readyBytes || 0), 'stored'), stat(summary.telegram?.localBotApiReachable ? 'Yes' : 'No', 'Telegram server reachable'), stat(num(queue.counts?.downloadsLast24h || 0), 'auto-saves in 24 h'));
    const act = (asset, name, label, confirmText, body) => el('button', { class: 'ghost' + (name === 'unavailable' ? ' danger' : ''), onclick: async () => {
      if (confirmText && !confirm(confirmText)) return;
      try { await api(`/admin/storage/assets/${asset.id}/${name}`, { method: 'POST', body: body || {} }); say(`${label}: done for ${asset.title || asset.imdbId}.`); await storage(); }
      catch (error) { say(`${label} failed: ${error.message}`); }
    } }, label);
    table('#st-assets', ['Title', 'Quality', 'Length', 'Size', 'State', 'Added', ''], list.data.map(a => [
      el('span', {}, el('b', {}, a.title || '—'), el('div', { class: 'mono', style: 'color:var(--muted)' }, a.imdbId + (a.season != null ? ` S${a.season}E${a.episode}` : ''))),
      a.quality, td(duration(a.durationSeconds), 'num'), td(bytes(a.totalSize), 'num'),
      el('span', { class: 'tag ' + (a.state === 'ready' ? 'good' : ['failed', 'unavailable'].includes(a.state) ? 'bad' : '') }, a.state + (a.isDefault ? ' · default' : '')),
      td(ago(a.createdAt), 'num'),
      el('div', { class: 'actions' }, act(a, 'verify', 'Check'),
        a.state === 'ready' ? act(a, 'unavailable', 'Hide', `Hide "${a.title || a.imdbId}"? It stops playing; the file stays in Telegram and can be restored.`) : null,
        a.state === 'unavailable' ? act(a, 'restore', 'Restore') : null,
        a.state === 'ready' && !a.isDefault ? act(a, 'default', 'Make default') : null,
        a.state === 'failed' ? act(a, 'retry', 'Retry') : null)]), 'No stored videos match.');
    const s = queue.status || {};
    $('#aa-status').textContent = s.enabled ? `Auto-archive is on (${s.phase || 'idle'}). Up to ${s.dailyLimit} downloads a day, after ${Math.round((s.minWatchSeconds || 0) / 60)} min of watching, max ${s.maxHeight}p.` : 'Auto-archive is off.';
    table('#aa-list', ['Title', 'Status', 'Reason', 'Tries', 'Updated', ''], queue.data.map(r => [
      td(r.imdbId + (r.season != null ? ` S${r.season}E${r.episode}` : ''), 'mono'),
      el('span', { class: 'tag ' + (r.status === 'done' ? 'good' : r.status === 'failed' ? 'bad' : '') }, r.status), r.reason || '—', td(num(r.attempts), 'num'), td(ago(r.updatedAt), 'num'),
      ['failed', 'skipped', 'done'].includes(r.status) ? el('button', { class: 'ghost', onclick: async () => {
        if (!confirm('Save this title again from the start?')) return;
        try { await api(`/admin/storage/auto-archive/${r.id}/retry`, { method: 'POST' }); say('Queued again.'); await storage(); } catch (error) { say(error.message); }
      } }, 'Try again') : '']), 'The queue is empty.');
  }
  $('#st-search').addEventListener('submit', event => {
    event.preventDefault();
    const params = new URLSearchParams();
    if ($('#st-q').value.trim()) params.set('q', $('#st-q').value.trim());
    if ($('#st-state').value) params.set('state', $('#st-state').value);
    storageQuery = params.toString() ? '?' + params : '';
    tick();
  });

  // ---------- catalogue ----------
  let selected = null;
  $('#cat-search').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const body = await api('/admin/catalogue?q=' + encodeURIComponent($('#cat-q').value));
      $('#cat-list').replaceChildren(...body.data.map(item => el('li', {}, el('button', { onclick: () => {
        selected = item.imdb_id;
        $('#cat-selected').textContent = `${item.title} · ${item.imdb_id}`;
        $('#cat-title').value = item.title; $('#cat-plot').value = ''; $('#cat-genres').value = '';
        $('#cat-edit').hidden = false;
      } }, `${item.title} · ${item.release_year || ''} · ${item.imdb_id}`))));
      say(body.data.length + ' titles found');
    } catch (error) { say(error.message); }
  });
  $('#cat-edit').addEventListener('submit', async event => {
    event.preventDefault();
    const patch = { title: $('#cat-title').value };
    if ($('#cat-plot').value.trim()) patch.plot = $('#cat-plot').value;
    if ($('#cat-genres').value.trim()) patch.genres = $('#cat-genres').value.split(',').map(x => x.trim()).filter(Boolean);
    try { await api('/admin/catalogue/' + selected, { method: 'PATCH', body: patch }); say('Changes saved.'); } catch (error) { say(error.message); }
  });

  // ---------- logs ----------
  async function logs() {
    const body = await api('/logs');
    const box = $('#logs');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.replaceChildren(...(body.data || []).map(line => el('div', { class: /ERROR|error|failed/.test(line) ? 'err' : '' }, line)));
    if (!body.data?.length) box.textContent = 'No log lines yet.';
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  if (token) start(); else signOut('');
})();
