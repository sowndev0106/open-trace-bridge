# Project Source Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move git sync out of the message hot path: saving a project force-syncs its repos into `workspaces/<slug>/` in the background (remote always wins), the admin UI shows per-repo sync status with a "Sync now" button, and a `/pull-source` chat command re-pulls on demand. Messages just run opencode in the ready workspace, force-syncing inline only as a fallback.

**Architecture:** A new `services/sync.service.js` orchestrates syncs (per-project in-process mutex, per-repo status rows in SQLite). `services/workspace.service.js` is refactored into small pieces (`syncRepo` with force semantics, `writeWorkspaceFiles`, `pruneRemovedRepos`) and loses `ensureWorkspace`. Controllers fire `triggerSync` after admin writes; the event controller calls `ensureReady` per message and handles `/pull-source`.

**Tech Stack:** Node.js (CommonJS), Express, better-sqlite3, EJS views, Tailwind (compiled via `npm run build:css`), `node --test` + supertest + cheerio for tests.

**Spec:** `docs/superpowers/specs/2026-07-05-project-source-sync-design.md`

## Global Constraints

- Everything in English: code, comments, strings, tests, docs (CLAUDE.md rule).
- Never commit secrets; git error text stored in DB must have repo tokens redacted.
- Two-port boundary: `POST /admin/projects/:id/sync` and `GET /admin/projects/:id/sync-status` live on the **admin app** (`routes/admin.routes.js`) only; `/pull-source` arrives through the existing public event route.
- Sync status values are exactly: `pending`, `syncing`, `success`, `error`.
- Services that other modules must stub in tests are required as module objects (`const sync = require(...)`; call `sync.triggerSync(...)`), never destructured.
- Test runner: `npm test` (runs `node --test 'tests/*.test.js'`). Each test file sets `process.env.OTB_DB_PATH = ':memory:'` before requiring app code.

---

### Task 1: Repo sync-status columns + model helper

**Files:**
- Modify: `lib/db.js` (repos schema + migration block)
- Modify: `models/repo.model.js`
- Test: `tests/models.test.js` (append)

**Interfaces:**
- Produces: `repos.setSyncStatus(id, { status, error = null })` — updates `sync_status`, `sync_error`; stamps `synced_at` only when status is `success` or `error`. New columns on every row returned by `repos.create` / `repos.listByProject`: `sync_status` (default `'pending'`), `sync_error` (nullable), `synced_at` (nullable).

- [ ] **Step 1: Write the failing test** — append to `tests/models.test.js` (reuse the file's existing requires for `projects` and `repos`; add a project seed matching the file's existing pattern):

```js
test('repo sync status lifecycle: pending -> syncing -> error stamps synced_at', () => {
  const p = projects.create({ slug: 'sync-p', name: 'Sync P', keyword: '', system_prompt: '',
    teams_webhook_url: '', max_msg_length: 20000 });
  const r = repos.create({ project_id: p.id, git_url: 'https://github.com/acme/a.git' });
  assert.strictEqual(r.sync_status, 'pending');
  assert.strictEqual(r.synced_at, null);

  repos.setSyncStatus(r.id, { status: 'syncing' });
  let row = repos.listByProject(p.id)[0];
  assert.strictEqual(row.sync_status, 'syncing');
  assert.strictEqual(row.synced_at, null);

  repos.setSyncStatus(r.id, { status: 'error', error: 'clone failed' });
  row = repos.listByProject(p.id)[0];
  assert.strictEqual(row.sync_status, 'error');
  assert.strictEqual(row.sync_error, 'clone failed');
  assert.ok(row.synced_at);

  repos.setSyncStatus(r.id, { status: 'success' });
  row = repos.listByProject(p.id)[0];
  assert.strictEqual(row.sync_status, 'success');
  assert.strictEqual(row.sync_error, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/models.test.js`
Expected: FAIL — `r.sync_status` is `undefined` (column does not exist) or `repos.setSyncStatus is not a function`.

- [ ] **Step 3: Implement** — in `lib/db.js`, extend the `repos` CREATE TABLE (fresh DBs) with three columns after `branch`:

```sql
  branch TEXT NOT NULL DEFAULT 'main',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  sync_error TEXT,
  synced_at TEXT
```

and replace the single-migration block at the bottom of `getDb()` with a loop (keep the existing `max_msg_length` statement in it):

```js
  // Migrations for databases created before these columns existed.
  const migrations = [
    "ALTER TABLE projects ADD COLUMN max_msg_length INTEGER NOT NULL DEFAULT 20000",
    "ALTER TABLE repos ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending'",
    "ALTER TABLE repos ADD COLUMN sync_error TEXT",
    "ALTER TABLE repos ADD COLUMN synced_at TEXT",
  ];
  for (const stmt of migrations) {
    try { db.exec(stmt); } catch { /* already exists */ }
  }
```

In `models/repo.model.js`, add and export:

```js
function setSyncStatus(id, { status, error = null }) {
  getDb().prepare(
    `UPDATE repos SET sync_status = ?, sync_error = ?,
       synced_at = CASE WHEN ? IN ('success','error') THEN datetime('now') ELSE synced_at END
     WHERE id = ?`
  ).run(status, error, status, id);
}

module.exports = { create, listByProject, remove, setSyncStatus };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/models.test.js` → PASS. Then `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/db.js models/repo.model.js tests/models.test.js
git commit -m "feat: repo sync status columns (pending/syncing/success/error) + setSyncStatus"
```

---

### Task 2: Force-sync primitives in workspace.service

**Files:**
- Modify: `services/workspace.service.js`
- Test: `tests/workspaceSync.test.js` (new file; keeps `tests/workspace.test.js` untouched so its env stays clean)

