const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const accounts = require('../src/services/adminAccounts');
const app = require('../src/app');

let server, root;
const OWNER = { email: 'Owner@Example.test', password: 'Synthetic-owner-pass-1' };
before(async () => {
  await db({ embedded: true });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  root = 'http://127.0.0.1:' + server.address().port + '/api/admin';
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });

async function call(path, { method = 'GET', body, cookie, header = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (header) headers['X-CutCrew-Admin'] = '1';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(root + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await response.json(); } catch { /* empty */ }
  return { status: response.status, data, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
}
const signIn = async (email, password) => call('/auth/login', { method: 'POST', body: { email, password } });

test('the owner command creates the owner with a hashed password, and sets a new one later', async () => {
  const first = await accounts.setOwner(OWNER);
  assert.equal(first.created, true);
  assert.equal(first.admin.email, 'owner@example.test');
  assert.equal(first.admin.role, 'owner');
  const row = (await db.query('SELECT password_hash FROM admin_users WHERE email = $1', ['owner@example.test'])).rows[0];
  assert.match(row.password_hash, /^scrypt:/);
  assert.ok(!row.password_hash.includes(OWNER.password));
  await assert.rejects(accounts.setOwner({ email: OWNER.email, password: 'short' }), /PASSWORD_TOO_SHORT/);
});

test('sign-in sets an HttpOnly session cookie; wrong passwords and missing header are refused', async () => {
  assert.equal((await signIn(OWNER.email, 'Wrong-password-123')).status, 401);
  assert.equal((await signIn('nobody@example.test', OWNER.password)).status, 401);
  assert.equal((await call('/auth/login', { method: 'POST', body: OWNER, header: false })).status, 403);
  const response = await fetch(root + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CutCrew-Admin': '1' }, body: JSON.stringify(OWNER) });
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /cutcrew_admin=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(';')[0];
  const me = await call('/auth/me', { cookie });
  assert.equal(me.data.admin.role, 'owner');
  assert.equal((await call('/panel/providers', { cookie })).status, 200);
  assert.equal((await call('/panel/providers')).status, 401);
});

test('the owner adds an admin, who can use the panel but cannot manage admins; removed admins lose access', async () => {
  const owner = (await signIn(OWNER.email, OWNER.password)).cookie;
  assert.equal((await call('/admins', { method: 'POST', cookie: owner, body: { email: 'helper@example.test', password: 'short' } })).status, 400);
  const added = await call('/admins', { method: 'POST', cookie: owner, body: { email: 'Helper@Example.test', password: 'Synthetic-helper-pass-1' } });
  assert.equal(added.status, 201);
  assert.equal(added.data.admin.role, 'admin');
  assert.equal((await call('/admins', { method: 'POST', cookie: owner, body: { email: 'helper@example.test', password: 'Synthetic-helper-pass-2' } })).status, 409);

  const helper = (await signIn('helper@example.test', 'Synthetic-helper-pass-1')).cookie;
  assert.equal((await call('/panel/overview', { cookie: helper })).status, 200);
  assert.equal((await call('/admins', { cookie: helper })).status, 403);
  assert.equal((await call('/admins', { method: 'POST', cookie: helper, body: { email: 'x@example.test', password: 'Synthetic-x-pass-123' } })).status, 403);

  const list = await call('/admins', { cookie: owner });
  assert.deepEqual(list.data.data.map(a => a.email), ['owner@example.test', 'helper@example.test']);
  const ownerId = list.data.data[0].id;
  assert.equal((await call('/admins/' + ownerId, { method: 'DELETE', cookie: owner })).status, 409);
  assert.equal((await call('/admins/' + added.data.admin.id, { method: 'DELETE', cookie: owner })).status, 200);
  assert.equal((await call('/auth/me', { cookie: helper })).status, 401);
});

test('changing your own password needs the current one and signs out other devices', async () => {
  const phone = (await signIn(OWNER.email, OWNER.password)).cookie;
  const laptop = (await signIn(OWNER.email, OWNER.password)).cookie;
  assert.equal((await call('/auth/password', { method: 'POST', cookie: laptop, body: { current: 'Wrong-password-1', password: 'Synthetic-owner-pass-2' } })).status, 401);
  assert.equal((await call('/auth/password', { method: 'POST', cookie: laptop, body: { current: OWNER.password, password: 'Synthetic-owner-pass-2' } })).status, 200);
  assert.equal((await call('/auth/me', { cookie: laptop })).status, 200);
  assert.equal((await call('/auth/me', { cookie: phone })).status, 401);
  assert.equal((await call('/auth/logout', { method: 'POST', cookie: laptop })).status, 200);
  assert.equal((await call('/auth/me', { cookie: laptop })).status, 401);
});
