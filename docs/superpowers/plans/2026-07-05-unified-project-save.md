# Unified Project Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Save button at the top of the project form that persists project fields, all repo rows, and all API group rows in a single POST — on both the edit and New-project pages — with inline-editable rows, keep-secret-on-blank semantics, and transactional reconcile.

**Architecture:** The whole page becomes a single form posting indexed arrays (`repos[0][git_url]`, `apis[0][name]`) that `express.urlencoded({ extended: true })` already parses. A new `validateProjectBundle` validates everything with row-prefixed errors and carries stored secrets into blank fields of existing rows. The controller reconciles rows (update by id / insert without id / delete missing ids) inside a better-sqlite3 transaction, then triggers one background sync. The four old per-section routes are removed.

**Tech Stack:** Node.js (CommonJS), Express, better-sqlite3, EJS (+ an EJS row partial reused by the `<template>`), vanilla JS for Add/Remove rows, `node --test` + supertest + cheerio.

**Spec:** `docs/superpowers/specs/2026-07-05-unified-project-save-design.md`

## Global Constraints

- Everything in English (code, strings, tests, docs).
- Secrets (`token`, `ssh_key`, `api_key`) are `type="password"` / empty textareas, are never echoed into HTML, and blank-on-existing-row means keep the stored value.
- Saving triggers `sync.triggerSync(projectId, { reason: 'create' | 'update' })` exactly once per successful save.
- Sync-status endpoint, poller, Sync now button, and badge markup (`[data-repo-status="<id>"]`, `[data-project-sync]`) keep working.
- Services stubbed by tests are required as module objects, never destructured.
- Test runner: `npm test`; test files set `process.env.OTB_DB_PATH = ':memory:'` before requiring app code.

---

### Task 1: Model update functions

**Files:**
- Modify: `models/repo.model.js`
- Modify: `models/api.model.js`
- Test: `tests/models.test.js` (append)

**Interfaces:**
- Produces: `repos.update(id, { git_url, auth_type, token, ssh_key, branch }) -> row` — full update; when `git_url` or `branch` changed, resets `sync_status` to `'pending'` and clears `sync_error`; otherwise keeps current status. `apis.update(id, { name, base_url, api_key, auth_header, allowed_methods, description_md }) -> row`.

- [ ] **Step 1: Write the failing tests** — append to `tests/models.test.js`:

```js
test('repos.update resets sync status only when git content changes', () => {
  const p = projects.create({ slug: 'u', name: 'U', keyword: '', system_prompt: '', teams_webhook_url: '' });
  const r = repos.create({ project_id: p.id, git_url: 'https://github.com/a/b.git', auth_type: 'none', branch: 'main' });
  repos.setSyncStatus(r.id, { status: 'success' });

  // Auth-only change keeps the status.
  let row = repos.update(r.id, { git_url: 'https://github.com/a/b.git', auth_type: 'https-token', token: 'tok', ssh_key: null, branch: 'main' });
  assert.strictEqual(row.sync_status, 'success');
  assert.strictEqual(row.token, 'tok');

  // Branch change resets to pending and clears the error.
  repos.setSyncStatus(r.id, { status: 'error', error: 'boom' });
  row = repos.update(r.id, { git_url: 'https://github.com/a/b.git', auth_type: 'https-token', token: 'tok', ssh_key: null, branch: 'release' });
  assert.strictEqual(row.sync_status, 'pending');
  assert.strictEqual(row.sync_error, null);
  assert.strictEqual(row.branch, 'release');
});

test('apis.update rewrites all fields', () => {
  const p = projects.create({ slug: 'u2', name: 'U2', keyword: '', system_prompt: '', teams_webhook_url: '' });
  const a = apis.create({ project_id: p.id, name: 'one', base_url: 'https://x.example', api_key: 'k1',
    auth_header: 'Authorization', allowed_methods: 'GET', description_md: 'd' });
  const row = apis.update(a.id, { name: 'two', base_url: 'https://y.example', api_key: 'k2',
    auth_header: 'X-Key', allowed_methods: 'GET,POST', description_md: 'e' });
  assert.strictEqual(row.name, 'two');
  assert.strictEqual(row.base_url, 'https://y.example');
  assert.strictEqual(row.api_key, 'k2');
  assert.strictEqual(row.auth_header, 'X-Key');
  assert.strictEqual(row.allowed_methods, 'GET,POST');
  assert.strictEqual(row.description_md, 'e');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/models.test.js` — Expected: FAIL, `repos.update is not a function`.

- [ ] **Step 3: Implement** — in `models/repo.model.js` add and export:

```js
function update(id, { git_url, auth_type, token, ssh_key, branch }) {
  const current = getDb().prepare('SELECT * FROM repos WHERE id = ?').get(id);
  const contentChanged = current.git_url !== git_url || current.branch !== branch;
  getDb().prepare(
    `UPDATE repos SET git_url = ?, auth_type = ?, token = ?, ssh_key = ?, branch = ?,
       sync_status = CASE WHEN ? THEN 'pending' ELSE sync_status END,
       sync_error  = CASE WHEN ? THEN NULL ELSE sync_error END
     WHERE id = ?`
  ).run(git_url, auth_type || 'none', token || null, ssh_key || null, branch || 'main',
    contentChanged ? 1 : 0, contentChanged ? 1 : 0, id);
  return getDb().prepare('SELECT * FROM repos WHERE id = ?').get(id);
}

module.exports = { create, listByProject, remove, setSyncStatus, update };
```

In `models/api.model.js` add and export:

```js
function update(id, { name, base_url, api_key, auth_header, allowed_methods, description_md }) {
  getDb().prepare(
    `UPDATE api_groups SET name = ?, base_url = ?, api_key = ?, auth_header = ?,
       allowed_methods = ?, description_md = ? WHERE id = ?`
  ).run(name, base_url, api_key || '', auth_header || 'Authorization',
    allowed_methods || 'GET', description_md || '', id);
  return getDb().prepare('SELECT * FROM api_groups WHERE id = ?').get(id);
}

module.exports = { create, listByProject, findByProjectAndName, remove, update };
```

- [ ] **Step 4: Verify pass** — `node --test tests/models.test.js` then `npm test`: all pass.

- [ ] **Step 5: Commit**

```bash
git add models/repo.model.js models/api.model.js tests/models.test.js
git commit -m "feat: repo/api update model functions (repo resets to pending on git change)"
```

---

### Task 2: validateProjectBundle

**Files:**
- Modify: `services/adminValidation.js`
- Test: `tests/adminValidation.test.js` (new)

**Interfaces:**
- Consumes: existing `validateProjectInput`, `validateRepoInput`, `validateApiGroupInput`, `clean` (same file).
- Produces: `validateProjectBundle(body, { existingRepos = [], existingApis = [] } = {}) -> { values: { project, repos, apis }, errors }`. Rows arrive as `body.repos` / `body.apis` (array, object-with-numeric-keys, or undefined). Fully-empty rows (all non-id fields blank) are dropped. Row errors are prefixed `Repo #N:` / `API group #N:` (1-based after dropping empties). Blank secrets on rows whose `id` matches an existing row inherit the stored secret before validation. Each returned row keeps `id` (number) or `null`. Duplicate API group names add `'API group names must be unique.'`.

- [ ] **Step 1: Write the failing tests** — create `tests/adminValidation.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { validateProjectBundle } = require('../services/adminValidation');

const goodProject = {
  slug: 'pay', name: 'Pay', keyword: '', system_prompt: '',
  teams_webhook_url: '', max_msg_length: '20000',
};

test('bundle accepts arrays or indexed objects and drops fully-empty rows', () => {
  const { values, errors } = validateProjectBundle({
    ...goodProject,
    repos: { 0: { git_url: 'https://github.com/a/b.git', auth_type: 'none', branch: 'main', token: '', ssh_key: '' },
             2: { git_url: '', auth_type: 'none', branch: '', token: '', ssh_key: '' } },
    apis: [{ name: 'txn', base_url: 'https://api.x', api_key: '', auth_header: 'Authorization',
             allowed_methods: 'GET', description_md: '' }],
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(values.repos.length, 1);
  assert.strictEqual(values.repos[0].id, null);
  assert.strictEqual(values.apis.length, 1);
});

test('bundle prefixes row errors with their 1-based position', () => {
  const { errors } = validateProjectBundle({
    ...goodProject,
    repos: [
      { git_url: 'https://github.com/a/b.git', auth_type: 'none', branch: 'main' },
      { git_url: 'ftp://bad', auth_type: 'none', branch: '' },
    ],
    apis: [{ name: 'bad name', base_url: 'not-a-url', auth_header: '', allowed_methods: 'GET' }],
  });
  assert.ok(errors.includes('Repo #2: Git URL must be an HTTPS URL or an SSH Git URL.'));
  assert.ok(errors.includes('Repo #2: Branch is required.'));
  assert.ok(errors.includes('API group #1: API group name must use letters, numbers, underscores, and hyphens only.'));
  assert.ok(errors.includes('API group #1: Base URL must be a valid http or https URL.'));
  assert.ok(errors.includes('API group #1: Auth header is required.'));
});

test('blank secret on an existing row inherits the stored secret; new row still errors', () => {
  const existingRepos = [{ id: 7, git_url: 'https://github.com/a/b.git', auth_type: 'https-token',
    token: 'stored-tok', ssh_key: null, branch: 'main' }];
  const ok = validateProjectBundle({
    ...goodProject,
    repos: [{ id: '7', git_url: 'https://github.com/a/b.git', auth_type: 'https-token', token: '', ssh_key: '', branch: 'main' }],
  }, { existingRepos });
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.values.repos[0].token, 'stored-tok');
  assert.strictEqual(ok.values.repos[0].id, 7);

  const bad = validateProjectBundle({
    ...goodProject,
    repos: [{ git_url: 'https://github.com/a/c.git', auth_type: 'https-token', token: '', ssh_key: '', branch: 'main' }],
  }, { existingRepos });
  assert.ok(bad.errors.includes('Repo #1: Token is required for https-token repositories.'));
});

test('blank api_key on an existing row inherits the stored key', () => {
  const existingApis = [{ id: 3, name: 'txn', base_url: 'https://api.x', api_key: 'stored-key',
    auth_header: 'Authorization', allowed_methods: 'GET', description_md: '' }];
  const { values, errors } = validateProjectBundle({
    ...goodProject,
    apis: [{ id: '3', name: 'txn', base_url: 'https://api.x', api_key: '', auth_header: 'Authorization',
      allowed_methods: 'GET', description_md: '' }],
  }, { existingApis });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(values.apis[0].api_key, 'stored-key');
  assert.strictEqual(values.apis[0].id, 3);
});

test('duplicate API group names are rejected', () => {
  const { errors } = validateProjectBundle({
    ...goodProject,
    apis: [
      { name: 'txn', base_url: 'https://api.x', auth_header: 'Authorization', allowed_methods: 'GET' },
      { name: 'txn', base_url: 'https://api.y', auth_header: 'Authorization', allowed_methods: 'GET' },
    ],
  });
  assert.ok(errors.includes('API group names must be unique.'));
});
```