**Interfaces:**
- Consumes: existing `gitEnvFor`, `cloneUrlFor`, `repoDirName`, `buildAgentsMd`, `buildOpencodeConfig` (all already in the file).
- Produces (all exported from `services/workspace.service.js`):
  - `workspacePathFor(project) -> string` — `WORKSPACES_DIR/<slug>`.
  - `git` — `{ run(args, opts) -> Promise }` indirection over `execFile('git', ...)`; tests stub `git.run`.
  - `syncRepo(repo, ws) -> Promise<void>` — force-sync one repo dir; throws `Error` with token-redacted message on git failure.
  - `pruneRemovedRepos(ws, repoRows) -> void` — deletes child dirs containing `.git` whose name matches no configured repo.
  - `writeWorkspaceFiles(project, apiGroups) -> string` — writes `AGENTS.md` + `opencode.json`, returns workspace path.
  - `redactGitError(text, repo) -> string` — replaces `repo.token` with `***`, truncates to 1000 chars.
  - `ensureWorkspace` stays exported **unchanged** in this task (event.controller still uses it until Task 5).

- [ ] **Step 1: Write the failing tests** — create `tests/workspaceSync.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.OTB_DB_PATH = ':memory:';
process.env.OTB_WORKSPACES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-ws-'));

const wsSvc = require('../services/workspace.service');

const project = { id: 1, slug: 'payment', name: 'Payment', keyword: '', system_prompt: 'x', teams_webhook_url: '' };

let calls;
beforeEach(() => {
  calls = [];
  wsSvc.git.run = async (args) => { calls.push(args); };
});

test('syncRepo clones when the directory has no .git', async () => {
  const ws = wsSvc.workspacePathFor(project);
  fs.rmSync(ws, { recursive: true, force: true });
  const repo = { id: 7, git_url: 'https://github.com/acme/app.git', auth_type: 'none', branch: 'main' };
  await wsSvc.syncRepo(repo, ws);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].slice(0, 4), ['clone', '--depth', '1', '--branch']);
  assert.strictEqual(calls[0][4], 'main');
});

test('syncRepo force-syncs when .git exists: fetch, checkout -B, clean -fd', async () => {
  const ws = wsSvc.workspacePathFor(project);
  const dir = path.join(ws, 'app');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const repo = { id: 7, git_url: 'https://github.com/acme/app.git', auth_type: 'none', branch: 'release' };
  await wsSvc.syncRepo(repo, ws);
  assert.deepStrictEqual(calls.map((c) => c.slice(2)), [
    ['fetch', '--depth', '1', 'origin', 'release'],
    ['checkout', '-B', 'release', 'origin/release'],
    ['clean', '-fd'],
  ]);
  for (const c of calls) assert.deepStrictEqual(c.slice(0, 2), ['-C', dir]);
});

test('syncRepo redacts the token from git errors', async () => {
  wsSvc.git.run = async () => { const e = new Error('boom'); e.stderr = 'fatal: https://x-access-token:SECRET123@github.com denied'; throw e; };
  const ws = wsSvc.workspacePathFor(project);
  fs.rmSync(ws, { recursive: true, force: true });
  const repo = { id: 8, git_url: 'https://github.com/acme/app.git', auth_type: 'https-token', token: 'SECRET123', branch: 'main' };
  await assert.rejects(() => wsSvc.syncRepo(repo, ws), (err) => {
    assert.ok(!err.message.includes('SECRET123'));
    assert.ok(err.message.includes('***'));
    return true;
  });
});

test('pruneRemovedRepos deletes stale git checkouts only', () => {
  const ws = wsSvc.workspacePathFor(project);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(path.join(ws, 'kept', '.git'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'stale', '.git'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'not-ours'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'x');
  wsSvc.pruneRemovedRepos(ws, [{ git_url: 'https://github.com/acme/kept.git' }]);
  assert.ok(fs.existsSync(path.join(ws, 'kept')));
  assert.ok(!fs.existsSync(path.join(ws, 'stale')));
  assert.ok(fs.existsSync(path.join(ws, 'not-ours')));
  assert.ok(fs.existsSync(path.join(ws, 'AGENTS.md')));
});

test('writeWorkspaceFiles writes AGENTS.md and opencode.json', () => {
  const ws = wsSvc.writeWorkspaceFiles(project, []);
  assert.ok(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8').includes('Payment'));
  const cfg = JSON.parse(fs.readFileSync(path.join(ws, 'opencode.json'), 'utf8'));
  assert.strictEqual(cfg.permission.edit, 'deny');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/workspaceSync.test.js`
Expected: FAIL — `wsSvc.git` / `workspacePathFor` / `syncRepo` etc. are undefined.

- [ ] **Step 3: Implement** — in `services/workspace.service.js`, add below `cloneUrlFor`:

