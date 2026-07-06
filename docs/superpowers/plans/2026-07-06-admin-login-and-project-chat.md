# Admin Login + Per-Project Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-cookie login to the admin app and a per-project 1-1 chat page where the admin talks to the project's OpenCode agent with real-time SSE streaming.

**Architecture:** Single admin account from env vars; sessions stored hashed in SQLite so they survive restarts; auth middleware guards `/admin/*` (except login) on the admin app only. Chat reuses the existing `conversations`/`messages`/`runs` tables with the synthetic channel id `admin-ui`; `opencode.service` gains an incremental stream parser so tool steps and text chunks flow to the browser over an SSE response to the send-message POST.

**Tech Stack:** Express 4, EJS, better-sqlite3, Tailwind v4 (compiled via `npm run build:css`), `node --test` + supertest + cheerio, vanilla JS + `marked`/`DOMPurify` from CDN on the chat page. **No new npm runtime dependencies.**

Spec: `docs/superpowers/specs/2026-07-06-admin-login-and-project-chat-design.md`

## Global Constraints

- Everything in English: code, comments, UI strings, tests, docs (project rule).
- No secrets in commits; `.env` stays untracked (project rule).
- Two-port boundary: public app (`PORT`) untouched; auth applies only to the admin app; `/internal/*` keeps its existing `x-otb-internal-token` guard and must NOT go through session auth.
- No new npm dependencies (runtime or dev).
- Run tests with `npm test` (runs `node --test 'tests/*.test.js'`).
- Session cookie name: `otb_session`. Admin chat channel constant: `admin-ui`. Session TTL: 7 days sliding. Login rate limit: 5 failures / 15 min / IP.

---

### Task 1: Sessions table and session model

**Files:**
- Modify: `lib/db.js` (append to `SCHEMA` string, after the `runs` table)
- Create: `models/session.model.js`
- Test: `tests/auth.test.js` (new file)

**Interfaces:**
- Produces: `sessions.create() -> token:string`, `sessions.findValid(token) -> row|null`, `sessions.touch(id)`, `sessions.deleteByToken(token)`, `sessions.deleteExpired() -> number`

- [ ] **Step 1: Write the failing tests**

Create `tests/auth.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/auth.test.js`
Expected: FAIL with `Cannot find module '../models/session.model'`

- [ ] **Step 3: Add the sessions table to the schema**

In `lib/db.js`, inside the `SCHEMA` template string, after the `runs` table definition (before the closing backtick), add:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
```

No `migrations` array entry is needed — `CREATE TABLE IF NOT EXISTS` covers existing databases.

- [ ] **Step 4: Implement the model**

Create `models/session.model.js`:

```js
const crypto = require('crypto');
const { getDb } = require('../lib/db');

const TTL_DAYS = 7;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function create() {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare(
    `INSERT INTO sessions (token_hash, expires_at) VALUES (?, datetime('now', '+${TTL_DAYS} days'))`
  ).run(hashToken(token));
  return token;
}
function findValid(token) {
  if (!token) return null;
  return getDb().prepare(
    `SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')`
  ).get(hashToken(token)) || null;
}
function touch(id) {
  getDb().prepare(
    `UPDATE sessions SET expires_at = datetime('now', '+${TTL_DAYS} days') WHERE id = ?`
  ).run(id);
}
function deleteByToken(token) {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}
function deleteExpired() {
  return getDb().prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run().changes;
}

module.exports = { create, findValid, touch, deleteByToken, deleteExpired, TTL_DAYS };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/auth.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/db.js models/session.model.js tests/auth.test.js
git commit -m "feat: add sessions table and session model for admin login"
```

---

### Task 2: Auth service — credential check, rate limiter, cookies

**Files:**
- Create: `services/auth.service.js`
- Test: `tests/auth.test.js` (append)

**Interfaces:**
- Consumes: `models/session.model.js` (Task 1)
- Produces (all from `services/auth.service.js`):
  - `isConfigured() -> boolean`
  - `verifyCredentials(username, password) -> boolean`
  - `isRateLimited(ip) -> boolean`, `recordFailure(ip)`, `clearFailures(ip)`, `resetRateLimitForTest()`
  - `tokenFromRequest(req) -> string|undefined`
  - `sessionCookie(token) -> string`, `clearedSessionCookie() -> string`, `COOKIE_NAME = 'otb_session'`
  - `requireAuth(req, res, next)` middleware, `originCheck(req, res, next)` middleware

- [ ] **Step 1: Write the failing tests**

Append to `tests/auth.test.js`:

```js
const auth = require('../services/auth.service');