- [ ] **Step 2: Verify failure** — `node --test tests/adminValidation.test.js`: FAIL, `validateProjectBundle is not a function`.

- [ ] **Step 3: Implement** — in `services/adminValidation.js` add before the exports:

```js
function rowsFrom(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : Object.values(value);
  return arr.filter((row) => row && typeof row === 'object'
    && Object.entries(row).some(([key, v]) => key !== 'id' && clean(v)));
}

function validateProjectBundle(body, { existingRepos = [], existingApis = [] } = {}) {
  const { values: project, errors } = validateProjectInput(body);
  const allErrors = [...errors];

  const repos = rowsFrom(body.repos).map((row, i) => {
    const id = Number(row.id) || null;
    const existing = id ? existingRepos.find((r) => Number(r.id) === id) : null;
    const input = { ...row };
    if (existing && !clean(input.token)) input.token = existing.token || '';
    if (existing && !clean(input.ssh_key)) input.ssh_key = existing.ssh_key || '';
    const { values, errors: rowErrors } = validateRepoInput(input);
    for (const message of rowErrors) allErrors.push(`Repo #${i + 1}: ${message}`);
    return { ...values, id: existing ? id : null };
  });

  const apis = rowsFrom(body.apis).map((row, i) => {
    const id = Number(row.id) || null;
    const existing = id ? existingApis.find((a) => Number(a.id) === id) : null;
    const input = { ...row };
    if (existing && !clean(input.api_key)) input.api_key = existing.api_key || '';
    const { values, errors: rowErrors } = validateApiGroupInput(input);
    for (const message of rowErrors) allErrors.push(`API group #${i + 1}: ${message}`);
    return { ...values, id: existing ? id : null };
  });

  const names = apis.map((a) => a.name).filter(Boolean);
  if (new Set(names).size !== names.length) allErrors.push('API group names must be unique.');

  return { values: { project, repos, apis }, errors: allErrors };
}