```js
// Indirection over execFile('git', ...) so tests can stub git invocations.
const git = { run: (args, opts) => execFileP('git', args, opts) };

function workspacePathFor(project) {
  return path.join(WORKSPACES_DIR, project.slug);
}

function redactGitError(text, repo) {
  let s = String(text || '');
  if (repo.token) s = s.split(repo.token).join('***');
  return s.slice(0, 1000);
}

// Force-sync one repo into ws: remote always wins. Local commits, branch
// moves, and untracked files are discarded on every sync.
async function syncRepo(repo, ws) {
  const dir = path.join(ws, repoDirName(repo.git_url));
  const keysDir = path.join(WORKSPACES_DIR, '.keys');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(keysDir, { recursive: true });
  const keyFile = path.join(keysDir, `repo-${repo.id}`);
  const env = gitEnvFor(repo, keyFile);
  const branch = repo.branch || 'main';
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      await git.run(['-C', dir, 'fetch', '--depth', '1', 'origin', branch], { env, timeout: 300000 });
      await git.run(['-C', dir, 'checkout', '-B', branch, `origin/${branch}`], { env, timeout: 60000 });
      await git.run(['-C', dir, 'clean', '-fd'], { env, timeout: 60000 });
    } else {
      await git.run(['clone', '--depth', '1', '--branch', branch, cloneUrlFor(repo), dir], { env, timeout: 300000 });
    }
  } catch (err) {
    throw new Error(`Git failed for repo ${repo.git_url}: ${redactGitError(err.stderr || err.message, repo)}`);
  }
}

// Remove checkouts of repos no longer configured. Only touches direct child
// directories that contain .git; AGENTS.md, opencode.json, and anything we
// did not clone are left alone.
function pruneRemovedRepos(ws, repoRows) {
  if (!fs.existsSync(ws)) return;
  const keep = new Set(repoRows.map((r) => repoDirName(r.git_url)));
  for (const entry of fs.readdirSync(ws, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    if (fs.existsSync(path.join(ws, entry.name, '.git'))) {
      fs.rmSync(path.join(ws, entry.name), { recursive: true, force: true });
    }
  }
}

function writeWorkspaceFiles(project, apiGroups) {
  const ws = workspacePathFor(project);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), buildAgentsMd(project, apiGroups));
  fs.writeFileSync(path.join(ws, 'opencode.json'), JSON.stringify(buildOpencodeConfig(project), null, 2));
  return ws;
}
```

Extend the exports (keep `ensureWorkspace` for now — the event controller still imports it until Task 5):

```js
module.exports = {
  buildAgentsMd, buildOpencodeConfig, getInternalToken, ensureWorkspace, repoDirName,
  git, workspacePathFor, redactGitError, syncRepo, pruneRemovedRepos, writeWorkspaceFiles,
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/workspaceSync.test.js` → PASS. Then `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add services/workspace.service.js tests/workspaceSync.test.js
git commit -m "feat: force-sync git primitives (remote wins), prune removed repos, workspace file writer"
```

---

### Task 3: sync.service — orchestration, mutex, ensureReady

**Files:**
- Create: `services/sync.service.js`
- Test: `tests/sync.test.js` (new)

**Interfaces:**
- Consumes: `repos.setSyncStatus` / `repos.listByProject` (Task 1); `workspace.syncRepo`, `workspace.pruneRemovedRepos`, `workspace.writeWorkspaceFiles`, `workspace.workspacePathFor`, `workspace.repoDirName` (Task 2); `projects.findById`, `apis.listByProject` (existing).
- Produces (exports of `services/sync.service.js`):
  - `syncProject(projectId) -> Promise<{ ok, results: [{ repoId, git_url, status, error? }] }>` — awaitable full sync; per-repo isolation (one failure does not stop the rest); always prunes + writes workspace files at the end.
  - `triggerSync(projectId, { reason } = {}) -> Promise<void>` — background wrapper with per-project mutex; a trigger during a run coalesces into exactly one rerun. Callers ignore the returned promise; tests await it.
  - `ensureReady(project) -> Promise<string>` — returns workspace path. If every repo is `success` and its dir exists (or there are no repos), only rewrites workspace files; otherwise runs `syncProject` inline and throws if any repo failed.
  - `deriveProjectStatus(repoRows) -> 'pending'|'syncing'|'success'|'error'` — `error` beats `syncing` beats `pending`; empty list is `success`.

- [ ] **Step 1: Write the failing tests** — create `tests/sync.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.OTB_DB_PATH = ':memory:';
process.env.OTB_WORKSPACES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-sync-'));

const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const workspace = require('../services/workspace.service');
const sync = require('../services/sync.service');

let project;
beforeEach(() => {
  resetDbForTest();
  project = projects.create({ slug: 'payment', name: 'Payment', keyword: '', system_prompt: 'x',
    teams_webhook_url: '', max_msg_length: 20000 });
});

function addRepo(url) {
  return repos.create({ project_id: project.id, git_url: url, auth_type: 'none', branch: 'main' });
}

test('deriveProjectStatus precedence', () => {
  assert.strictEqual(sync.deriveProjectStatus([]), 'success');
  assert.strictEqual(sync.deriveProjectStatus([{ sync_status: 'success' }]), 'success');
  assert.strictEqual(sync.deriveProjectStatus([{ sync_status: 'success' }, { sync_status: 'pending' }]), 'pending');
  assert.strictEqual(sync.deriveProjectStatus([{ sync_status: 'pending' }, { sync_status: 'syncing' }]), 'syncing');
  assert.strictEqual(sync.deriveProjectStatus([{ sync_status: 'syncing' }, { sync_status: 'error' }]), 'error');
});

test('syncProject records per-repo success/error and keeps going after a failure', async () => {
  addRepo('https://github.com/acme/bad.git');
  addRepo('https://github.com/acme/good.git');
  workspace.syncRepo = async (repo) => {
    if (repo.git_url.includes('bad')) throw new Error('Git failed for repo bad: denied');
  };
  const { ok, results } = await sync.syncProject(project.id);
  assert.strictEqual(ok, false);
  assert.strictEqual(results.length, 2);
  const rows = repos.listByProject(project.id);
  assert.strictEqual(rows.find((r) => r.git_url.includes('bad')).sync_status, 'error');
  assert.match(rows.find((r) => r.git_url.includes('bad')).sync_error, /denied/);
  assert.strictEqual(rows.find((r) => r.git_url.includes('good')).sync_status, 'success');
  // Workspace files are written even when a repo failed.
  assert.ok(fs.existsSync(path.join(workspace.workspacePathFor(project), 'AGENTS.md')));
});

test('triggerSync coalesces triggers during a run into one rerun', async () => {
  addRepo('https://github.com/acme/app.git');
  let runs = 0;
  let release;
  workspace.syncRepo = () => { runs += 1; return new Promise((res) => { release = res; }); };
  const p = sync.triggerSync(project.id);
  await new Promise((r) => setImmediate(r));
  sync.triggerSync(project.id); // during run 1 -> schedules exactly one rerun
  sync.triggerSync(project.id); // also during run 1 -> coalesced, no third run
  release();
  await new Promise((r) => setImmediate(r));
  release();
  await p;
  assert.strictEqual(runs, 2);
});

test('ensureReady skips git when all repos are success and dirs exist', async () => {
  const r = addRepo('https://github.com/acme/app.git');
  repos.setSyncStatus(r.id, { status: 'success' });
  fs.mkdirSync(path.join(workspace.workspacePathFor(project), 'app', '.git'), { recursive: true });
  workspace.syncRepo = async () => { throw new Error('git must not be called'); };
  const ws = await sync.ensureReady(project);
  assert.ok(fs.existsSync(path.join(ws, 'AGENTS.md')));
});

test('ensureReady syncs inline when not ready and throws on failure', async () => {
  addRepo('https://github.com/acme/app.git');
  workspace.syncRepo = async () => { throw new Error('Git failed for repo app: denied'); };
  await assert.rejects(() => sync.ensureReady(project), /Source sync failed/);
  workspace.syncRepo = async () => {};
  const ws = await sync.ensureReady(project);
  assert.strictEqual(ws, workspace.workspacePathFor(project));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/sync.test.js`