test('auth service: verifyCredentials checks env credentials in constant time', () => {
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  assert.strictEqual(auth.isConfigured(), true);
  assert.strictEqual(auth.verifyCredentials('admin', 'correct horse battery staple'), true);
  assert.strictEqual(auth.verifyCredentials('admin', 'wrong'), false);
  assert.strictEqual(auth.verifyCredentials('other', 'correct horse battery staple'), false);
  assert.strictEqual(auth.verifyCredentials('', ''), false);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/auth.test.js`
Expected: FAIL with `Cannot find module '../services/auth.service'`

- [ ] **Step 3: Implement the service**

Create `services/auth.service.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/auth.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add services/auth.service.js tests/auth.test.js
git commit -m "feat: auth service with constant-time credential check and login rate limit"
```

---

### Task 3: Login/logout routes, login page, and admin app wiring

**Files:**
- Create: `controllers/auth.controller.js`, `routes/auth.routes.js`, `views/login.ejs`, `tests/helpers/auth.js`
- Modify: `server.js:23-35` (admin app section), `routes/admin.routes.js`, `views/layout-head.ejs` (nav), `.env.example`, `docker-compose.yml` (environment block)
- Modify: `tests/adminUi.test.js`, `tests/dashboard.test.js` (authenticate via agent)
- Test: `tests/auth.test.js` (append HTTP-level tests)

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  - `GET /admin/login`, `POST /admin/login` (form fields `username`, `password`, hidden `next`), `POST /admin/logout`
  - `tests/helpers/auth.js` exporting `loginAgent(app) -> Promise<supertest.Agent>` — every later admin-app test uses this.
  - Env vars `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `COOKIE_SECURE` documented.

- [ ] **Step 1: Write the failing HTTP tests**

Append to `tests/auth.test.js` (note: `supertest` and the apps are new imports at the top of the file):

```js
// Add to the imports at the top of tests/auth.test.js:
const request = require('supertest');
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-password';
const { adminApp } = require('../server');
```

```js
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
    assert.doesNotMatch(res.text, /username|password is wrong/i);
  }
  await request(adminApp).post('/admin/login').type('form')
    .send({ username: 'admin', password: 'nope' }).expect(429);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/auth.test.js`
Expected: FAIL — redirects don't happen yet (200 instead of 302), `/admin/login` is 404.

- [ ] **Step 3: Implement controller, routes, and view**

Create `controllers/auth.controller.js`:

```js
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
```

Create `routes/auth.routes.js`:

```js
const router = require('express').Router();
const ac = require('../controllers/auth.controller');

router.get('/login', ac.loginForm);
router.post('/login', ac.login);

module.exports = router;
```

Add to `routes/admin.routes.js` (with the other requires and routes):

```js
const ac = require('../controllers/auth.controller');
router.post('/logout', ac.logout);
```

Create `views/login.ejs` (standalone page, not using the admin layout):

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in - OpenTraceBridge</title>
  <link rel="stylesheet" href="/assets/styles/admin.css">
</head>
<body>
  <main class="min-h-screen flex items-center justify-center bg-ink-50 px-4">
    <form method="post" action="/admin/login" class="panel w-full max-w-sm p-8 flex flex-col gap-4">
      <div class="flex items-center gap-3">
        <span class="brand-mark">OT</span>
        <span>
          <span class="block text-sm font-semibold text-ink-950">OpenTraceBridge</span>
          <span class="block text-xs text-ink-500">Admin console sign in</span>
        </span>
      </div>
      <% if (!configured) { %>
        <p class="text-sm text-red-600">Admin credentials are not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment.</p>
      <% } %>
      <% if (error) { %>
        <p class="text-sm text-red-600" role="alert"><%= error %></p>
      <% } %>
      <input type="hidden" name="next" value="<%= next %>">
      <label class="block text-sm">
        <span class="text-ink-700">Username</span>
        <input name="username" autocomplete="username" required autofocus>
      </label>
      <label class="block text-sm">
        <span class="text-ink-700">Password</span>
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <button type="submit" class="btn" <%= configured ? '' : 'disabled' %>>Sign in</button>
    </form>
  </main>
</body>
</html>
```

(Match the input styling used by `views/projects/form.ejs` — reuse whatever input classes that file applies.)

- [ ] **Step 4: Wire the admin app in `server.js`**

Replace the admin app section (currently lines 23-35) with:

```js
// Private admin app: dashboard and internal call-api.
const auth = require('./services/auth.service');
const adminApp = express();
adminApp.use(express.json({ limit: '1mb' }));
adminApp.use(express.urlencoded({ extended: true }));
adminApp.set('view engine', 'ejs');
adminApp.set('views', path.join(__dirname, 'views'));
adminApp.use('/assets', express.static(path.join(__dirname, 'public')));
adminApp.use(logger);
adminApp.get('/health', (req, res) => res.json({ status: 'ok', scope: 'admin' }));
adminApp.use('/internal', require('./routes/internal.routes')); // token-guarded, no session auth
adminApp.get('/', (req, res) => res.redirect('/admin/projects'));
adminApp.use('/admin', auth.originCheck);
adminApp.use('/admin', require('./routes/auth.routes')); // login: reachable without a session
adminApp.use('/admin', auth.requireAuth);
adminApp.use('/admin', require('./routes/admin.routes'));
adminApp.use(notFound);
```

Add the logout button to `views/layout-head.ejs` inside the `<nav>` after the Projects link:

```html
<form method="post" action="/admin/logout" class="inline">
  <button type="submit" class="nav-link">Logout</button>
</form>
```

- [ ] **Step 5: Create the shared test login helper and fix existing admin tests**

Create `tests/helpers/auth.js`:

```js
const request = require('supertest');

process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-password';

// Returns a supertest agent holding a valid admin session cookie.
// Call after resetDbForTest(): sessions live in the DB.
async function loginAgent(app) {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form')
    .send({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
    .expect(302);
  return agent;
}

module.exports = { loginAgent };
```

Note: the `node --test 'tests/*.test.js'` glob does not match `tests/helpers/`, so the helper is not run as a test file.

Update `tests/adminUi.test.js` and `tests/dashboard.test.js`:
1. Add `const { loginAgent } = require('./helpers/auth');` **before** `require('../server')` so the env credentials are set when the app loads.
2. In each file declare `let agent;` and extend `beforeEach`:
   ```js
   beforeEach(async () => {
     resetDbForTest();
     agent = await loginAgent(adminApp);
   });
   ```
3. Replace every `request(adminApp)` call with `agent` (e.g. `await agent.get('/admin/projects').expect(200)`). Plain asset requests like `/assets/styles/admin.css` may keep `request(adminApp)` — static files are not auth-guarded.

- [ ] **Step 6: Run the full suite and rebuild CSS**

Run: `npm test`
Expected: PASS — new auth tests and all previously existing tests.

Run: `npm run build:css` — the login page uses Tailwind utilities that must land in the compiled `public/styles/admin.css`.

- [ ] **Step 7: Document the env vars**

Append to `.env.example`:

```bash
# Admin UI login (required). The admin UI refuses to serve pages until both are set.
ADMIN_USERNAME=
ADMIN_PASSWORD=

# Set to "true" when the admin UI is served over HTTPS so the session cookie is Secure-only.
# COOKIE_SECURE=true
```

In `docker-compose.yml`, add to the `environment:` list:

```yaml
      - ADMIN_USERNAME=${ADMIN_USERNAME:-}
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
      - COOKIE_SECURE=${COOKIE_SECURE:-}
```

- [ ] **Step 8: Commit**

```bash
git add server.js routes/auth.routes.js routes/admin.routes.js controllers/auth.controller.js \
  views/login.ejs views/layout-head.ejs tests/helpers/auth.js tests/adminUi.test.js \
  tests/dashboard.test.js tests/auth.test.js .env.example docker-compose.yml public/styles/admin.css
git commit -m "feat: session-cookie login protecting the admin UI"
```

---

### Task 4: Retention job purges expired sessions

**Files:**
- Modify: `services/retention.service.js`
- Test: `tests/retention.test.js` (append)

**Interfaces:**
- Consumes: `sessions.deleteExpired()` (Task 1)
- Produces: `runRetentionCleanup()` result gains `sessionsDeleted: number`

- [ ] **Step 1: Write the failing test**

Append to `tests/retention.test.js` (follow the existing test setup in that file — `OTB_DB_PATH=':memory:'`, `resetDbForTest()` in `beforeEach`):

```js
const sessionModel = require('../models/session.model');
const { getDb: getDbForSessions } = require('../lib/db');

test('retention cleanup deletes expired sessions regardless of projects', () => {
  sessionModel.create();
  sessionModel.create();
  getDbForSessions().prepare(`UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id = 1`).run();

  const result = runRetentionCleanup();
  assert.strictEqual(result.sessionsDeleted, 1);
  assert.strictEqual(getDbForSessions().prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);
});
```

(Adapt the import names to how `tests/retention.test.js` already imports `runRetentionCleanup` and asserts.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/retention.test.js`
Expected: FAIL — `result.sessionsDeleted` is `undefined`.

- [ ] **Step 3: Implement**

In `services/retention.service.js`:
- Add `const sessions = require('../models/session.model');` to the requires.
- In `runRetentionCleanup`, before the project loop add `const sessionsDeleted = sessions.deleteExpired();` and include `sessionsDeleted` in the returned object.
- In `startRetentionJob`'s log condition, also log when `result.sessionsDeleted` is non-zero (add `sessions=${result.sessionsDeleted}` to the log line).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/retention.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/retention.service.js tests/retention.test.js
git commit -m "feat: purge expired admin sessions in the retention job"
```

---

### Task 5: Streaming parser and `runPromptStream` in opencode.service

**Files:**
- Modify: `services/opencode.service.js` (full rewrite of internals, same exports plus new ones)
- Test: `tests/opencode-stream.test.js` (new), existing `tests/opencode-parse.test.js` and `tests/opencode-run.test.js` must keep passing unchanged.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `runPromptStream({ dir, sessionId, text, conversationId, onEvent }) -> Promise<{ sessionId, text, usage }>` — same resolve shape as `runPrompt`. `onEvent` receives, in stream order:
    - `{ type: 'session', sessionId: string }`
    - `{ type: 'text', text: string }` (one per text chunk)
    - `{ type: 'tool', name: string, status: string }`
  - `runPrompt(opts)` — unchanged behavior, now implemented as `runPromptStream` without `onEvent`.
  - `parseRunOutput(stdout)` — unchanged behavior (kept for existing tests).

- [ ] **Step 1: Write the failing tests**

Create `tests/opencode-stream.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const opencode = require('../services/opencode.service');

function fakeChildDeferred() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test('runPromptStream emits session, tool, and text events as chunks arrive, split mid-line', async () => {
  const events = [];
  const orig = opencode.proc.spawn;
  let child;
  opencode.proc.spawn = () => { child = fakeChildDeferred(); return child; };
  try {
    const promise = opencode.runPromptStream({
      dir: '/tmp/ws/payment', text: 'hi',
      onEvent: (ev) => events.push(ev),
    });
    // Feed output split at arbitrary byte boundaries, including mid-JSON.
    child.stdout.emit('data', '{"type":"text","sessionID":"ses_1","part":{"type":"text","te');
    child.stdout.emit('data', 'xt":"Hello "}}\n{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"call_api","state":{"status":"running"}}}\n');
    child.stdout.emit('data', '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"world"}}\n');
    child.stdout.emit('data', '{"type":"step_finish","part":{"tokens":{"input":10,"output":5,"reasoning":1},"cost":0.01}}\n');
    child.emit('close', 0);
    const result = await promise;

    assert.deepStrictEqual(events[0], { type: 'session', sessionId: 'ses_1' });
    assert.deepStrictEqual(events[1], { type: 'text', text: 'Hello ' });
    assert.deepStrictEqual(events[2], { type: 'tool', name: 'call_api', status: 'running' });
    assert.deepStrictEqual(events[3], { type: 'text', text: 'world' });
    assert.strictEqual(result.text, 'Hello world');
    assert.strictEqual(result.sessionId, 'ses_1');
    assert.deepStrictEqual(result.usage, { tokensInput: 10, tokensOutput: 5, tokensReasoning: 1, costUsd: 0.01 });
  } finally {
    opencode.proc.spawn = orig;
  }
});

test('runPromptStream rejects on nonzero exit and does not require onEvent', async () => {
  const orig = opencode.proc.spawn;
  let child;
  opencode.proc.spawn = () => { child = fakeChildDeferred(); return child; };
  try {
    const promise = opencode.runPromptStream({ dir: '/tmp/ws/payment', text: 'hi' });
    child.stderr.emit('data', 'boom');
    child.emit('close', 1);
    await assert.rejects(promise, /opencode exit 1: boom/);
  } finally {
    opencode.proc.spawn = orig;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/opencode-stream.test.js`
Expected: FAIL with `opencode.runPromptStream is not a function`

- [ ] **Step 3: Refactor the service**

Rewrite `services/opencode.service.js` — keep the file header, `TIMEOUT_MS`, `proc`, `emptyUsage`, and the spawn comments exactly as they are, and restructure the rest:

```js
// Incremental parser over opencode's JSON-lines output. push() consumes raw
// chunks (which may split lines arbitrarily); finish() flushes and returns
// the aggregate result. parseRunOutput and runPromptStream share this.
function createStreamParser(onEvent = () => {}) {
  let buffer = '';
  let sessionId = null;
  const chunks = [];
  let sawUsage = false;
  const usage = { tokensInput: 0, tokensOutput: 0, tokensReasoning: 0, costUsd: 0 };

  function handleLine(line) {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!sessionId && ev.sessionID) {
      sessionId = ev.sessionID;
      onEvent({ type: 'session', sessionId });
    }
    if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
      chunks.push(ev.part.text);
      onEvent({ type: 'text', text: ev.part.text });
    }
    if (ev.part && ev.part.type === 'tool' && ev.part.tool) {
      onEvent({ type: 'tool', name: ev.part.tool, status: (ev.part.state && ev.part.state.status) || '' });
    }
    if (ev.type === 'step_finish' && ev.part && ev.part.tokens) {
      sawUsage = true;
      usage.tokensInput += ev.part.tokens.input || 0;
      usage.tokensOutput += ev.part.tokens.output || 0;
      usage.tokensReasoning += ev.part.tokens.reasoning || 0;
      usage.costUsd += ev.part.cost || 0;
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    },
    finish() {
      if (buffer) handleLine(buffer);
      buffer = '';
      return { sessionId, text: chunks.join(''), usage: sawUsage ? usage : emptyUsage() };
    },
  };
}

function parseRunOutput(stdout) {
  const parser = createStreamParser();
  parser.push(String(stdout));
  return parser.finish();
}

function runPromptStream({ dir, sessionId, text, conversationId, onEvent }) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--format', 'json'];
    if (sessionId) args.push('-s', sessionId);
    args.push(text);
    // (keep the existing stdin/PWD/OTB_CONVERSATION_ID comments here verbatim)
    const env = { ...process.env, PWD: dir };
    if (conversationId != null) env.OTB_CONVERSATION_ID = String(conversationId);
    else delete env.OTB_CONVERSATION_ID;
    const child = proc.spawn('opencode', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });

    const parser = createStreamParser(onEvent);
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`opencode timed out after ${TIMEOUT_MS / 60000} minutes`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => parser.push(String(d)));
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`opencode exit ${code}: ${stderr.slice(0, 500)}`));
      const parsed = parser.finish();
      if (!parsed.sessionId) return reject(new Error(`Could not parse sessionID from opencode output`));
      resolve(parsed);
    });
  });
}

