// Admin access: a signed-in admin panel session (cookie), or the server's
// ADMIN_TOKEN as a Bearer token for scripts. Sets req.admin.
const { timingSafeEqual } = require('crypto');
const COOKIE = 'cutcrew_admin';

const cookieOf = req => (req.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';

function tokenMatches(req) {
  const expected = process.env.ADMIN_TOKEN;
  const authorization = req.get('authorization') || '';
  if (!expected || !authorization.startsWith('Bearer ')) return false;
  const a = Buffer.from(authorization.slice(7)), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function adminAuth(req, res, next) {
  try {
    const session = cookieOf(req);
    if (session) {
      const admin = await require('../services/adminAccounts').fromSession(session);
      if (admin) { req.admin = admin; req.adminSession = session; return next(); }
    }
    if (tokenMatches(req)) { req.admin = { id: null, email: 'admin token', role: 'owner' }; return next(); }
  } catch (error) { return next(error); }
  res.status(401).json({ error: 'Admin sign-in required' });
}

module.exports = adminAuth;
module.exports.COOKIE = COOKIE;
module.exports.cookieOf = cookieOf;
module.exports.ownerOnly = (req, res, next) => (req.admin?.role === 'owner' ? next() : res.status(403).json({ error: 'OWNER_ONLY' }));