Expected: FAIL — `Cannot find module '../services/sync.service'`.

- [ ] **Step 3: Implement** — create `services/sync.service.js`:

```js
// Orchestrates repo syncs per project: background trigger with a per-project
// mutex, inline fallback for the message path, and derived status for the UI.
const fs = require('fs');
const path = require('path');
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const workspace = require('./workspace.service');

const running = new Map(); // projectId -> { rerun: boolean }

function deriveProjectStatus(repoRows) {
  const statuses = new Set(repoRows.map((r) => r.sync_status));
  if (statuses.has('error')) return 'error';
  if (statuses.has('syncing')) return 'syncing';
  if (statuses.has('pending')) return 'pending';
  return 'success';
}

async function syncProject(projectId) {
  const project = projects.findById(projectId);
  if (!project) throw new Error(`Project ${projectId} does not exist`);
  const repoRows = repos.listByProject(projectId);
  const ws = workspace.workspacePathFor(project);
  const results = [];
  for (const repo of repoRows) repos.setSyncStatus(repo.id, { status: 'syncing' });
  for (const repo of repoRows) {
    try {
      await workspace.syncRepo(repo, ws);
      repos.setSyncStatus(repo.id, { status: 'success' });
      results.push({ repoId: repo.id, git_url: repo.git_url, status: 'success' });
    } catch (err) {
      repos.setSyncStatus(repo.id, { status: 'error', error: err.message });
      results.push({ repoId: repo.id, git_url: repo.git_url, status: 'error', error: err.message });
    }
  }
  workspace.pruneRemovedRepos(ws, repoRows);
  workspace.writeWorkspaceFiles(project, apis.listByProject(projectId));
  return { ok: results.every((r) => r.status === 'success'), results };
}

// Fire-and-forget background sync. A trigger that lands while a sync for the
// same project is running coalesces into exactly one rerun after it finishes.
// Returns the loop promise so tests can await it; production callers ignore it.
function triggerSync(projectId, { reason = 'save' } = {}) {
  const id = Number(projectId);
  const state = running.get(id);
  if (state) { state.rerun = true; return Promise.resolve(); }
  running.set(id, { rerun: false });
  return (async () => {
    do {
      running.get(id).rerun = false;
      try {
        await syncProject(id);
      } catch (err) {
        console.error(`Sync fail (project=${id}, reason=${reason}):`, err.message);
      }
    } while (running.get(id).rerun);
    running.delete(id);
  })();
}

// Message path: no git when the workspace is ready; inline force-sync as a
// fallback so a question never fails just because nobody pressed Save.
async function ensureReady(project) {
  const repoRows = repos.listByProject(project.id);
  const ws = workspace.workspacePathFor(project);
  const ready = repoRows.every((r) => r.sync_status === 'success'
    && fs.existsSync(path.join(ws, workspace.repoDirName(r.git_url))));
  if (repoRows.length && !ready) {
    const { ok, results } = await syncProject(project.id);
    if (!ok) {
      const failed = results.filter((r) => r.status === 'error')
        .map((r) => `${r.git_url}: ${r.error}`).join('; ');
      throw new Error(`Source sync failed: ${failed}`);
    }
    return ws; // syncProject already wrote the workspace files
  }
  return workspace.writeWorkspaceFiles(project, apis.listByProject(project.id));
}

module.exports = { syncProject, triggerSync, ensureReady, deriveProjectStatus };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/sync.test.js` → PASS. Then `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add services/sync.service.js tests/sync.test.js
git commit -m "feat: sync service (background trigger + mutex, inline ensureReady, derived status)"
```

---

### Task 4: `/pull-source` detection in the event gateway

**Files:**
- Modify: `lib/eventGateway.js:10-18` (`extractPrompt`)
- Test: `tests/eventGateway.test.js` (append)