function runPrompt(opts) {
  return runPromptStream(opts);
}

module.exports = { parseRunOutput, runPrompt, runPromptStream, proc };
```

**Implementation note on tool events:** the `part.type === 'tool'` / `part.tool` / `part.state.status` shape should be verified against a real `opencode run --format json` invocation when possible; if the real shape differs, adjust the matcher (the UI only needs a tool name and a status string). The tests encode the shape we handle; unknown events are ignored by design.

- [ ] **Step 4: Run the streaming tests and the existing opencode tests**

Run: `node --test tests/opencode-stream.test.js tests/opencode-parse.test.js tests/opencode-run.test.js tests/eventController.test.js`
Expected: ALL PASS — `runPrompt` and `parseRunOutput` behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add services/opencode.service.js tests/opencode-stream.test.js
git commit -m "feat: incremental stream parser and runPromptStream in opencode service"
```

---

### Task 6: Chat controller — SSE message endpoint, lock, new-conversation

**Files:**
- Create: `controllers/chat.controller.js`
- Modify: `routes/admin.routes.js`
- Test: `tests/chat.test.js` (new)

**Interfaces:**
- Consumes: `opencode.runPromptStream` (Task 5), `sync.ensureReady`, `convs`/`messages`/`runs` models, `loginAgent` helper (Task 3).
- Produces:
  - `GET /admin/projects/:id/chat` — renders `projects/chat` with `{ project, messages, busy }`
  - `POST /admin/projects/:id/chat/messages` — body `{ text }`; SSE response with events `tool`, `text`, `done`, `error`; `409 { error: 'busy' }` when a run is active; `400` on empty text
  - `POST /admin/projects/:id/chat/new` — closes the active admin conversation, redirects to the chat page
  - Constant `ADMIN_CHANNEL = 'admin-ui'` (exported for tests)

