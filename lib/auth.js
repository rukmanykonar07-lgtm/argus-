// scrypt (built into Node's crypto) does what bcrypt does — slow, salted,
// tunable password hashing — without adding a native-module dependency.
// Sessions are random opaque tokens in an in-memory Map, not JWTs — there's
// nothing here that needs to be self-verifying across services, so a JWT
// library would just be more code doing the same job as `Map.get(token)`.
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const target = Buffer.from(hash, 'hex');
  // timingSafeEqual needs equal-length buffers or it throws — guard that
  // instead of letting a malformed stored hash crash the login route.
  if (check.length !== target.length) return false;
  return crypto.timingSafeEqual(check, target);
}

// ponytail: sessions live in memory only, so a server restart logs
// everyone out. Fine for a tool that runs on one machine and restarts
// rarely — upgrade path: persist {token: {userId, expires}} into the same
// JSON store if restarts-without-relogin ever becomes an actual complaint.
const sessions = new Map();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}

function destroySession(token) {
  sessions.delete(token);
}

// Minimal cookie parsing — one line, doesn't need the cookie-parser
// dependency for a single opaque session-token cookie.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

module.exports = { hashPassword, verifyPassword, createSession, getSession, destroySession, parseCookies };