**Interfaces:**
- Produces: `extractPrompt(rawText, keyword)` now returns `{ isNew, isPullSource, prompt }`. `isPullSource` is true when the text (after HTML strip + keyword strip) starts with `/pull-source` as a word.

- [ ] **Step 1: Write the failing tests** — append to `tests/eventGateway.test.js`:

```js
test('extractPrompt detects /pull-source after keyword', () => {
  const r = extractPrompt('payment-bot /pull-source', 'payment-bot');
  assert.strictEqual(r.isPullSource, true);
  assert.strictEqual(r.isNew, false);
});

test('extractPrompt does not flag /pull-source mid-sentence or as prefix of another word', () => {
  assert.strictEqual(extractPrompt('please run /pull-source', '').isPullSource, false);
  assert.strictEqual(extractPrompt('/pull-sourcex', '').isPullSource, false);
  assert.strictEqual(extractPrompt('/pull-source now', '').isPullSource, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/eventGateway.test.js`
Expected: FAIL — `r.isPullSource` is `undefined`.

- [ ] **Step 3: Implement** — in `lib/eventGateway.js`, change the end of `extractPrompt` (and its comment) to:

```js
// Strip the keyword prefix when present and detect the /new and /pull-source
// commands. Forward the remaining text to the agent unchanged; no rigid
// command parsing.
function extractPrompt(rawText, keyword) {
  let text = stripHtml(rawText);
  const kw = String(keyword || '').trim();
  if (kw && text.toLowerCase().startsWith(kw.toLowerCase())) {
    text = text.slice(kw.length).trim();
  }
  const isNew = /^\/new\b/.test(text);
  const isPullSource = /^\/pull-source\b/.test(text);
  return { isNew, isPullSource, prompt: text };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/eventGateway.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/eventGateway.js tests/eventGateway.test.js
git commit -m "feat: detect /pull-source command in event gateway"
```

---

### Task 5: Event controller — ensureReady + /pull-source branch

**Files:**
- Modify: `controllers/event.controller.js`
- Modify: `services/workspace.service.js` (drop `ensureWorkspace`, now unused)
- Modify: `tests/workspace.test.js` (only if it references `ensureWorkspace`; current version does not)
- Test: `tests/eventController.test.js` (new)

**Interfaces:**
- Consumes: `sync.ensureReady(project)`, `sync.syncProject(projectId)` (Task 3); `extractPrompt().isPullSource` (Task 4); existing `opencode.runPrompt({ dir, sessionId, text })` and `webhook.sendTeamsMessage(url, message)`.
- Produces: `POST|GET /api/events/:slug` with `/pull-source` responds `{ handled: true, action: 'pull-source' }` immediately, then background-syncs and posts a Teams summary. `/pull-source` never creates or closes conversations. The normal message path no longer requires `ensureWorkspace`.

- [ ] **Step 1: Switch the controller's service imports to module objects** so tests can stub them. In `controllers/event.controller.js` replace:

```js
const { ensureWorkspace } = require('../services/workspace.service');
const { runPrompt } = require('../services/opencode.service');
const { sendTeamsMessage } = require('../services/webhook.service');
```

with:

```js
const sync = require('../services/sync.service');
const opencode = require('../services/opencode.service');
const webhook = require('../services/webhook.service');
```

and update every call site in the file: `runPrompt(` → `opencode.runPrompt(`, `sendTeamsMessage(` → `webhook.sendTeamsMessage(` (three call sites: new-session notice, success reply, error reply). Also drop the now-unused `repos`/`apis` requires if nothing else in the file uses them.

- [ ] **Step 2: Write the failing tests** — create `tests/eventController.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.OTB_DB_PATH = ':memory:';

const { publicApp } = require('../server');
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const messages = require('../models/message.model');
const convs = require('../models/conversation.model');
const sync = require('../services/sync.service');
const opencode = require('../services/opencode.service');
const webhook = require('../services/webhook.service');

let project;
let sent;
beforeEach(() => {
  resetDbForTest();
  sent = [];
  project = projects.create({ slug: 'payment', name: 'Payment', keyword: 'payment-bot',
    system_prompt: 'x', teams_webhook_url: 'https://hook.example/x', max_msg_length: 20000 });
  webhook.sendTeamsMessage = async (url, msg) => { sent.push(msg); };
});

async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('/pull-source responds immediately, syncs in background, posts summary', async () => {
  let syncedProjectId = null;
  sync.syncProject = async (id) => {
    syncedProjectId = id;
    return { ok: true, results: [{ repoId: 1, git_url: 'https://github.com/acme/app.git', status: 'success' }] };
  };
  const res = await request(publicApp)
    .post('/api/events/payment')
    .send({ raw: { text: 'payment-bot /pull-source' }, user: { id: 'u1', name: 'An' },
      channel: { conversationId: 'c1' } })
    .expect(200);
  assert.strictEqual(res.body.action, 'pull-source');
  await waitFor(() => sent.length === 1);
  assert.strictEqual(syncedProjectId, project.id);
  assert.strictEqual(sent[0].status, 'success');
  assert.match(sent[0].markdown, /acme\/app\.git/);
  // No conversation is created or touched by /pull-source.
  assert.strictEqual(convs.findActive(project.id, 'c1'), undefined);
});

test('message path uses ensureReady and replies with the agent answer', async () => {
  sync.ensureReady = async () => '/tmp/ws-payment';
  opencode.runPrompt = async ({ dir, text }) => {
    assert.strictEqual(dir, '/tmp/ws-payment');
    assert.strictEqual(text, 'why did txn_9 fail?');
    return { sessionId: 'ses_1', text: 'because of X' };
  };
  const res = await request(publicApp)
    .post('/api/events/payment')
    .send({ raw: { text: 'payment-bot why did txn_9 fail?' }, user: { id: 'u1', name: 'An' },
      channel: { conversationId: 'c1' } })
    .expect(200);
  assert.strictEqual(res.body.action, 'investigating');
  await waitFor(() => sent.length === 1);
  assert.strictEqual(sent[0].status, 'success');
  assert.match(sent[0].markdown, /because of X/);
  const conv = convs.findActive(project.id, 'c1');
  assert.strictEqual(conv.opencode_session_id, 'ses_1');
});

test('message path reports sync failure through the error webhook', async () => {
  sync.ensureReady = async () => { throw new Error('Source sync failed: app.git: denied'); };
  await request(publicApp)
    .post('/api/events/payment')
    .send({ raw: { text: 'payment-bot check this' }, user: { id: 'u1', name: 'An' },
      channel: { conversationId: 'c2' } })
    .expect(200);
  await waitFor(() => sent.length === 1);
  assert.strictEqual(sent[0].status, 'error');
  assert.match(sent[0].markdown, /Source sync failed/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/eventController.test.js`