- [ ] **Step 1: Write the failing tests**

Create `tests/chat.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';

const { loginAgent } = require('./helpers/auth'); // sets ADMIN_USERNAME/PASSWORD before server loads
const { adminApp } = require('../server');
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const runs = require('../models/run.model');
const sync = require('../services/sync.service');
const opencode = require('../services/opencode.service');
const { ADMIN_CHANNEL } = require('../controllers/chat.controller');

let agent;
let project;
beforeEach(async () => {
  resetDbForTest();
  project = projects.create({ slug: 'payment', name: 'Payment', keyword: 'payment-bot',
    system_prompt: 'x', teams_webhook_url: 'https://hook.example/x', max_msg_length: 20000 });
  agent = await loginAgent(adminApp);
  sync.ensureReady = async () => '/tmp/ws-payment';
});

test('chat page renders empty state, requires auth', async () => {
  const res = await agent.get(`/admin/projects/${project.id}/chat`).expect(200);
  assert.match(res.text, /Payment/);
  assert.match(res.text, /chat-history/);

  const request = require('supertest');
  await request(adminApp).get(`/admin/projects/${project.id}/chat`).expect(302);
});

test('posting a message streams SSE events and persists messages + run', async () => {
  opencode.runPromptStream = async ({ dir, text, conversationId, onEvent }) => {
    assert.strictEqual(dir, '/tmp/ws-payment');
    assert.strictEqual(text, 'why did txn_9 fail?');
    assert.ok(conversationId);
    onEvent({ type: 'tool', name: 'call_api', status: 'running' });
    onEvent({ type: 'text', text: 'because ' });
    onEvent({ type: 'text', text: 'of X' });
    return { sessionId: 'ses_1', text: 'because of X',
      usage: { tokensInput: 10, tokensOutput: 5, tokensReasoning: 0, costUsd: 0.02 } };
  };

  const res = await agent.post(`/admin/projects/${project.id}/chat/messages`)
    .send({ text: 'why did txn_9 fail?' })
    .expect(200)
    .expect('Content-Type', /text\/event-stream/);

  assert.match(res.text, /event: tool\ndata: {"name":"call_api","status":"running"}/);
  assert.match(res.text, /event: text\ndata: {"text":"because "}/);
  assert.match(res.text, /event: done\n/);
  assert.match(res.text, /"costUsd":0.02/);

  const conv = convs.findActive(project.id, ADMIN_CHANNEL);
  assert.ok(conv);
  assert.strictEqual(conv.opencode_session_id, 'ses_1');
  const rows = messages.listByConversation(conv.id);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].direction, 'in');
  assert.strictEqual(rows[1].content, 'because of X');
  const run = runs.listByProject ? runs.listByProject(project.id)[0]
    : require('../lib/db').getDb().prepare('SELECT * FROM runs WHERE project_id = ?').get(project.id);
  assert.strictEqual(run.status, 'success');
});

test('agent errors produce an error event and an error run row', async () => {
  opencode.runPromptStream = async () => { throw new Error('opencode exit 1: boom'); };
  const res = await agent.post(`/admin/projects/${project.id}/chat/messages`)
    .send({ text: 'hello' }).expect(200);
  assert.match(res.text, /event: error\n/);
  const run = require('../lib/db').getDb().prepare('SELECT * FROM runs WHERE project_id = ?').get(project.id);
  assert.strictEqual(run.status, 'error');
});

test('concurrent message for the same project is rejected with 409', async () => {
  let release;
  opencode.runPromptStream = async () => {
    await new Promise((r) => { release = r; });
    return { sessionId: 'ses_1', text: 'ok', usage: { tokensInput: 0, tokensOutput: 0, tokensReasoning: 0, costUsd: 0 } };
  };
  const first = agent.post(`/admin/projects/${project.id}/chat/messages`).send({ text: 'one' });
  const firstPromise = first.then((r) => r); // start it
  await new Promise((r) => setTimeout(r, 50)); // let the lock engage
  await agent.post(`/admin/projects/${project.id}/chat/messages`).send({ text: 'two' }).expect(409);
  release();
  await firstPromise;
});

test('empty text is a 400; new conversation closes the active one', async () => {
  await agent.post(`/admin/projects/${project.id}/chat/messages`).send({ text: '   ' }).expect(400);

  const conv = convs.create(project.id, ADMIN_CHANNEL);
  await agent.post(`/admin/projects/${project.id}/chat/new`).expect(302);
  assert.strictEqual(convs.findActive(project.id, ADMIN_CHANNEL), undefined);
  assert.strictEqual(require('../lib/db').getDb()
    .prepare('SELECT status FROM conversations WHERE id = ?').get(conv.id).status, 'closed');
});
```