module.exports = { validateProjectInput, validateRepoInput, validateApiGroupInput, validateProjectBundle };
```

- [ ] **Step 4: Verify pass** — `node --test tests/adminValidation.test.js` then `npm test`: all pass.

- [ ] **Step 5: Commit**

```bash
git add services/adminValidation.js tests/adminValidation.test.js
git commit -m "feat: validateProjectBundle (row-prefixed errors, keep-secret-on-blank, empty-row drop)"
```

---

### Task 3: Controller reconcile + unified form view + test overhaul

**Files:**
- Modify: `controllers/project.controller.js`
- Modify: `routes/admin.routes.js`
- Modify: `views/projects/form.ejs` (rewrite)
- Create: `views/projects/_repo-row.ejs`, `views/projects/_api-row.ejs`
- Test: `tests/adminUi.test.js` (rewrite affected tests, add new ones)

**Interfaces:**
- Consumes: `validateProjectBundle` (Task 2), `repos.update` / `apis.update` (Task 1), `sync.triggerSync` / `sync.deriveProjectStatus` (existing), `getDb().transaction` (better-sqlite3).
- Produces: `POST /admin/projects` and `POST /admin/projects/:id` accept the full bundle; routes `POST /:id/repos`, `POST /:id/repos/:repoId/delete`, `POST /:id/apis`, `POST /:id/apis/:apiId/delete` and their handlers are gone. `renderProjectForm(res, status, { project, repoRows, apiRows, errors })` (no more drafts). View renders one form with Save at top; row inputs named `repos[<i>][field]` / `apis[<i>][field]`; secrets are password/empty fields; `<template data-template="repos|apis">` + vanilla JS Add/Remove.

- [ ] **Step 1: Update the tests** — in `tests/adminUi.test.js`:

Replace the assertions on the removed per-section forms inside `'project edit form preserves workflows inside redesigned panels'`:

```js
// DELETE these two lines:
assert.strictEqual($(`form[action="/admin/projects/${project.id}/repos"][method="post"]`).length, 1);
assert.strictEqual($(`form[action="/admin/projects/${project.id}/apis"][method="post"]`).length, 1);
// ADD instead:
assert.strictEqual($('input[name="repos[0][git_url]"]').val(), 'https://github.com/acme/payment.git');
assert.strictEqual($('input[name="apis[0][name]"]').val(), 'transaction-api');
assert.strictEqual($('template[data-template="repos"]').length, 1);
assert.strictEqual($('template[data-template="apis"]').length, 1);
```

Replace `'repo validation rejects invalid auth and missing credentials without creating a repo'` with:

```js
test('bundle validation rejects a bad repo row with prefixed errors and creates nothing', async () => {
  const project = seedProject();
  const response = await request(adminApp)
    .post(`/admin/projects/${project.id}`)
    .type('form')
    .send({
      slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
      'repos[0][git_url]': 'ftp://example.com/repo.git',
      'repos[0][auth_type]': 'https-token',
      'repos[0][token]': '', 'repos[0][ssh_key]': '', 'repos[0][branch]': '',
    })
    .expect(400);
  const $ = cheerio.load(response.text);
  const errors = $('.error-list li').map((_, el) => $(el).text()).get();
  assert.ok(errors.includes('Repo #1: Git URL must be an HTTPS URL or an SSH Git URL.'));
  assert.ok(errors.includes('Repo #1: Token is required for https-token repositories.'));
  assert.ok(errors.includes('Repo #1: Branch is required.'));
  assert.strictEqual(repos.listByProject(project.id).length, 0);
});
```

Replace `'api group validation rejects invalid URL and methods without creating a group'` with:

```js
test('bundle validation rejects a bad API row with prefixed errors and creates nothing', async () => {
  const project = seedProject();
  const response = await request(adminApp)
    .post(`/admin/projects/${project.id}`)
    .type('form')
    .send({
      slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
      'apis[0][name]': 'bad name', 'apis[0][base_url]': 'not-a-url',
      'apis[0][auth_header]': '', 'apis[0][allowed_methods]': 'GET,TRACE',
      'apis[0][description_md]': 'Keep this description',
    })
    .expect(400);
  const $ = cheerio.load(response.text);
  const errors = $('.error-list li').map((_, el) => $(el).text()).get();
  assert.ok(errors.includes('API group #1: API group name must use letters, numbers, underscores, and hyphens only.'));
  assert.ok(errors.includes('API group #1: Base URL must be a valid http or https URL.'));
  assert.ok(errors.includes('API group #1: Auth header is required.'));
  assert.ok(errors.includes('API group #1: Allowed methods can only include GET, POST, PUT, PATCH, and DELETE.'));
  assert.strictEqual(apis.listByProject(project.id).length, 0);
  assert.match(response.text, /Keep this description/);
});
```

Replace `'project save, repo add/delete, and Sync now all trigger a background sync'` with:

```js
test('create, update, and Sync now each trigger exactly one background sync', async () => {
  const triggered = [];
  const origTrigger = sync.triggerSync;
  sync.triggerSync = (id, opts = {}) => { triggered.push({ id: Number(id), reason: opts.reason }); return Promise.resolve(); };
  try {
    await request(adminApp).post('/admin/projects').type('form').send({
      slug: 'billing', name: 'Billing', keyword: 'billing-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/b', max_msg_length: '20000',
      'repos[0][git_url]': 'https://github.com/acme/billing.git',
      'repos[0][auth_type]': 'none', 'repos[0][branch]': 'main',
      'repos[0][token]': '', 'repos[0][ssh_key]': '',
    }).expect(302);
    const project = projects.findBySlug('billing');
    assert.strictEqual(repos.listByProject(project.id).length, 1);
    await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
      slug: 'billing', name: 'Billing 2', keyword: 'billing-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/b', max_msg_length: '20000',
    }).expect(302);
    await request(adminApp).post(`/admin/projects/${project.id}/sync`).expect(302);
    assert.deepStrictEqual(triggered.map((t) => t.reason), ['create', 'update', 'manual']);
    assert.deepStrictEqual(triggered.map((t) => t.id), Array(3).fill(project.id));
  } finally {
    sync.triggerSync = origTrigger;
  }
});
```

Append the new bundle tests:

```js
test('save-all reconciles rows: edit one, add one, omit one (deleted)', async () => {
  const project = seedProject();
  const keep = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/keep.git', auth_type: 'none', branch: 'main' });
  const drop = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/drop.git', auth_type: 'none', branch: 'main' });
  const origTrigger = sync.triggerSync;
  sync.triggerSync = () => Promise.resolve();
  try {
    await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
      slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
      'repos[0][id]': String(keep.id),
      'repos[0][git_url]': 'https://github.com/acme/keep.git',
      'repos[0][auth_type]': 'none', 'repos[0][branch]': 'release',
      'repos[0][token]': '', 'repos[0][ssh_key]': '',
      'repos[1][git_url]': 'https://github.com/acme/new.git',
      'repos[1][auth_type]': 'none', 'repos[1][branch]': 'main',
      'repos[1][token]': '', 'repos[1][ssh_key]': '',
    }).expect(302);
  } finally {
    sync.triggerSync = origTrigger;
  }
  const rows = repos.listByProject(project.id);
  assert.strictEqual(rows.length, 2);
  const kept = rows.find((r) => r.id === keep.id);
  assert.strictEqual(kept.branch, 'release');
  assert.strictEqual(kept.sync_status, 'pending'); // branch changed -> resync
  assert.ok(rows.some((r) => r.git_url === 'https://github.com/acme/new.git'));
  assert.ok(!rows.some((r) => r.id === drop.id));
});

