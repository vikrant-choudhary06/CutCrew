// Admin panel sign-in (/api/admin/auth) and the owner's admin list
// (/api/admin/admins). Sign-in sets an HttpOnly cookie for this site only.
const express = require('express');
const accounts = require('../services/adminAccounts');
const adminAuth = require('../middlewares/adminAuth');
const live = require('../services/liveActivity');

const json = express.json({ limit: '4kb' });
const needsHeader = (req, res, next) => (req.get('x-cutcrew-admin') === '1' ? next() : res.status(403).json({ error: 'ADMIN_ACTION_HEADER_REQUIRED' }));
const fail = (res, error) => res.status(error.status || 500).json({ error: error.status ? error.code : 'ADMIN_ACCOUNTS_FAILED' });
const cookieOptions = maxAge => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api', ...(maxAge ? { maxAge } : {}) });

// 10 tries per 15 minutes for each IP and for each email.
const attempts = new Map();
function limited(keys) {
  const now = Date.now();
  if (attempts.size > 10000) for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
  let blocked = false;
  for (const key of keys) {
    const record = attempts.get(key);
    if (record && record.until > now && record.count >= 10) blocked = true;
    attempts.set(key, record && record.until > now ? { ...record, count: record.count + 1 } : { until: now + 900000, count: 1 });
  }
  return blocked;
}

const auth = express.Router();
auth.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
auth.post('/login', needsHeader, json, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'EMAIL_AND_PASSWORD_REQUIRED' });
  const ip = live.cleanIp(req.ip);
  if (limited(['ip:' + ip, 'email:' + accounts.cleanEmail(email)])) return res.status(429).json({ error: 'TOO_MANY_TRIES' });
  try {
    const { token, admin, maxAgeMs } = await accounts.signIn({ email, password, ip });
    attempts.delete('ip:' + ip); attempts.delete('email:' + accounts.cleanEmail(email));
    console.warn(JSON.stringify({ event: 'admin-signed-in', email: admin.email }));
    res.cookie(adminAuth.COOKIE, token, cookieOptions(maxAgeMs)).json({ admin });
  } catch (error) { fail(res, error); }
});
auth.post('/logout', needsHeader, async (req, res) => {
  await accounts.signOut(adminAuth.cookieOf(req))?.catch(() => {});
  res.clearCookie(adminAuth.COOKIE, cookieOptions()).json({ ok: true });
});
auth.get('/me', adminAuth, (req, res) => res.json({ admin: req.admin }));
// Any admin: change their own password (needs the current one).
auth.post('/password', needsHeader, adminAuth, json, async (req, res) => {
  const { current, password } = req.body || {};
  if (!req.admin.id) return res.status(400).json({ error: 'SIGN_IN_WITH_EMAIL_FIRST' });
  try {
    if (!(await accounts.passwordMatches(req.admin.id, String(current || '')))) return res.status(401).json({ error: 'CURRENT_PASSWORD_WRONG' });
    await accounts.setPassword(req.admin.id, password, { keepSession: req.adminSession });
    res.json({ ok: true });
  } catch (error) { fail(res, error); }
});

// Owner only: list, add and remove admins, and set a new password for one.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validId = (req, res, next) => (UUID.test(req.params.id) ? next() : res.status(400).json({ error: 'INVALID_ADMIN_ID' }));
const admins = express.Router();
admins.use(adminAuth, adminAuth.ownerOnly, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
admins.get('/', async (_req, res) => { try { res.json({ data: await accounts.list() }); } catch (error) { fail(res, error); } });
admins.post('/', needsHeader, json, async (req, res) => {
  try {
    const admin = await accounts.create({ email: req.body?.email, password: req.body?.password, role: 'admin', createdBy: req.admin.id });
    console.warn(JSON.stringify({ event: 'admin-added', email: admin.email, by: req.admin.email }));
    res.status(201).json({ admin });
  } catch (error) { fail(res, error); }
});
admins.delete('/:id', needsHeader, validId, async (req, res) => {
  try {
    await accounts.remove(req.params.id, req.admin);
    console.warn(JSON.stringify({ event: 'admin-removed', id: req.params.id, by: req.admin.email }));
    res.json({ ok: true });
  } catch (error) { fail(res, error); }
});
admins.post('/:id/password', needsHeader, validId, json, async (req, res) => {
  try { await accounts.setPassword(req.params.id, req.body?.password, { keepSession: req.params.id === req.admin.id ? req.adminSession : null }); res.json({ ok: true }); }
  catch (error) { fail(res, error); }
});

module.exports = { auth, admins };
