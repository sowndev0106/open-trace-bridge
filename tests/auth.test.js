const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-password';

const request = require('supertest');
const { adminApp } = require('../server');
const { resetDbForTest, getDb } = require('../lib/db');
const sessions = require('../models/session.model');

beforeEach(() => {
  resetDbForTest();
});

test('session model: create returns a token that findValid resolves', () => {
  const token = sessions.create();
  assert.match(token, /^[0-9a-f]{64}$/);
  const row = sessions.findValid(token);
  assert.ok(row);
  // Only the hash is stored, never the raw token.
  assert.notStrictEqual(row.token_hash, token);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?').get(token).c, 0);
});

test('session model: findValid rejects unknown, empty, and expired tokens', () => {
  assert.strictEqual(sessions.findValid('nope'), null);
  assert.strictEqual(sessions.findValid(''), null);
  assert.strictEqual(sessions.findValid(undefined), null);

  const token = sessions.create();
  getDb().prepare(`UPDATE sessions SET expires_at = datetime('now', '-1 minute')`).run();
  assert.strictEqual(sessions.findValid(token), null);
});

test('session model: touch extends expiry, deleteByToken removes, deleteExpired purges', () => {
  const token = sessions.create();
  const row = sessions.findValid(token);
  getDb().prepare(`UPDATE sessions SET expires_at = datetime('now', '+1 minute') WHERE id = ?`).run(row.id);
  sessions.touch(row.id);
  const after = sessions.findValid(token);
  assert.ok(after.expires_at > row.created_at);

  sessions.deleteByToken(token);
  assert.strictEqual(sessions.findValid(token), null);

  sessions.create();
  getDb().prepare(`UPDATE sessions SET expires_at = datetime('now', '-1 hour')`).run();
  assert.strictEqual(sessions.deleteExpired(), 1);
});

const auth = require('../services/auth.service');

test('auth service: verifyCredentials checks env credentials in constant time', () => {
  const u = process.env.ADMIN_USERNAME; const p = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  try {
    assert.strictEqual(auth.isConfigured(), true);
    assert.strictEqual(auth.verifyCredentials('admin', 'correct horse battery staple'), true);
    assert.strictEqual(auth.verifyCredentials('admin', 'wrong'), false);
    assert.strictEqual(auth.verifyCredentials('other', 'correct horse battery staple'), false);
    assert.strictEqual(auth.verifyCredentials('', ''), false);
  } finally {
    process.env.ADMIN_USERNAME = u; process.env.ADMIN_PASSWORD = p;
  }
});

test('auth service: fails closed when credentials are not configured', () => {
  const u = process.env.ADMIN_USERNAME; const p = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  try {
    assert.strictEqual(auth.isConfigured(), false);
    assert.strictEqual(auth.verifyCredentials('', ''), false);
    assert.strictEqual(auth.verifyCredentials(undefined, undefined), false);
  } finally {
    process.env.ADMIN_USERNAME = u; process.env.ADMIN_PASSWORD = p;
  }
});

test('auth service: rate limiter blocks after 5 failures and can be cleared', () => {
  auth.resetRateLimitForTest();
  const ip = '10.0.0.9';
  for (let i = 0; i < 4; i++) auth.recordFailure(ip);
  assert.strictEqual(auth.isRateLimited(ip), false);
  auth.recordFailure(ip);
  assert.strictEqual(auth.isRateLimited(ip), true);
  assert.strictEqual(auth.isRateLimited('10.0.0.10'), false);
  auth.clearFailures(ip);
  assert.strictEqual(auth.isRateLimited(ip), false);
});

test('auth service: session cookie helpers', () => {
  const cookie = auth.sessionCookie('abc123');
  assert.match(cookie, /^otb_session=abc123; /);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/); // COOKIE_SECURE not set in tests

  const cleared = auth.clearedSessionCookie();
  assert.match(cleared, /^otb_session=; /);
  assert.match(cleared, /Max-Age=0/);

  assert.strictEqual(
    auth.tokenFromRequest({ headers: { cookie: 'foo=1; otb_session=tok%3D1; bar=2' } }),
    'tok=1'
  );
  assert.strictEqual(auth.tokenFromRequest({ headers: {} }), undefined);
});

test('unauthenticated GET /admin/projects redirects to login with next', async () => {
  const res = await request(adminApp).get('/admin/projects').expect(302);
  assert.strictEqual(res.headers.location, '/admin/login?next=%2Fadmin%2Fprojects');
});

test('unauthenticated POST under /admin returns 401 JSON', async () => {
  await request(adminApp).post('/admin/projects/1/sync').expect(401);
});

test('login page renders and login flow sets session cookie', async () => {
  auth.resetRateLimitForTest();
  const page = await request(adminApp).get('/admin/login').expect(200);
  assert.match(page.text, /Sign in/);

  const agent = request.agent(adminApp);
  const res = await agent.post('/admin/login').type('form')
    .send({ username: 'admin', password: 'test-password', next: '/admin/dashboard' })
    .expect(302);
  assert.strictEqual(res.headers.location, '/admin/dashboard');
  assert.match(res.headers['set-cookie'][0], /otb_session=/);
  await agent.get('/admin/projects').expect(200);
});

test('bad credentials get a generic error; 6th failure is rate limited', async () => {
  auth.resetRateLimitForTest();
  for (let i = 0; i < 5; i++) {
    const res = await request(adminApp).post('/admin/login').type('form')
      .send({ username: 'admin', password: 'nope' }).expect(401);
    assert.match(res.text, /Invalid credentials/);
  }
  await request(adminApp).post('/admin/login').type('form')
    .send({ username: 'admin', password: 'nope' }).expect(429);
  auth.resetRateLimitForTest();
});

test('unsafe next targets fall back to /admin/projects', async () => {
  auth.resetRateLimitForTest();
  const res = await request(adminApp).post('/admin/login').type('form')
    .send({ username: 'admin', password: 'test-password', next: 'https://evil.example/' })
    .expect(302);
  assert.strictEqual(res.headers.location, '/admin/projects');
});

test('logout clears the session', async () => {
  auth.resetRateLimitForTest();
  const agent = request.agent(adminApp);
  await agent.post('/admin/login').type('form')
    .send({ username: 'admin', password: 'test-password' }).expect(302);
  await agent.post('/admin/logout').expect(302);
  await agent.get('/admin/projects').expect(302); // back to login
});

test('cross-origin POST is rejected by the origin check', async () => {
  auth.resetRateLimitForTest();
  await request(adminApp).post('/admin/login')
    .set('Origin', 'https://evil.example')
    .type('form').send({ username: 'admin', password: 'test-password' })
    .expect(403);
});

test('/internal and /health bypass session auth', async () => {
  await request(adminApp).get('/health').expect(200);
  // /internal has its own token guard: forbidden, not redirected.
  await request(adminApp).post('/internal/call-api').send({}).expect(403);
});