test('blank token on save keeps the stored secret; secrets are never echoed', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/sec.git',
    auth_type: 'https-token', token: 'ghp_supersecrettoken', branch: 'main' });
  const origTrigger = sync.triggerSync;
  sync.triggerSync = () => Promise.resolve();
  try {
    await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
      slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
      'repos[0][id]': String(repo.id),
      'repos[0][git_url]': 'https://github.com/acme/sec.git',
      'repos[0][auth_type]': 'https-token', 'repos[0][branch]': 'main',
      'repos[0][token]': '', 'repos[0][ssh_key]': '',
    }).expect(302);
  } finally {
    sync.triggerSync = origTrigger;
  }
  assert.strictEqual(repos.listByProject(project.id)[0].token, 'ghp_supersecrettoken');

  const page = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  assert.ok(!page.text.includes('ghp_supersecrettoken'));
  const $ = cheerio.load(page.text);
  assert.strictEqual($('input[name="repos[0][token]"]').attr('type'), 'password');
  assert.strictEqual($('input[name="repos[0][token]"]').val() || '', '');
  assert.strictEqual($('input[name="apis[0][api_key]"]').length, 0); // no api rows seeded
});

test('Save button is at the top inside the single unified form', async () => {
  const project = seedProject();
  const res = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(res.text);
  const mainForm = $(`form[action="/admin/projects/${project.id}"]`);
  assert.strictEqual(mainForm.length, 1);
  // Save button lives in the header section (first section inside the form).
  assert.strictEqual(mainForm.find('section').first().find('button[type="submit"]').text().trim(), 'Save');
  // Sync now posts through the external sync form.
  assert.strictEqual($(`form#sync-form[action="/admin/projects/${project.id}/sync"]`).length, 1);
  assert.strictEqual($('button[form="sync-form"]').length, 1);
});
```

- [ ] **Step 2: Verify failures** — `node --test tests/adminUi.test.js`: the rewritten/new tests FAIL (old routes still active, old markup).

- [ ] **Step 3: Rewrite the controller** — `controllers/project.controller.js` becomes:

```js
const { getDb } = require('../lib/db');
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const { validateProjectBundle } = require('../services/adminValidation');
const sync = require('../services/sync.service');

function renderProjectForm(res, status, { project, repoRows, apiRows, errors = [] }) {
  return res.status(status).render('projects/form', {
    project,
    repos: repoRows || [],
    apis: apiRows || [],
    errors,
    error: errors[0] || null,
  });
}

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
function newProjectForm(req, res) {
  renderProjectForm(res, 200, { project: null, repoRows: [], apiRows: [] });
}

// Insert/update submitted rows, delete rows the submission no longer contains.
function reconcileRows(model, projectId, submitted) {
  const submittedIds = new Set(submitted.filter((r) => r.id).map((r) => r.id));
  for (const existing of model.listByProject(projectId)) {
    if (!submittedIds.has(existing.id)) model.remove(existing.id);
  }
  for (const row of submitted) {
    const { id, ...values } = row;
    if (id) model.update(id, values);
    else model.create({ project_id: projectId, ...values });
  }
}

