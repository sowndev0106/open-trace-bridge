# Per-Project Internal Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the cross-project data leak in `/internal/call-api` by giving every project its own internal token and rejecting any request where the token does not match the `slug` in the request body.

**Architecture:** Today `getInternalToken()` in `services/workspace.service.js` returns one process-wide secret shared by every project's `opencode.json`, and `routes/internal.routes.js` only checks "is this *a* valid token" before trusting `slug` from the request body to pick the project. This plan adds a `project_tokens` table (hash-only, one row per project, mirroring `sessions`), a `models/projectToken.model.js` to read/write it, changes `workspace.service.js` to mint/reuse one token per project (still cached in a plaintext file so `opencode.json` can be rewritten repeatedly without rotating the token), and changes the `/internal/call-api` handler to resolve the project from the token and require it to equal the project resolved from `slug`.

**Tech Stack:** Node.js, Express, better-sqlite3, `node:test` + `supertest`.

## Global Constraints

- Write everything in English: source, comments, strings, tests. (project CLAUDE.md)
- Never commit `.env`, tokens, keys, or workspace data. (project CLAUDE.md — the `data/` and `workspaces/` dirs are already gitignored; this plan writes token files under `data/internal-tokens/`, which inherits that.)
- Preserve the two-port boundary: `/internal/call-api` stays on the private admin app only; this plan does not change which app serves it. (project CLAUDE.md)
- Hash tokens before storing them in the DB, the same way `models/session.model.js` does (SHA-256, `crypto.timingSafeEqual` not required here because we do an exact hash lookup, not a comparison of two secrets we hold).

---

## File Structure

- `lib/db.js` — add a `project_tokens` table to `SCHEMA` (one row per project, FK cascade like `repos`/`api_groups`).
- `models/projectToken.model.js` — new file: `setToken(projectId, token)` (upsert-by-hash), `findProjectIdByToken(token)`.
- `services/workspace.service.js` — replace the single global `getInternalToken()` with `getInternalTokenForProject(project)`, which reuses a per-project plaintext file on disk and always upserts its hash into `project_tokens` (so DB and file can never drift out of sync).
- `routes/internal.routes.js` — resolve the project id from the token, resolve the project from `slug`, and require the two to match before calling `executeApiCall`.
- `tests/models.test.js` — unit tests for `projectToken.model.js`.
- `tests/workspace.test.js` — update the existing `buildOpencodeConfig` test to use a DB-backed project (the new code path writes to `project_tokens`, which has a real FK to `projects`), and add a test proving two projects get two distinct tokens.
- `tests/workspaceSync.test.js` — same DB-backed-project fix for the one test that exercises `writeWorkspaceFiles`.
- `tests/internalRoutes.test.js` — new file: end-to-end supertest coverage of the `/internal/call-api` guard, including the exact cross-project attack described in the report.

---

### Task 1: `project_tokens` table + model

**Files:**
- Modify: `lib/db.js:86-91` (insert new table right after the `sessions` table in `SCHEMA`)
- Create: `models/projectToken.model.js`
- Modify: `tests/models.test.js:1-12` (add import)
- Test: `tests/models.test.js` (append new tests)

**Interfaces:**
- Produces: `projectTokens.setToken(projectId: number, token: string): void` — hashes `token` with SHA-256 and upserts the row keyed by `project_id` (so calling it again for the same project just rewrites the hash — no unique-constraint error).
- Produces: `projectTokens.findProjectIdByToken(token: string | undefined): number | null` — returns the owning `project_id`, or `null` if `token` is falsy or unknown.
- Consumes: `getDb()` from `lib/db.js` (already exists).

- [ ] **Step 1: Write the failing tests**

Add to `tests/models.test.js`, right after the existing imports (after line 11):

```javascript
const projectTokens = require('../models/projectToken.model');
```

Append these tests at the end of the file:

```javascript
test('project_tokens: setToken/findProjectIdByToken scopes a token to one project', () => {
  const p1 = projects.create({ slug: 'proj-a', name: 'A', keyword: '', system_prompt: '', teams_webhook_url: '' });
  const p2 = projects.create({ slug: 'proj-b', name: 'B', keyword: '', system_prompt: '', teams_webhook_url: '' });
  projectTokens.setToken(p1.id, 'token-a');
  projectTokens.setToken(p2.id, 'token-b');
  assert.strictEqual(projectTokens.findProjectIdByToken('token-a'), p1.id);
  assert.strictEqual(projectTokens.findProjectIdByToken('token-b'), p2.id);
  assert.strictEqual(projectTokens.findProjectIdByToken('nope'), null);
  assert.strictEqual(projectTokens.findProjectIdByToken(undefined), null);
  assert.strictEqual(projectTokens.findProjectIdByToken(''), null);
});

test('project_tokens: setToken re-upserts the hash for the same project (no unique-constraint error)', () => {
  const p = projects.create({ slug: 'proj-c', name: 'C', keyword: '', system_prompt: '', teams_webhook_url: '' });
  projectTokens.setToken(p.id, 'first-token');
  projectTokens.setToken(p.id, 'second-token');
  assert.strictEqual(projectTokens.findProjectIdByToken('first-token'), null);
  assert.strictEqual(projectTokens.findProjectIdByToken('second-token'), p.id);
});

test('project_tokens: deleting a project cascades to its token row', () => {
  const p = projects.create({ slug: 'proj-d', name: 'D', keyword: '', system_prompt: '', teams_webhook_url: '' });
  projectTokens.setToken(p.id, 'tok-d');
  projects.remove(p.id);
  assert.strictEqual(projectTokens.findProjectIdByToken('tok-d'), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models.test.js`
Expected: FAIL — `Cannot find module '../models/projectToken.model'`

- [ ] **Step 3: Add the table to the schema**

In `lib/db.js`, the `SCHEMA` constant currently ends with the `sessions` table:

```javascript
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
`;
```

Change it to add a new table right after `sessions` and before the closing backtick:

```javascript
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_tokens (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
```

`CREATE TABLE IF NOT EXISTS` runs on every `getDb()` call (see `lib/db.js:103`), so existing databases pick up the new table automatically — no `ALTER TABLE` migration entry needed, matching how `sessions` itself was added.

- [ ] **Step 4: Write the model**

Create `models/projectToken.model.js`:

```javascript
const crypto = require('crypto');
const { getDb } = require('../lib/db');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// One row per project; re-calling this for the same project just rewrites
// the hash instead of erroring, since the caller may reuse an existing
// plaintext token across process restarts (see workspace.service.js).
function setToken(projectId, token) {
  getDb().prepare(
    `INSERT INTO project_tokens (project_id, token_hash) VALUES (?, ?)
     ON CONFLICT(project_id) DO UPDATE SET token_hash = excluded.token_hash`
  ).run(projectId, hashToken(token));
}

function findProjectIdByToken(token) {
  if (!token) return null;
  const row = getDb().prepare('SELECT project_id FROM project_tokens WHERE token_hash = ?').get(hashToken(token));
  return row ? row.project_id : null;
}

module.exports = { setToken, findProjectIdByToken };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/models.test.js`
Expected: PASS (all tests in the file, including the three new ones)

- [ ] **Step 6: Commit**

```bash
git add lib/db.js models/projectToken.model.js tests/models.test.js
git commit -m "feat: add per-project internal token storage"
```

---

### Task 2: Mint a per-project token in `workspace.service.js`

**Files:**
- Modify: `services/workspace.service.js:1-19` (imports + `getInternalToken`), `services/workspace.service.js:82-100` (`buildOpencodeConfig`), `services/workspace.service.js:175-178` (exports)
- Modify: `tests/workspace.test.js` (DB setup + the `buildOpencodeConfig` test)
- Modify: `tests/workspaceSync.test.js` (DB-backed project for the `writeWorkspaceFiles` test)

**Interfaces:**
- Consumes: `projectTokens.setToken(projectId, token)` and `projectTokens.findProjectIdByToken(token)` from Task 1.
- Produces: `getInternalTokenForProject(project: { id, slug }): string` — replaces `getInternalToken()` in the module's exports. Callers must pass a project that has already been persisted via `models/project.model.js` (real `id`), because the write goes through `project_tokens.project_id`, which has a foreign key to `projects(id)`.

- [ ] **Step 1: Write the failing tests**

Replace the top of `tests/workspace.test.js` (currently lines 1-11):

```javascript
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projectsModel = require('../models/project.model');
const projectTokens = require('../models/projectToken.model');
const { buildAgentsMd, buildOpencodeConfig, repoDirName } = require('../services/workspace.service');

beforeEach(() => resetDbForTest());

const project = { id: 1, slug: 'payment', name: 'Payment', keyword: 'payment-bot',
  system_prompt: 'You are an incident investigator.', teams_webhook_url: '' };
```

(This keeps the plain `project` literal for the DB-free `buildAgentsMd` tests below it — only `buildOpencodeConfig` touches the DB, so only that test needs a real row.)

Replace the existing `buildOpencodeConfig` test (currently lines 59-68):

```javascript
test('buildOpencodeConfig denies edit/bash/webfetch and wires mcp', () => {
  const p = projectsModel.create({ slug: 'payment', name: 'Payment', keyword: 'payment-bot',
    system_prompt: 'You are an incident investigator.', teams_webhook_url: '' });
  const cfg = buildOpencodeConfig(p);
  assert.strictEqual(cfg.permission.edit, 'deny');
  assert.strictEqual(cfg.permission.bash, 'deny');
  assert.strictEqual(cfg.permission.webfetch, 'deny');
  assert.strictEqual(cfg.mcp.otb.type, 'local');
  assert.ok(cfg.mcp.otb.command[1].endsWith('mcp/callapi-stdio.js'));
  assert.strictEqual(cfg.mcp.otb.environment.OTB_PROJECT_SLUG, 'payment');
  assert.ok(cfg.mcp.otb.environment.OTB_INTERNAL_TOKEN.length >= 32);
});

test('buildOpencodeConfig gives each project its own token, recorded in project_tokens', () => {
  const pA = projectsModel.create({ slug: 'proj-a', name: 'A', keyword: '', system_prompt: '', teams_webhook_url: '' });
  const pB = projectsModel.create({ slug: 'proj-b', name: 'B', keyword: '', system_prompt: '', teams_webhook_url: '' });
  const tokenA = buildOpencodeConfig(pA).mcp.otb.environment.OTB_INTERNAL_TOKEN;
  const tokenB = buildOpencodeConfig(pB).mcp.otb.environment.OTB_INTERNAL_TOKEN;
  assert.notStrictEqual(tokenA, tokenB);
  assert.strictEqual(projectTokens.findProjectIdByToken(tokenA), pA.id);
  assert.strictEqual(projectTokens.findProjectIdByToken(tokenB), pB.id);
});
```

Now update `tests/workspaceSync.test.js`. Add the model import after the existing requires (after line 10):

```javascript
const projectsModel = require('../models/project.model');
```

Replace the last test (currently lines 70-75):

```javascript
test('writeWorkspaceFiles writes AGENTS.md and opencode.json', () => {
  const dbProject = projectsModel.create({ slug: project.slug, name: project.name, keyword: '',
    system_prompt: project.system_prompt, teams_webhook_url: '' });
  const ws = wsSvc.writeWorkspaceFiles(dbProject, []);
  assert.ok(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8').includes('Payment'));
  const cfg = JSON.parse(fs.readFileSync(path.join(ws, 'opencode.json'), 'utf8'));
  assert.strictEqual(cfg.permission.edit, 'deny');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/workspace.test.js tests/workspaceSync.test.js`
Expected: FAIL — either a `SqliteError: FOREIGN KEY constraint failed` (once Task 2's implementation lands `getInternalTokenForProject` will exist, but right now `getInternalToken` is still the export, so these tests fail differently first: they still call the *old* code, which never touches `project_tokens`, so `projectTokens.findProjectIdByToken(tokenA)` returns `null` instead of `pA.id`, and the two tokens comparison may or may not fail depending on random bytes — the two-tokens assertion should already fail because the *old* `getInternalToken()` returns the same global token for both calls). Confirm the new `buildOpencodeConfig gives each project its own token...` test fails with `assert.notStrictEqual` (tokenA === tokenB) or `assert.strictEqual(projectTokens.findProjectIdByToken(tokenA), pA.id)` returning `null !== pA.id`.

- [ ] **Step 3: Implement `getInternalTokenForProject`**

In `services/workspace.service.js`, add the import after line 6 (`const { redactApiSecrets } = require('./curlApiGroup.service');`):

```javascript
const projectTokens = require('../models/projectToken.model');
```

Replace `getInternalToken` (lines 12-19):

```javascript
// Reuses the same plaintext token across restarts (opencode.json gets
// rewritten on every sync, so a stable token avoids re-authenticating every
// running opencode session). The hash is always re-upserted into
// project_tokens, even when the on-disk file already existed, so the DB and
// the file can never drift out of sync (e.g. after restoring the DB from a
// backup that predates the file).
function getInternalTokenForProject(project) {
  const dir = path.join(DATA_DIR, 'internal-tokens');
  const f = path.join(dir, project.slug);
  let token;
  if (fs.existsSync(f)) {
    token = fs.readFileSync(f, 'utf8').trim();
  } else {
    fs.mkdirSync(dir, { recursive: true });
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, token, { mode: 0o600 });
  }
  projectTokens.setToken(project.id, token);
  return token;
}
```

Update `buildOpencodeConfig` (around line 95, inside the `mcp.otb.environment` object):

```javascript
          OTB_INTERNAL_TOKEN: getInternalTokenForProject(project),
```

Update the module exports (lines 175-178) to swap `getInternalToken` for `getInternalTokenForProject`:

```javascript
module.exports = {
  buildAgentsMd, buildOpencodeConfig, getInternalTokenForProject, repoDirName,
  git, workspacePathFor, redactGitError, syncRepo, pruneRemovedRepos, writeWorkspaceFiles,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/workspace.test.js tests/workspaceSync.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite once to catch any other caller of the old export**

Run: `npm test`
Expected: PASS — confirms nothing else imports `getInternalToken` (a repo-wide search during planning found only `routes/internal.routes.js`, handled in Task 3).

- [ ] **Step 6: Commit**

```bash
git add services/workspace.service.js tests/workspace.test.js tests/workspaceSync.test.js
git commit -m "feat: mint one internal token per project instead of a shared global token"
```

---

### Task 3: Enforce token ↔ slug match in `/internal/call-api`

**Files:**
- Modify: `routes/internal.routes.js` (full rewrite of the handler)
- Test: `tests/internalRoutes.test.js` (new file)

**Interfaces:**
- Consumes: `projectTokens.findProjectIdByToken(token)` from Task 1, `projects.findBySlug(slug)` (existing, `models/project.model.js:13`), `executeApiCall(...)` (existing, `services/callapi.service.js:6`).
- Produces: no new exports; this is the top-level HTTP contract described in the report — a token only authorizes calls for the project it was minted for.

- [ ] **Step 1: Write the failing tests**

Create `tests/internalRoutes.test.js`:

```javascript
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';

const request = require('supertest');
const { adminApp } = require('../server');
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const apis = require('../models/api.model');
const projectTokens = require('../models/projectToken.model');

beforeEach(() => resetDbForTest());

function setupProjectWithApi(slug) {
  const p = projects.create({ slug, name: slug, keyword: '', system_prompt: '', teams_webhook_url: '' });
  apis.create({ project_id: p.id, name: 'txn', base_url: 'https://api.example.com/v1',
    api_key: 'K', auth_header: 'Authorization', allowed_methods: 'GET', description_md: '' });
  return p;
}

test('rejects requests with a missing or unknown token', async () => {
  const p = setupProjectWithApi('proj-a');
  await request(adminApp).post('/internal/call-api')
    .send({ slug: p.slug, group: 'txn', method: 'GET', path: '/x' })
    .expect(403);
  await request(adminApp).post('/internal/call-api')
    .set('x-otb-internal-token', 'garbage')
    .send({ slug: p.slug, group: 'txn', method: 'GET', path: '/x' })
    .expect(403);
});

test('rejects a valid token for project A used against project B\'s slug', async () => {
  const projectA = setupProjectWithApi('proj-a');
  const projectB = setupProjectWithApi('proj-b');
  projectTokens.setToken(projectA.id, 'token-a');
  projectTokens.setToken(projectB.id, 'token-b');

  const res = await request(adminApp).post('/internal/call-api')
    .set('x-otb-internal-token', 'token-a')
    .send({ slug: projectB.slug, group: 'txn', method: 'GET', path: '/x' });
  assert.strictEqual(res.status, 403);
});

test('accepts a token that matches its own project slug', async () => {
  const p = setupProjectWithApi('proj-c');
  projectTokens.setToken(p.id, 'token-c');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":true}', {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try {
    const res = await request(adminApp).post('/internal/call-api')
      .set('x-otb-internal-token', 'token-c')
      .send({ slug: p.slug, group: 'txn', method: 'GET', path: '/x' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('404s for an unknown slug even with a valid token from another project', async () => {
  const p = setupProjectWithApi('proj-d');
  projectTokens.setToken(p.id, 'token-d');
  const res = await request(adminApp).post('/internal/call-api')
    .set('x-otb-internal-token', 'token-d')
    .send({ slug: 'does-not-exist', group: 'txn', method: 'GET', path: '/x' });
  assert.strictEqual(res.status, 404);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/internalRoutes.test.js`
Expected: FAIL — the "rejects a valid token for project A used against project B's slug" test fails because the current handler only checks the token against the single global `getInternalToken()` value and then trusts `slug` unconditionally, so it currently returns 400 (unknown project or bad params) or 200 instead of 403.

- [ ] **Step 3: Rewrite the handler**

Replace all of `routes/internal.routes.js`:

```javascript
const router = require('express').Router();
const projects = require('../models/project.model');
const projectTokens = require('../models/projectToken.model');
const { executeApiCall } = require('../services/callapi.service');

router.post('/call-api', async (req, res) => {
  const tokenProjectId = projectTokens.findProjectIdByToken(req.get('x-otb-internal-token'));
  if (!tokenProjectId) return res.status(403).json({ error: 'forbidden' });

  const { slug, group, method, path, params, conversation_id } = req.body || {};
  const project = projects.findBySlug(slug);
  if (!project) return res.status(404).json({ error: `project "${slug}" does not exist` });
  // The token only authorizes the project it was minted for; a token from
  // one project must never be able to read another project's configured
  // API (and its api_key) by supplying a different slug in the body.
  if (project.id !== tokenProjectId) return res.status(403).json({ error: 'forbidden' });

  try {
    const result = await executeApiCall({ project, groupName: group, method, path, params, conversationId: conversation_id });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/internalRoutes.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all existing tests plus the new ones.

- [ ] **Step 6: Commit**

```bash
git add routes/internal.routes.js tests/internalRoutes.test.js
git commit -m "fix: require internal token to match the requested project slug"
```

---

## Notes for the reviewer (not a task, just context)

- No data migration is required. Existing deployments have a stale global token cached in each project's `workspaces/<slug>/opencode.json`; the next sync (`sync.service.js:38` or `:79`, triggered by saving a project or by the message path) calls `writeWorkspaceFiles` → `buildOpencodeConfig` → `getInternalTokenForProject`, which mints and writes a fresh per-project token and overwrites `opencode.json`. Any opencode session already running against the old shared token will simply get a 403 on its next `call_api` invocation and need a fresh sync — no manual cleanup needed. The old `data/internal-token` file becomes dead weight; it can be deleted manually but nothing reads it after this change.
- `project_tokens.project_id` has `ON DELETE CASCADE`, matching `repos` and `api_groups` — deleting a project (`controllers/project.controller.js:107-110`) automatically drops its token row.
