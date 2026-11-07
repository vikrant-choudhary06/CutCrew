// Admin panel accounts (owner and admins) and their sign-in sessions.
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../config/db');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 7;
const MIN_PASSWORD = 10;
const cleanEmail = email => String(email || '').trim().toLowerCase();
const validEmail = email => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 200;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function checkPassword(password, stored) {
  const [version, salt, digest] = String(stored || '').split(':');
  if (version !== 'scrypt' || !salt || !/^[0-9a-f]{128}$/.test(digest || '')) return false;
  const actual = await scrypt(String(password), salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}
function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) throw fail('PASSWORD_TOO_SHORT');
}
const publicAdmin = row => row && { id: row.id, email: row.email, role: row.role, createdAt: row.created_at, lastLoginAt: row.last_login_at };

async function create({ email, password, role = 'admin', createdBy = null }) {
  email = cleanEmail(email);
  if (!validEmail(email)) throw fail('INVALID_EMAIL');
  checkNewPassword(password);
  if (!['owner', 'admin'].includes(role)) throw fail('INVALID_ROLE');
  try {
    const { rows } = await db.query('INSERT INTO admin_users (id, email, password_hash, role, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [crypto.randomUUID(), email, await hashPassword(password), role, createdBy]);
    return publicAdmin(rows[0]);
  } catch (error) { if (error.code === '23505') throw fail('EMAIL_TAKEN', 409); throw error; }
}

// Owner account from the command line: created, or its password reset.
async function setOwner({ email, password }) {
  email = cleanEmail(email);
  if (!validEmail(email)) throw fail('INVALID_EMAIL');
  checkNewPassword(password);
  const existing = (await db.query('SELECT * FROM admin_users WHERE email = $1', [email])).rows[0];
  if (!existing) return { created: true, admin: await create({ email, password, role: 'owner' }) };
  const { rows } = await db.query("UPDATE admin_users SET password_hash = $2, role = 'owner' WHERE id = $1 RETURNING *", [existing.id, await hashPassword(password)]);
  await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [existing.id]);
  return { created: false, admin: publicAdmin(rows[0]) };
}

const DUMMY = 'scrypt:00000000000000000000000000000000:' + '0'.repeat(128);
async function signIn({ email, password, ip }) {
  const row = (await db.query('SELECT * FROM admin_users WHERE email = $1', [cleanEmail(email)])).rows[0];
  // Check a hash even for unknown emails, so timing does not tell them apart.
  const ok = await checkPassword(password, row?.password_hash || DUMMY);
  if (!row || !ok) throw fail('WRONG_EMAIL_OR_PASSWORD', 401);
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO admin_sessions (token_hash, admin_id, expires_at, ip) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days', $3)`, [sha256(token), row.id, ip ? String(ip).slice(0, 64) : null]);
  await db.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [row.id]);
  await db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
  return { token, admin: publicAdmin(row), maxAgeMs: SESSION_DAYS * 86400000 };
}

async function fromSession(token) {
  if (!token || token.length > 100) return null;
  const { rows } = await db.query('SELECT u.* FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_id WHERE s.token_hash = $1 AND s.expires_at > now()', [sha256(token)]);
  return publicAdmin(rows[0]);
}
const signOut = token => token ? db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(token)]) : null;

async function list() {
  const { rows } = await db.query('SELECT * FROM admin_users ORDER BY role DESC, created_at');
  return rows.map(publicAdmin);
}
async function remove(id, by) {
  if (id === by.id) throw fail('CANNOT_REMOVE_YOURSELF', 409);
  const { rows } = await db.query("DELETE FROM admin_users WHERE id = $1 AND role <> 'owner' RETURNING id", [id]);
  if (!rows.length) throw fail('ADMIN_NOT_FOUND', 404);
}
async function setPassword(id, password, { keepSession } = {}) {
  checkNewPassword(password);
  const { rows } = await db.query('UPDATE admin_users SET password_hash = $2 WHERE id = $1 RETURNING id', [id, await hashPassword(password)]);
  if (!rows.length) throw fail('ADMIN_NOT_FOUND', 404);
  // Signed-in devices of that admin are signed out (except the one changing it).
  await db.query('DELETE FROM admin_sessions WHERE admin_id = $1 AND ($2::text IS NULL OR token_hash <> $2)', [id, keepSession ? sha256(keepSession) : null]);
}

async function passwordMatches(id, password) {
  const row = (await db.query('SELECT password_hash FROM admin_users WHERE id = $1', [id])).rows[0];
  return !!row && checkPassword(password, row.password_hash);
}

module.exports = { passwordMatches, create, setOwner, signIn, fromSession, signOut, list, remove, setPassword, checkPassword, hashPassword, cleanEmail, MIN_PASSWORD };