function createProject(req, res) {
  const { values, errors } = validateProjectBundle(req.body);
  if (values.project.slug && projects.findBySlug(values.project.slug)) {
    errors.push(`Slug "${values.project.slug}" already exists.`);
  }
  if (errors.length) {
    return renderProjectForm(res, 400, {
      project: { ...req.body, ...values.project },
      repoRows: values.repos, apiRows: values.apis, errors,
    });
  }
  const p = getDb().transaction(() => {
    const created = projects.create(values.project);
    reconcileRows(repos, created.id, values.repos);
    reconcileRows(apis, created.id, values.apis);
    return created;
  })();
  sync.triggerSync(p.id, { reason: 'create' });
  res.redirect(`/admin/projects/${p.id}/edit`);
}

function editProjectForm(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  return renderProjectForm(res, 200, {
    project: p,
    repoRows: repos.listByProject(p.id),
    apiRows: apis.listByProject(p.id),
  });
}

function updateProject(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const existingRepos = repos.listByProject(p.id);
  const existingApis = apis.listByProject(p.id);
  const { values, errors } = validateProjectBundle(req.body, { existingRepos, existingApis });
  const existing = values.project.slug ? projects.findBySlug(values.project.slug) : null;
  if (existing && Number(existing.id) !== Number(p.id)) {
    errors.push(`Slug "${values.project.slug}" already exists.`);
  }
  if (errors.length) {
    return renderProjectForm(res, 400, {
      project: { ...p, ...req.body, ...values.project, id: p.id },
      repoRows: values.repos, apiRows: values.apis, errors,
    });
  }
  getDb().transaction(() => {
    projects.update(p.id, values.project);
    reconcileRows(repos, p.id, values.repos);
    reconcileRows(apis, p.id, values.apis);
  })();
  sync.triggerSync(p.id, { reason: 'update' });
  res.redirect(`/admin/projects/${p.id}/edit`);
}

function deleteProject(req, res) {
  projects.remove(req.params.id);
  res.redirect('/admin/projects');
}

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

module.exports = {
  listProjects, newProjectForm, createProject, editProjectForm, updateProject, deleteProject,
  syncNow, syncStatus,
};
```

In `routes/admin.routes.js` delete these four lines:

```js
router.post('/projects/:id/repos', pc.addRepo);
router.post('/projects/:id/repos/:repoId/delete', pc.deleteRepo);
router.post('/projects/:id/apis', pc.addApiGroup);
router.post('/projects/:id/apis/:apiId/delete', pc.deleteApiGroup);
```

- [ ] **Step 4: Create the row partials** — `views/projects/_repo-row.ejs`:

```ejs
<fieldset class="mb-4 rounded-lg border border-line p-4" data-row>
  <input type="hidden" name="repos[<%= i %>][id]" value="<%= r.id || '' %>">
  <div class="form-grid">
    <div>
      <label>Git URL</label>
      <input type="text" name="repos[<%= i %>][git_url]" value="<%= r.git_url || '' %>" placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git">
    </div>
    <div>
      <label>Auth</label>
      <select name="repos[<%= i %>][auth_type]">
        <option value="none" <%= r.auth_type === 'none' || !r.auth_type ? 'selected' : '' %>>none</option>
        <option value="https-token" <%= r.auth_type === 'https-token' ? 'selected' : '' %>>https-token</option>
        <option value="ssh" <%= r.auth_type === 'ssh' ? 'selected' : '' %>>ssh</option>
      </select>
    </div>
    <div>
      <label>Branch</label>
      <input type="text" name="repos[<%= i %>][branch]" value="<%= r.branch || 'main' %>">
    </div>
  </div>
  <div class="form-grid-two mt-3">
    <div>
      <label>Token</label>
      <input type="password" name="repos[<%= i %>][token]" value="" autocomplete="new-password"
             placeholder="<%= r.id ? 'Leave blank to keep the current token' : '' %>">
    </div>
    <div>
      <label>SSH private key</label>
      <textarea name="repos[<%= i %>][ssh_key]" placeholder="<%= r.id ? 'Leave blank to keep the current key' : '' %>"></textarea>
    </div>
  </div>
  <div class="mt-3 flex items-center justify-between gap-4">
    <% if (r.id && r.sync_status) { %>
      <div data-repo-status="<%= r.id %>">
        <span class="status-badge <%= syncBadgeClass[r.sync_status] || 'status-muted' %>"><%= r.sync_status %></span>
        <% if (r.synced_at) { %><span class="ml-2 text-xs text-ink-500"><%= r.synced_at %></span><% } %>
        <% if (r.sync_status === 'error' && r.sync_error) { %>
          <div class="mt-1 max-w-xl truncate text-xs text-rose-700" title="<%= r.sync_error %>"><%= r.sync_error %></div>
        <% } %>
      </div>
    <% } else { %>
      <span class="text-xs text-ink-500">Not saved yet</span>
    <% } %>
    <button type="button" class="btn btn-danger" data-remove>Remove</button>
  </div>
