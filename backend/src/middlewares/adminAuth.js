const { timingSafeEqual } = require('crypto');
module.exports = (req, res, next) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Admin access is not configured' });
  const authorization = req.get('authorization') || '';
  let supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  // Browser navigation and same-origin dashboard polling use HTTP Basic.
  if (authorization.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString();
    supplied = decoded.slice(decoded.indexOf(':') + 1);
  }
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.set('WWW-Authenticate', 'Basic realm="CutCrew admin"');
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
};
