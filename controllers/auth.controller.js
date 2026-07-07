const auth = require('../services/auth.service');
const sessions = require('../models/session.model');

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/admin/') && !next.startsWith('//')
    ? next : '/admin/projects';
}
function renderLogin(res, { status = 200, error = null, next = '' } = {}) {
  res.status(status).render('login', { error, next, configured: auth.isConfigured() });
}

function loginForm(req, res) {
  renderLogin(res, { next: typeof req.query.next === 'string' ? req.query.next : '' });
}

function login(req, res) {
  if (!auth.isConfigured()) return renderLogin(res, { status: 503, error: 'Admin credentials are not configured.' });
  const ip = req.ip;
  if (auth.isRateLimited(ip)) {
    return renderLogin(res, { status: 429, error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  const { username, password, next } = req.body || {};
  if (!auth.verifyCredentials(username, password)) {
    auth.recordFailure(ip);
    console.warn(`[auth] failed login attempt from ${ip}`);
    return renderLogin(res, { status: 401, error: 'Invalid credentials', next: next || '' });
  }
  auth.clearFailures(ip);
  const token = sessions.create();
  res.set('Set-Cookie', auth.sessionCookie(token));
  res.redirect(safeNext(next));
}

function logout(req, res) {
  const token = auth.tokenFromRequest(req);
  if (token) sessions.deleteByToken(token);
  res.set('Set-Cookie', auth.clearedSessionCookie());
  res.redirect('/admin/login');
}

module.exports = { loginForm, login, logout };