Expected: `/pull-source` test FAILS (`action` is `investigating`, no pull-source branch yet). The other two may also fail until `investigate` uses `sync.ensureReady`.

- [ ] **Step 4: Implement** — in `controllers/event.controller.js`:

Replace `investigate` with:

```js
async function investigate(project, conv, prompt) {
  const ws = await sync.ensureReady(project);
  const result = await opencode.runPrompt({ dir: ws, sessionId: conv.opencode_session_id, text: prompt });
  if (!conv.opencode_session_id) convs.setSession(conv.id, result.sessionId);
  return result.text || '(agent returned no text)';
}
```

In `handleEvent`, change the destructuring line and add the `/pull-source` branch directly after it (before the `conv` lookup — the command must not touch conversations):

```js
  const { isNew, isPullSource, prompt } = extractPrompt(ev.text, project.keyword);

  if (isPullSource) {
    res.json({ handled: true, action: 'pull-source' });
    sync.syncProject(project.id)
      .then(({ ok, results }) => {
        const lines = results
          .map((r) => `- ${r.git_url}: ${r.status}${r.error ? ` — ${r.error}` : ''}`)
          .join('\n');
        return webhook.sendTeamsMessage(project.teams_webhook_url, {
          status: ok ? 'success' : 'error',
          title: ok ? 'Sources updated to latest' : 'Source sync failed',
          markdown: lines || 'No repositories configured.',
          metadata: { project: project.slug },
          maxLength: project.max_msg_length,
        });
      })
      .catch((err) => console.error(`pull-source fail (project=${project.slug}):`, err.message));
    return;
  }
```

In `services/workspace.service.js`, delete the `ensureWorkspace` function and remove it from `module.exports` (its callers are gone).

- [ ] **Step 5: Run tests to verify pass**

Run: `node --test tests/eventController.test.js` → PASS. Then `npm test` → all pass (confirms nothing else imported `ensureWorkspace`).

- [ ] **Step 6: Commit**

```bash
git add controllers/event.controller.js services/workspace.service.js tests/eventController.test.js
git commit -m "feat: message path runs on ready workspace; /pull-source chat command force-syncs"
```

---

### Task 6: Admin triggers, Sync now route, sync-status JSON

**Files:**
- Modify: `controllers/project.controller.js`
- Modify: `routes/admin.routes.js`
- Test: `tests/adminUi.test.js` (append)

**Interfaces:**
- Consumes: `sync.triggerSync(projectId, { reason })`, `sync.deriveProjectStatus(repoRows)` (Task 3).
- Produces: `POST /admin/projects/:id/sync` (redirects to the edit page) and `GET /admin/projects/:id/sync-status` returning `{ project: <derived status>, repos: [{ id, git_url, sync_status, sync_error, synced_at }] }`. Create/update project and add/delete repo all call `sync.triggerSync`. `listProjects` passes each project row extended with `sync_status`, `synced_at` (latest across repos), `repo_count` to the view (consumed by Task 7).

- [ ] **Step 1: Write the failing tests** — append to `tests/adminUi.test.js` (add `const sync = require('../services/sync.service');` to the top requires):

```js
test('project save, repo add/delete, and Sync now all trigger a background sync', async () => {
  const triggered = [];
  const origTrigger = sync.triggerSync;
  sync.triggerSync = (id, opts = {}) => { triggered.push({ id: Number(id), reason: opts.reason }); return Promise.resolve(); };
  try {
    await request(adminApp).post('/admin/projects').type('form').send({
      slug: 'billing', name: 'Billing', keyword: 'billing-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/b', max_msg_length: '20000',
    }).expect(302);
    const project = projects.findBySlug('billing');
    await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
      slug: 'billing', name: 'Billing 2', keyword: 'billing-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/b', max_msg_length: '20000',
    }).expect(302);
    await request(adminApp).post(`/admin/projects/${project.id}/repos`).type('form').send({
      git_url: 'https://github.com/acme/billing.git', auth_type: 'none', branch: 'main',
    }).expect(302);
    const repo = repos.listByProject(project.id)[0];
    await request(adminApp).post(`/admin/projects/${project.id}/repos/${repo.id}/delete`).expect(302);
    await request(adminApp).post(`/admin/projects/${project.id}/sync`).expect(302);
    assert.deepStrictEqual(triggered.map((t) => t.id), Array(5).fill(project.id));
    assert.strictEqual(triggered[4].reason, 'manual');
  } finally {
    sync.triggerSync = origTrigger;
  }
});

test('sync-status endpoint returns derived project status and per-repo rows', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git',
    auth_type: 'none', branch: 'main' });
  repos.setSyncStatus(repo.id, { status: 'error', error: 'auth denied' });

  const res = await request(adminApp).get(`/admin/projects/${project.id}/sync-status`).expect(200);
  assert.strictEqual(res.body.project, 'error');
  assert.strictEqual(res.body.repos.length, 1);
  assert.strictEqual(res.body.repos[0].sync_status, 'error');
  assert.strictEqual(res.body.repos[0].sync_error, 'auth denied');
  assert.ok(res.body.repos[0].synced_at);

  await request(adminApp).get('/admin/projects/999/sync-status').expect(404);
});
```