</fieldset>
```

`views/projects/_api-row.ejs`:

```ejs
<fieldset class="mb-4 rounded-lg border border-line p-4" data-row>
  <input type="hidden" name="apis[<%= i %>][id]" value="<%= a.id || '' %>">
  <div class="form-grid-two">
    <div>
      <label>Name</label>
      <input type="text" name="apis[<%= i %>][name]" value="<%= a.name || '' %>" placeholder="transaction-api">
    </div>
    <div>
      <label>Base URL</label>
      <input type="text" name="apis[<%= i %>][base_url]" value="<%= a.base_url || '' %>" placeholder="https://api.internal.example">
    </div>
  </div>
  <div class="form-grid mt-3">
    <div>
      <label>API key</label>
      <input type="password" name="apis[<%= i %>][api_key]" value="" autocomplete="new-password"
             placeholder="<%= a.id ? 'Leave blank to keep the current key' : '' %>">
    </div>
    <div>
      <label>Auth header</label>
      <input type="text" name="apis[<%= i %>][auth_header]" value="<%= a.auth_header || 'Authorization' %>">
    </div>
    <div>
      <label>Allowed methods</label>
      <input type="text" name="apis[<%= i %>][allowed_methods]" value="<%= a.allowed_methods || 'GET' %>">
    </div>
  </div>
  <div class="mt-3">
    <label>Description</label>
    <textarea name="apis[<%= i %>][description_md]" placeholder="Document endpoints, params, and filters for the agent"><%= a.description_md || '' %></textarea>
  </div>
  <div class="mt-3 flex justify-end">
    <button type="button" class="btn btn-danger" data-remove>Remove</button>
  </div>
</fieldset>
```

- [ ] **Step 5: Rewrite `views/projects/form.ejs`:**

```ejs
<%- include('../layout-head') %>

<%
  const isEditing = project && project.id;
  const formAction = isEditing ? '/admin/projects/' + project.id : '/admin/projects';
  const errorList = Array.isArray(errors) ? errors : (error ? [error] : []);
  const syncBadgeClass = { success: 'status-active', error: 'status-error', syncing: 'status-syncing', pending: 'status-muted' };
%>

<% if (isEditing) { %>
  <form id="sync-form" method="post" action="/admin/projects/<%= project.id %>/sync"></form>
<% } %>