(If `runs.listByProject` does not exist, use the direct-SQL fallback shown; do not add model functions the app does not need.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/chat.test.js`
Expected: FAIL with `Cannot find module '../controllers/chat.controller'`

- [ ] **Step 3: Implement the controller**

Create `controllers/chat.controller.js`:

```js
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const runs = require('../models/run.model');
const sync = require('../services/sync.service');
const opencode = require('../services/opencode.service');

// Synthetic channel id marking admin-UI chats in the conversations table.
const ADMIN_CHANNEL = 'admin-ui';

// Project ids with a chat run in flight. One run per project at a time.
const activeRuns = new Set();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chatPage(req, res) {
  const project = projects.findById(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const conv = convs.findActive(project.id, ADMIN_CHANNEL);
  res.render('projects/chat', {
    project,
    chatMessages: conv ? messages.listByConversation(conv.id) : [],
    busy: activeRuns.has(project.id),
  });
}

async function postMessage(req, res) {
  const project = projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (activeRuns.has(project.id)) return res.status(409).json({ error: 'busy' });
  activeRuns.add(project.id);

  let conv = convs.findActive(project.id, ADMIN_CHANNEL);
  if (!conv) conv = convs.create(project.id, ADMIN_CHANNEL);
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: 'admin', user_name: 'Admin', content: text });

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (res.flushHeaders) res.flushHeaders();

  const startedAt = Date.now();
  try {
    const ws = await sync.ensureReady(project);
    const result = await opencode.runPromptStream({
      dir: ws, sessionId: conv.opencode_session_id, text, conversationId: conv.id,
      onEvent: (ev) => {
        if (ev.type === 'tool') sseSend(res, 'tool', { name: ev.name, status: ev.status });
        if (ev.type === 'text') sseSend(res, 'text', { text: ev.text });
      },
    });
    if (!conv.opencode_session_id) convs.setSession(conv.id, result.sessionId);
    const replyText = result.text || '(agent returned no text)';
    messages.add({ conversation_id: conv.id, direction: 'out', content: replyText });
    const usage = result.usage || {};
    const durationMs = Date.now() - startedAt;
    runs.add({
      project_id: project.id, conversation_id: conv.id, status: 'success',
      duration_ms: durationMs,
      tokens_input: usage.tokensInput ?? null, tokens_output: usage.tokensOutput ?? null,
      tokens_reasoning: usage.tokensReasoning ?? null, cost_usd: usage.costUsd ?? null,
    });
    sseSend(res, 'done', { text: replyText, durationMs, usage });
  } catch (err) {
    const isTimeout = /timeout|timed out/i.test(err.message);
    runs.add({
      project_id: project.id, conversation_id: conv.id,
      status: isTimeout ? 'timeout' : 'error',
      duration_ms: Date.now() - startedAt,
      error: err.message.slice(0, 1000),
    });
    messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
    sseSend(res, 'error', { message: err.message });
  } finally {
    activeRuns.delete(project.id);
    res.end();
  }
}