Note: creating a project in the first test invokes the stubbed `triggerSync`, so no real git runs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/adminUi.test.js`
Expected: FAIL — no sync triggered (`triggered` is empty), `/sync` and `/sync-status` return 404.

- [ ] **Step 3: Implement** — in `controllers/project.controller.js`, add to the requires:

```js
const sync = require('../services/sync.service');
```

Add `sync.triggerSync` calls right before each redirect in the four mutating handlers:

```js
// createProject — after `const p = projects.create(values);`
  sync.triggerSync(p.id, { reason: 'create' });
// updateProject — after `projects.update(p.id, values);`
  sync.triggerSync(p.id, { reason: 'update' });
// addRepo — after `repos.create({ project_id: p.id, ...values });`
  sync.triggerSync(p.id, { reason: 'repo-add' });
// deleteRepo — after `repos.remove(req.params.repoId);`
  sync.triggerSync(req.params.id, { reason: 'repo-delete' });
```

Replace `listProjects` (Task 7's view consumes the extra fields):

```js
function listProjects(req, res) {
  const rows = projects.list().map((p) => {
    const repoRows = repos.listByProject(p.id);
    return {
      ...p,
      repo_count: repoRows.length,
      sync_status: sync.deriveProjectStatus(repoRows),
      synced_at: repoRows.map((r) => r.synced_at).filter(Boolean).sort().pop() || null,
    };
  });
  res.render('projects/list', { projects: rows });
}
```

Add the two new handlers and export them (`syncNow`, `syncStatus` added to `module.exports`):

```js
function syncNow(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  sync.triggerSync(p.id, { reason: 'manual' });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function syncStatus(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const repoRows = repos.listByProject(p.id);
  res.json({
    project: sync.deriveProjectStatus(repoRows),
    repos: repoRows.map((r) => ({
      id: r.id, git_url: r.git_url, sync_status: r.sync_status,
      sync_error: r.sync_error, synced_at: r.synced_at,
    })),
  });
}
```

In `routes/admin.routes.js`, add after the repo routes:

```js
router.post('/projects/:id/sync', pc.syncNow);
router.get('/projects/:id/sync-status', pc.syncStatus);
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/adminUi.test.js` → PASS. Then `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add controllers/project.controller.js routes/admin.routes.js tests/adminUi.test.js
git commit -m "feat: admin sync triggers on save/repo changes, Sync now route, sync-status JSON"
```

---

### Task 7: Status badges in the admin UI + polling

**Files:**
- Modify: `views/projects/list.ejs` (Source column)
- Modify: `views/projects/form.ejs` (repo status column, Sync now button, polling script)
- Modify: `assets/styles/admin.css` (two new badge classes)
- Modify: `public/styles/admin.css` (generated — rebuild, do not hand-edit)
- Test: `tests/adminUi.test.js` (append)

**Interfaces:**
- Consumes: `sync_status` / `synced_at` / `repo_count` on list rows (Task 6); `sync_status`, `sync_error`, `synced_at` on repo rows (Task 1); `POST /admin/projects/:id/sync` and `GET /admin/projects/:id/sync-status` (Task 6).
- Produces: badge CSS classes `status-error`, `status-syncing` (plus existing `status-active`, `status-muted`).

- [ ] **Step 1: Write the failing tests** — append to `tests/adminUi.test.js`:

```js
test('projects list shows a source sync badge per project', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git',
    auth_type: 'none', branch: 'main' });
  repos.setSyncStatus(repo.id, { status: 'success' });

  const res = await request(adminApp).get('/admin/projects').expect(200);
  const $ = cheerio.load(res.text);
  assert.match($('thead').text(), /Source/);
  assert.strictEqual($('[data-project-sync]').first().text().trim(), 'success');
});

test('project edit shows per-repo status, error detail, and a Sync now button', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git',
    auth_type: 'none', branch: 'main' });
  repos.setSyncStatus(repo.id, { status: 'error', error: 'auth denied' });

  const res = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(res.text);
  assert.strictEqual($(`form[action="/admin/projects/${project.id}/sync"]`).length, 1);
  assert.strictEqual($(`[data-repo-status="${repo.id}"] .status-badge`).text().trim(), 'error');
  assert.match($(`[data-repo-status="${repo.id}"]`).text(), /auth denied/);
});

test('project edit embeds the status poller only while a sync is unfinished', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git',
    auth_type: 'none', branch: 'main' }); // sync_status defaults to 'pending'

  let res = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  assert.match(res.text, /sync-status/);

  repos.setSyncStatus(repo.id, { status: 'success' });
  res = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  assert.ok(!/setInterval/.test(res.text));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/adminUi.test.js`
Expected: FAIL — no `Source` header, no `data-repo-status`, no sync form.

- [ ] **Step 3: Implement the views and CSS**

In `assets/styles/admin.css`, after `.status-muted`:

```css
  .status-error {
    @apply border-rose-200 bg-rose-50 text-rose-700;
  }

  .status-syncing {
    @apply border-amber-200 bg-amber-50 text-amber-700;
  }
