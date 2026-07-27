const crypto = require('crypto');

const COOKIE_NAME = 'tp_session';
const SESSION_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // 400 days — the practical cap browsers enforce on cookie lifetime

const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('SESSION_SECRET not set — using a random in-memory secret; all sessions will be invalidated on restart.');
  return crypto.randomBytes(32).toString('hex');
})();

function sign(expiry) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(expiry)).digest('hex');
}

function createSessionToken() {
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  return `${expiry}.${sign(expiry)}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expiryStr, hmac] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  const expected = sign(expiry);
  const a = Buffer.from(hmac, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Login attempt limiting — no user accounts exist (a single shared APP_PASSWORD),
// so "blocking a user" means blocking the source IP. In-memory and permanent:
// a blocked IP stays blocked until the process restarts, by design (no auto-expiry,
// no persistence across restarts).
const MAX_LOGIN_ATTEMPTS = 2;
const failedLoginAttempts = new Map(); // ip -> consecutive failed attempts
const blockedIps = new Set();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function isIpBlocked(ip) {
  return blockedIps.has(ip);
}

function recordFailedLogin(ip) {
  const attempts = (failedLoginAttempts.get(ip) || 0) + 1;
  failedLoginAttempts.set(ip, attempts);
  if (attempts >= MAX_LOGIN_ATTEMPTS) blockedIps.add(ip);
}

function recordSuccessfulLogin(ip) {
  failedLoginAttempts.delete(ip);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  });
  return out;
}

function requireAuth(req, res, next) {
  if (!process.env.APP_PASSWORD) return next(); // dev-convenience: open if no password configured
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionToken(cookies[COOKIE_NAME])) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

function robotsTagMiddleware(req, res, next) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  createSessionToken,
  verifySessionToken,
  requireAuth,
  robotsTagMiddleware,
  parseCookies,
  getClientIp,
  isIpBlocked,
  recordFailedLogin,
  recordSuccessfulLogin,
};
