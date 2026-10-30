// Short-lived playback tickets for Telegram-stored assets (Phase 3/4).
// A ticket names one immutable asset version, so a replacement import never
// changes the bytes of a playback that is already running.
const crypto = require('node:crypto');

// Separate key from provider media tickets (same secret, different purpose).
const key = crypto.createHmac('sha256', process.env.MEDIA_TOKEN_SECRET || crypto.randomBytes(32)).update('cutcrew-stored-media-v1').digest();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const b64 = buffer => buffer.toString('base64url');

function sign(assetId, { ttlMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  if (!UUID.test(assetId)) throw new Error('invalid asset id');
  const body = b64(Buffer.from(JSON.stringify({ a: assetId, e: now + ttlMs })));
  return `${body}.${b64(crypto.createHmac('sha256', key).update(body).digest())}`;
}

// Returns the asset ID, or null for any invalid, tampered or expired ticket.
function verify(ticket, { now = Date.now() } = {}) {
  if (typeof ticket !== 'string' || ticket.length > 512) return null;
  const [body, mac] = ticket.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!UUID.test(data.a) || !Number.isSafeInteger(data.e) || data.e < now) return null;
    return data.a;
  } catch { return null; }
}

module.exports = { sign, verify };
