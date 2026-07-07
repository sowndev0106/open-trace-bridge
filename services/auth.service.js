const crypto = require('crypto');
const sessions = require('../models/session.model');

const COOKIE_NAME = 'otb_session';
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const COOKIE_MAX_AGE_S = sessions.TTL_DAYS * 24 * 60 * 60;

// ip -> { count, resetAt }; in-memory is fine for a single admin account.
const failures = new Map();

function isConfigured() {
  return Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD);
}

// Compare fixed-length digests so neither timing nor length leaks.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function verifyCredentials(username, password) {
  if (!isConfigured()) return false;
  const userOk = safeEqual(username || '', process.env.ADMIN_USERNAME);
  const passOk = safeEqual(password || '', process.env.ADMIN_PASSWORD);
  return userOk && passOk;
}

function isRateLimited(ip) {
  const entry = failures.get(ip);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILURES);
}
function recordFailure(ip) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || entry.resetAt <= now) failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}
function clearFailures(ip) { failures.delete(ip); }
function resetRateLimitForTest() { failures.clear(); }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function tokenFromRequest(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME];
}
function sessionCookie(token) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`;
}
function clearedSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function requireAuth(req, res, next) {
  if (!isConfigured()) {
    return res.status(503).send('Admin credentials are not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment.');
  }
  const session = sessions.findValid(tokenFromRequest(req));
  if (!session) {
    if (req.method === 'GET') {
      return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({ error: 'unauthorized' });
  }
  sessions.touch(session.id);
  req.adminSession = session;
  next();
}

// CSRF defense: SameSite=Lax cookie plus same-host Origin/Referer on writes.
// Requests without either header (curl, tests) are allowed through.
function originCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const source = req.get('origin') || req.get('referer');
  if (!source) return next();
  let host;
  try { host = new URL(source).host; } catch { return res.status(403).send('Malformed Origin header'); }
  if (host !== req.get('host')) return res.status(403).send('Cross-origin request rejected');
  next();
}

module.exports = {
  COOKIE_NAME, isConfigured, verifyCredentials,
  isRateLimited, recordFailure, clearFailures, resetRateLimitForTest,
  tokenFromRequest, sessionCookie, clearedSessionCookie,
  requireAuth, originCheck,
};