```

Both views share this class map; define it once at the top of each file's EJS (below the existing `<% ... %>` prelude in `form.ejs`, at the top of `list.ejs`):

```ejs
<%
  const syncBadgeClass = { success: 'status-active', error: 'status-error', syncing: 'status-syncing', pending: 'status-muted' };
%>
```

`views/projects/list.ejs` — add `<th>Source</th>` between `<th>Event URL</th>` and the Actions header, and this cell between the Event URL cell and the Actions cell:

```ejs
            <td>
              <% if (p.repo_count) { %>
                <span class="status-badge <%= syncBadgeClass[p.sync_status] || 'status-muted' %>" data-project-sync><%= p.sync_status %></span>
                <% if (p.synced_at) { %><div class="mt-1 text-xs text-ink-500"><%= p.synced_at %></div><% } %>
              <% } else { %>
                <span class="text-sm text-ink-500">No repos</span>
              <% } %>
            </td>
```

`views/projects/form.ejs` — three changes inside the Repos panel (the section only renders when `project` exists):

1. Sync now button in the panel header — the `div.mb-4.flex...` wrapping the "Repos" heading gets a form as its second child:

```ejs
        <form class="inline-form" method="post" action="/admin/projects/<%= project.id %>/sync">
          <button class="btn btn-secondary" type="submit">Sync now</button>
        </form>
```

2. Repo table: add `<th>Status</th>` after `<th>Branch</th>`, and after the branch cell add:

```ejs
                  <td data-repo-status="<%= r.id %>">
                    <span class="status-badge <%= syncBadgeClass[r.sync_status] || 'status-muted' %>"><%= r.sync_status %></span>
                    <% if (r.synced_at) { %><div class="mt-1 text-xs text-ink-500"><%= r.synced_at %></div><% } %>
                    <% if (r.sync_status === 'error' && r.sync_error) { %>
                      <div class="mt-1 max-w-xs truncate text-xs text-rose-700" title="<%= r.sync_error %>"><%= r.sync_error %></div>
                    <% } %>
                  </td>
```

3. Poller at the bottom of the file, immediately before `<%- include('../layout-foot') %>` — rendered only while a sync is unfinished; reloads once when it settles so fresh badges/errors appear (no permanent reload loop):

```ejs
<% if (project && project.id && repos.some((r) => r.sync_status === 'pending' || r.sync_status === 'syncing')) { %>
<script>
  (function () {
    var timer = setInterval(function () {
      fetch('/admin/projects/<%= project.id %>/sync-status')
        .then(function (r) { return r.json(); })
        .then(function (s) {
          var busy = s.repos.some(function (r) { return r.sync_status === 'pending' || r.sync_status === 'syncing'; });
          if (!busy) { clearInterval(timer); location.reload(); }
        })
        .catch(function () {});
    }, 3000);
  })();
</script>
<% } %>
```

Rebuild the compiled stylesheet:

Run: `npm run build:css`
Expected: `public/styles/admin.css` regenerated; `grep -c "status-error" public/styles/admin.css` prints ≥ 1.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/adminUi.test.js` → PASS. Then `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add views/projects/list.ejs views/projects/form.ejs assets/styles/admin.css public/styles/admin.css tests/adminUi.test.js
git commit -m "feat: sync status badges in admin UI, Sync now button, edit-page status poller"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `docs/FLOW.md` (if present — check with `ls docs/`; otherwise `README.md`)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above; documentation only.

- [ ] **Step 1: Document the new flow** — add a short section (English) to `docs/FLOW.md` (or `README.md` if FLOW.md does not exist), e.g. under the message-flow description:

```markdown
## Source sync

- Saving a project, adding a repo, or deleting a repo force-syncs the project's
  repos into `workspaces/<slug>/` in the background. Remote always wins:
  `fetch` + `checkout -B <branch> origin/<branch>` + `clean -fd`; local changes
  and force-pushed history are discarded. Removed repos are pruned.
- Per-repo status (`pending` / `syncing` / `success` / `error`, last synced
  time, error detail) is visible on the project list and edit pages. The edit
  page has a **Sync now** button, and `GET /admin/projects/:id/sync-status`
  serves the status as JSON (admin port only).
- Incoming messages run opencode directly in the ready workspace. If the
  workspace is missing or the last sync failed, the message force-syncs inline
  first, so questions never fail just because nobody pressed Save.
- The `/pull-source` chat command (like `/new`, after the project keyword)
  re-syncs on demand and posts a per-repo summary back to Teams. It does not
  touch the active opencode session.
```

Mention `/pull-source` wherever the README lists `/new`.

- [ ] **Step 2: Full verification**

Run: `npm test`
Expected: all tests pass, including the pre-existing suites (`adminUi`, `callapi`, `eventGateway`, `models`, `opencode-parse`, `teamsFormat`, `workspace`, plus the new `workspaceSync`, `sync`, `eventController`).

- [ ] **Step 3: Commit**

```bash
git add docs/FLOW.md README.md
git commit -m "docs: source sync flow, /pull-source command, sync status UI"
```

---

## Accepted limitations (out of scope)

- An inline `ensureReady` sync on the message path can overlap a background `triggerSync` for the same project (worst case: redundant git work; git operations are idempotent here). The mutex only serializes background triggers.
- No sync history — only the latest status per repo is stored.
- The edit-page poller reloads the page once when a sync settles instead of patching badges in place.