function newConversation(req, res) {
  const project = projects.findById(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const conv = convs.findActive(project.id, ADMIN_CHANNEL);
  if (conv) convs.close(conv.id);
  res.redirect(`/admin/projects/${project.id}/chat`);
}

module.exports = { chatPage, postMessage, newConversation, ADMIN_CHANNEL };
```

Note: the run completes and persists even if the browser disconnects mid-stream — `res.write` on a closed response does not throw in Express; the finally block always releases the lock.

Add to `routes/admin.routes.js`:

```js
const chat = require('../controllers/chat.controller');
router.get('/projects/:id/chat', chat.chatPage);
router.post('/projects/:id/chat/messages', chat.postMessage);
router.post('/projects/:id/chat/new', chat.newConversation);
```

- [ ] **Step 4: Create a minimal placeholder view so the page test can pass**

The full UI is Task 7; for now create `views/projects/chat.ejs` with just enough structure:

```html
<%- include('../layout-head') %>
<section class="panel" id="chat-root"
  data-project-id="<%= project.id %>"
  data-busy="<%= busy ? '1' : '0' %>">
  <h1><%= project.name %></h1>
  <script type="application/json" id="chat-history"><%- JSON.stringify(chatMessages).replace(/</g, '\\u003c') %></script>
</section>
<%- include('../layout-foot') %>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/chat.test.js`
Expected: PASS (5 tests)

Then run: `npm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add controllers/chat.controller.js routes/admin.routes.js views/projects/chat.ejs tests/chat.test.js
git commit -m "feat: per-project admin chat endpoints with SSE streaming"
```

---

### Task 7: Chat UI — full page, client streaming, entry links, CSS

**Files:**
- Modify: `views/projects/chat.ejs` (replace placeholder), `views/projects/list.ejs` (Chat action per row), `views/projects/form.ejs` (Chat link in the page header area), `assets/styles/admin.css` (chat styles)
- Test: `tests/chat.test.js` (append), `tests/adminUi.test.js` (Chat link assertion)
- Run: `npm run build:css`

**Interfaces:**
- Consumes: endpoints from Task 6; `chatMessages` / `busy` view locals.
- Produces: user-facing chat page. No JS module exports — everything is inline in the EJS view.

- [ ] **Step 1: Write the failing tests**

Append to `tests/chat.test.js`:

```js
test('chat page renders history JSON, composer, and new-conversation button', async () => {
  const conv = convs.create(project.id, ADMIN_CHANNEL);
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: 'admin', user_name: 'Admin', content: 'q1' });
  messages.add({ conversation_id: conv.id, direction: 'out', content: '**bold answer**' });

  const res = await agent.get(`/admin/projects/${project.id}/chat`).expect(200);
  assert.match(res.text, /id="chat-history"/);
  assert.match(res.text, /bold answer/);
  assert.match(res.text, /id="chat-input"/);
  assert.match(res.text, /chat\/new/);
  assert.match(res.text, /marked/); // markdown renderer CDN
  assert.match(res.text, /purify/i); // DOMPurify CDN
});
```

Append to the project-list test area in `tests/adminUi.test.js` (inside an existing test that loads `/admin/projects`, or a new one):

```js
test('projects index links to the per-project chat page', async () => {
  const project = seedProject();
  const response = await agent.get('/admin/projects').expect(200);
  const $ = cheerio.load(response.text);
  assert.ok($(`a[href="/admin/projects/${project.id}/chat"]`).length >= 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/chat.test.js tests/adminUi.test.js`
Expected: FAIL — no `chat-input`, no chat link on the index.

- [ ] **Step 3: Build the chat view**

Replace `views/projects/chat.ejs` with:

```html
<%- include('../layout-head') %>
<section class="chat-shell" id="chat-root"
  data-project-id="<%= project.id %>"
  data-busy="<%= busy ? '1' : '0' %>">

  <header class="flex items-center justify-between gap-3 mb-4">
    <div class="flex items-center gap-3">
      <a class="btn" href="/admin/projects/<%= project.id %>/edit">&larr; Back</a>
      <div>
        <h1 class="text-lg font-semibold text-ink-950"><%= project.name %> — Agent chat</h1>
        <p class="text-xs text-ink-500">Talks directly to this project's OpenCode agent.</p>
      </div>
    </div>
    <form method="post" action="/admin/projects/<%= project.id %>/chat/new"
      onsubmit="return confirm('Close this conversation and start a new one?');">
      <button type="submit" class="btn">New conversation</button>
    </form>
  </header>

  <div class="panel chat-panel">
    <div id="chat-messages" class="chat-messages" aria-live="polite"></div>
    <div id="chat-busy-banner" class="chat-banner hidden">
      The agent is still working on a previous message — reload shortly.
    </div>
    <form id="chat-form" class="chat-composer">
      <textarea id="chat-input" rows="2" placeholder="Ask the agent… (Enter to send, Shift+Enter for a new line)"></textarea>
      <button type="submit" id="chat-send" class="btn">Send</button>
    </form>
  </div>

  <script type="application/json" id="chat-history"><%- JSON.stringify(chatMessages).replace(/</g, '\\u003c') %></script>
</section>

<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.5/dist/purify.min.js"></script>
<script>
(function () {
  const root = document.getElementById('chat-root');
  const projectId = root.dataset.projectId;
  const list = document.getElementById('chat-messages');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const busyBanner = document.getElementById('chat-busy-banner');

  function renderMarkdown(el, text) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  }
  function addBubble(direction, content) {
    const wrap = document.createElement('div');
    wrap.className = direction === 'in' ? 'chat-row chat-row-user' : 'chat-row chat-row-agent';
    const bubble = document.createElement('div');
    bubble.className = direction === 'in' ? 'chat-bubble chat-bubble-user' : 'chat-bubble chat-bubble-agent';
    if (direction === 'in') bubble.textContent = content;
    else renderMarkdown(bubble, content);
    wrap.appendChild(bubble);
    list.appendChild(wrap);
    list.scrollTop = list.scrollHeight;
    return bubble;
  }
  function addMeta(bubble, text) {
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = text;
    bubble.appendChild(meta);
  }
  function setBusy(busy) {
    input.disabled = busy;
    sendBtn.disabled = busy;
  }

  // Render persisted history.
  const history = JSON.parse(document.getElementById('chat-history').textContent || '[]');
  history.forEach((m) => addBubble(m.direction, m.content));
  if (root.dataset.busy === '1') { busyBanner.classList.remove('hidden'); setBusy(true); }

  // Minimal SSE-over-fetch reader: emits {event, data} per "\n\n" frame.
  async function readSse(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) onEvent(event, JSON.parse(data));
      }
    }
  }

  async function send(text) {
    setBusy(true);
    addBubble('in', text);
    const agentBubble = addBubble('out', '');
    const status = document.createElement('div');
    status.className = 'chat-status';
    status.textContent = 'Starting agent…';
    agentBubble.appendChild(status);
    let acc = '';
    try {
      const res = await fetch(`/admin/projects/${projectId}/chat/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.status === 409) { status.textContent = 'A run is already in progress for this project.'; return; }
      if (res.status === 401) { window.location = '/admin/login'; return; }
      if (!res.ok) { status.textContent = `Request failed (${res.status}).`; return; }
      await readSse(res, (event, data) => {
        if (event === 'tool') status.textContent = `Running ${data.name}${data.status ? ` (${data.status})` : ''}…`;
        if (event === 'text') {
          acc += data.text;
          status.remove();
          renderMarkdown(agentBubble, acc);
          list.scrollTop = list.scrollHeight;
        }
        if (event === 'done') {
          renderMarkdown(agentBubble, data.text || acc);
          const u = data.usage || {};
          const parts = [`${Math.round(data.durationMs / 1000)}s`];
          if (u.tokensInput != null) parts.push(`${((u.tokensInput || 0) + (u.tokensOutput || 0)).toLocaleString()} tok`);
          if (u.costUsd != null) parts.push(`$${Number(u.costUsd).toFixed(4)}`);
          addMeta(agentBubble, parts.join(' · '));
        }
        if (event === 'error') {
          status.remove();
          agentBubble.classList.add('chat-bubble-error');
          agentBubble.textContent = `Error: ${data.message}`;
        }
      });
    } catch (err) {
      agentBubble.classList.add('chat-bubble-error');
      agentBubble.textContent = `Connection lost: ${err.message}. The run may still finish — reload to see the result.`;
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || input.disabled) return;
    input.value = '';
    send(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
})();
</script>
<%- include('../layout-foot') %>
```

- [ ] **Step 4: Add chat styles and rebuild CSS**

Append to `assets/styles/admin.css` (adjust color tokens to the palette already used in that file):

```css
/* Per-project agent chat */
.chat-shell { display: flex; flex-direction: column; min-height: calc(100vh - 8rem); }
.chat-panel { display: flex; flex-direction: column; flex: 1; min-height: 24rem; }
.chat-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.75rem; padding: 1rem 0.25rem; }
.chat-row { display: flex; }
.chat-row-user { justify-content: flex-end; }
.chat-row-agent { justify-content: flex-start; }
.chat-bubble { max-width: 46rem; border-radius: 0.75rem; padding: 0.625rem 0.875rem; font-size: 0.875rem; line-height: 1.5; }
.chat-bubble-user { background: var(--color-ink-950, #111827); color: #fff; white-space: pre-wrap; }
.chat-bubble-agent { background: var(--color-ink-100, #f3f4f6); color: var(--color-ink-950, #111827); }
.chat-bubble-agent pre { overflow-x: auto; padding: 0.5rem; border-radius: 0.375rem; background: #111827; color: #f9fafb; }
.chat-bubble-error { background: #fef2f2; color: #b91c1c; }
.chat-status { font-size: 0.75rem; color: var(--color-ink-500, #6b7280); font-style: italic; }
.chat-meta { margin-top: 0.375rem; font-size: 0.6875rem; color: var(--color-ink-500, #6b7280); }
.chat-banner { margin: 0.5rem 0; padding: 0.5rem 0.75rem; border-radius: 0.5rem; background: #fffbeb; color: #92400e; font-size: 0.8125rem; }
.chat-composer { display: flex; gap: 0.5rem; align-items: flex-end; padding-top: 0.75rem; border-top: 1px solid var(--color-ink-200, #e5e7eb); }
.chat-composer textarea { flex: 1; resize: none; }
.hidden { display: none; }
```

Run: `npm run build:css`
Expected: `public/styles/admin.css` regenerated without errors.

- [ ] **Step 5: Add entry links**

In `views/projects/list.ejs`, add a Chat action alongside the existing per-row actions (match the existing action markup/classes exactly — look at how the Edit link is rendered and copy its pattern):

```html
<a class="btn" href="/admin/projects/<%= p.id %>/chat">Chat</a>
```

(Use whatever loop variable name the file already uses for the project row.)

In `views/projects/form.ejs`, add the same link near the page title / actions area for existing projects (only when editing, i.e. the project has an id — follow how the form distinguishes new vs edit).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add views/projects/chat.ejs views/projects/list.ejs views/projects/form.ejs \
  assets/styles/admin.css public/styles/admin.css tests/chat.test.js tests/adminUi.test.js
git commit -m "feat: chat UI with live streaming, markdown rendering, and entry links"
```

---

### Task 8: README, final verification

**Files:**
- Modify: `README.md`
- No new tests; full-suite and manual verification.

- [ ] **Step 1: Update README**

- In the "What It Does" list add: `- Provides a per-project admin chat page that talks to the project's OpenCode agent with live streaming.`
- In the Configuration table add rows for `ADMIN_USERNAME`, `ADMIN_PASSWORD` (required; admin UI refuses to serve pages until both are set) and `COOKIE_SECURE` (set `true` behind HTTPS).
- In "Admin Setup" add a step 0: configure `ADMIN_USERNAME`/`ADMIN_PASSWORD` and sign in at `http://localhost:8667/admin/login`.
- Add a short "Admin chat" paragraph: open **Chat** from a project row to talk to the agent directly; messages, runs, and costs are recorded exactly like Teams conversations under the synthetic conversation id `admin-ui`; **New conversation** starts a fresh OpenCode session.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 3: Manual verification (requires local opencode)**

1. Set `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env`, run `npm start`.
2. Visit `http://localhost:8667/admin/projects` — expect a redirect to the login page; sign in; confirm the Logout button appears and works.
3. Open Chat on a project with a synced workspace; send a question; confirm tool steps and text stream live, and the usage line appears when done.
4. Reload the page — history is still there. Click New conversation — history is empty, next message starts a fresh session.
5. Verify a real `opencode run --format json` emits tool events matching the parser's `part.type === 'tool'` shape; adjust `createStreamParser` and its test fixture if the shape differs.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document admin login and per-project agent chat"
```