<form method="post" action="<%= formAction %>">
  <section class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p class="page-kicker"><%= isEditing ? 'Project settings' : 'Project setup' %></p>
      <h1 class="page-title"><%= isEditing ? project.name : 'New project' %></h1>
      <p class="page-subtitle">Configure how Teams events become investigation sessions and which systems the agent can inspect. One Save writes everything on this page.</p>
    </div>
    <div class="flex items-center gap-2">
      <a href="/admin/projects" class="btn btn-secondary">Back to projects</a>
      <% if (isEditing) { %>
        <button class="btn btn-secondary" type="submit" form="sync-form">Sync now</button>
      <% } %>
      <button class="btn btn-primary" type="submit">Save</button>
    </div>
  </section>

  <% if (errorList.length) { %>
    <section class="error mb-5" role="alert">
      <p class="font-semibold">Please fix these fields:</p>
      <ul class="error-list">
        <% for (const item of errorList) { %>
          <li><%= item %></li>
        <% } %>
      </ul>
    </section>
  <% } %>

  <section class="panel mb-6">
    <div class="panel-body space-y-5">
      <div class="form-grid">
        <div>
          <label for="slug">Slug</label>
          <input id="slug" type="text" name="slug" value="<%= project ? project.slug : '' %>" required pattern="[a-z0-9-]+">
          <p class="field-help">Lowercase letters, numbers, and hyphens. Used in the event URL.</p>
        </div>
        <div>
          <label for="name">Name</label>
          <input id="name" type="text" name="name" value="<%= project ? project.name : '' %>" required>
        </div>
        <div>
          <label for="keyword">Teams keyword</label>
          <input id="keyword" type="text" name="keyword" value="<%= project ? (project.keyword || '') : '' %>" placeholder="payment-bot" pattern="[A-Za-z0-9_-]+">
          <p class="field-help">Optional prefix users type before prompts.</p>
        </div>
      </div>

      <div>
        <label for="system_prompt">System prompt</label>
        <textarea id="system_prompt" name="system_prompt"><%= project ? (project.system_prompt || '') : '' %></textarea>
      </div>

      <div class="form-grid-two">
        <div>
          <label for="teams_webhook_url">Teams webhook URL</label>
          <input id="teams_webhook_url" type="url" name="teams_webhook_url" value="<%= project ? (project.teams_webhook_url || '') : '' %>" placeholder="https://outlook.office.com/webhook/...">
        </div>
        <div>
          <label for="max_msg_length">Max message length</label>
          <input id="max_msg_length" type="number" name="max_msg_length" min="500" required
                 value="<%= project && project.max_msg_length ? project.max_msg_length : 20000 %>">
          <p class="field-help">Longer results are split while preserving code fences.</p>
        </div>
      </div>
    </div>
  </section>

  <% if (isEditing) { %>
    <section class="panel mb-6">
      <div class="panel-body">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="section-heading">Power Automate endpoint</h2>
            <p class="mt-2 text-sm text-ink-500">Use this URL shape when sending Teams events into OpenTraceBridge.</p>
          </div>
          <a class="btn btn-secondary" href="/admin/projects/<%= project.id %>/conversations">Open audit trail</a>
        </div>
        <div class="mt-4 overflow-x-auto rounded-lg border border-line bg-slate-50 p-4">
          <code>https://6666.sowndev.com/api/events/<%= project.slug %>?text=...&amp;conversationId=...&amp;userId=...&amp;userName=...</code>
        </div>
      </div>
    </section>
  <% } %>

  <section class="panel mb-6">
    <div class="panel-body">
      <div class="mb-4">
        <h2 class="section-heading">Repos</h2>
        <p class="mt-1 text-sm text-ink-500">Rows are saved together with the project when you press Save.</p>
      </div>
      <div data-rows="repos">
        <% repos.forEach((r, i) => { %>
          <%- include('_repo-row', { r, i, syncBadgeClass }) %>
        <% }) %>
      </div>
      <button type="button" class="btn btn-secondary" data-add="repos">Add repo</button>
      <template data-template="repos"><%- include('_repo-row', { r: {}, i: '__I__', syncBadgeClass }) %></template>
    </div>
  </section>

  <section class="panel mb-6">
    <div class="panel-body">
      <div class="mb-4">
        <h2 class="section-heading">API groups</h2>
        <p class="mt-1 text-sm text-ink-500">Available to the agent through the call_api MCP tool.</p>
      </div>
      <div data-rows="apis">
        <% apis.forEach((a, i) => { %>
          <%- include('_api-row', { a, i }) %>
        <% }) %>
      </div>
      <button type="button" class="btn btn-secondary" data-add="apis">Add API group</button>
      <template data-template="apis"><%- include('_api-row', { a: {}, i: '__I__' }) %></template>
    </div>
  </section>
</form>

<script>
  (function () {
    var counters = { repos: <%= repos.length %>, apis: <%= apis.length %> };
    document.querySelectorAll('[data-add]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-add');
        var tpl = document.querySelector('template[data-template="' + kind + '"]');
        var holder = document.createElement('div');
        holder.innerHTML = tpl.innerHTML.replace(/__I__/g, counters[kind]++);
        document.querySelector('[data-rows="' + kind + '"]').appendChild(holder.firstElementChild);
      });
    });
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-remove]');
      if (btn) btn.closest('[data-row]').remove();
    });
  })();
</script>

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

<%- include('../layout-foot') %>
```

Note: the poller test asserts `!/setInterval/` when no sync is unfinished — the Add/Remove script above must not use `setInterval` (it does not).

- [ ] **Step 6: Verify pass** — `node --test tests/adminUi.test.js`, then `npm test`: all pass. If the poller test fails on `/sync-status/` (the sync-form action contains `/sync`, not `/sync-status`), the poller block is the only `sync-status` match — confirm it renders for pending rows.

- [ ] **Step 7: Commit**

```bash
git add controllers/project.controller.js routes/admin.routes.js views/projects/form.ejs views/projects/_repo-row.ejs views/projects/_api-row.ejs tests/adminUi.test.js
git commit -m "feat: unified project save (top Save button, inline rows, transactional reconcile)"
```

---

### Task 4: Docs + final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README** — in the admin-usage numbered list, replace steps 1–3 with:

```markdown
1. Create a project with a unique slug, name, keyword, system prompt, Teams webhook URL, and max message length.
2. Add repository rows (HTTPS token, SSH key, or unauthenticated) and API group rows on the same page — one **Save** button at the top writes everything at once. Leaving a secret field blank keeps the stored value.
3. Point Power Automate at:
```

(Keep the code block and the following lines unchanged; renumber if needed.)

- [ ] **Step 2: Full verification** — `npm test`: all suites pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: unified save-all project form"
```

---

## Accepted limitations

- Removing a repo/API row is only persisted on Save; navigating away discards row edits (standard form behavior).
- No optimistic locking: last save wins if two admins edit simultaneously.
- Stale row ids in a submission (row deleted elsewhere mid-edit) are treated as new rows and re-created.
