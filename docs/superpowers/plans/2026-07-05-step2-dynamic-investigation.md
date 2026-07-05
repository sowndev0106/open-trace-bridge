# Step 2 — Dynamic Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nâng server OpenTraceBridge từ ack-only lên hệ thống multi-project: nhận message Teams theo project slug, duy trì OpenCode session theo conversation, agent tự gọi API khai báo qua MCP, trả kết quả về Teams qua webhook, quản trị bằng admin UI.

**Architecture:** Express MVC (EJS server-rendered) + SQLite (better-sqlite3), workspace per project chứa repos clone + `AGENTS.md` + `opencode.json` (MCP stdio trỏ ngược về endpoint nội bộ có token). OpenCode chạy qua CLI `opencode run --format json`, session id parse từ event stream. Deploy cuối bằng Docker (Express 6666 + `opencode serve` 4096).

**Tech Stack:** Node.js 24 (CommonJS), Express 4, EJS, better-sqlite3, @modelcontextprotocol/sdk + zod, opencode CLI v1.2.10, node:test.

**Spec:** `REQUIREMENT.md` (§3–§10). Flow history: `FLOW.md`.

## Global Constraints

- Port Express: **6666** (đang tunnel tại `https://6666.sowndev.com`, pm2 process `open-trace-bridge` — trong lúc dev vẫn dùng pm2; Docker là task cuối).
- CommonJS (`require`), không TypeScript, không build step.
- SQLite file: `data/otb.sqlite` (đường dẫn qua env `OTB_DB_PATH`, test dùng `:memory:`).
- Workspaces: `workspaces/<slug>/` (env `OTB_WORKSPACES_DIR`).
- Route event: `GET|POST /api/events/:slug`. Route cũ `GET|POST /api/events` (không slug) giữ lại, trả hướng dẫn cập nhật URL.
- Lệnh đặc biệt duy nhất: text (sau khi strip HTML + keyword) bắt đầu bằng `/new` → session mới. Mọi text khác forward nguyên văn cho agent.
- OpenCode timeout: 300000 ms (5 phút).
- Agent bị cấm: edit/bash/webfetch (qua `permission` trong opencode.json sinh ra).
- API key/token không bao giờ đưa vào context/AGENTS.md — chỉ server gắn khi thực thi call_api.
- Endpoint nội bộ `/internal/call-api` bảo vệ bằng header `x-otb-internal-token` (token trong `data/internal-token`, sinh tự động).
- Verified fact: `opencode run --format json` in mỗi event 1 dòng JSON, mọi event có `sessionID` top-level; text trả lời nằm ở event `{"type":"text","part":{"type":"text","text":"..."}}`. Tiếp nối session: `opencode run -s <sessionID>`. `opencode serve --port 4096 --hostname 0.0.0.0`.
- Test runner: `node --test tests/` — không thêm framework test.
- Commit sau mỗi task (git repo được init ở Task 0).

---

### Task 0: Git init + baseline

**Files:**
- Create: `.gitignore`

**Interfaces:**
- Produces: git repo để các task sau commit.

- [ ] **Step 1: Tạo .gitignore**

```gitignore
node_modules/
data/
workspaces/
*.log
.env
```

- [ ] **Step 2: Init + commit baseline**

```bash
cd /home/sown/workplace/projects/open-trace-bridge
git init
git add .
git commit -m "chore: baseline before step 2 (event ingest working end-to-end)"
```

Expected: commit tạo thành công, `git log --oneline` hiện 1 commit.

---

### Task 1: DB layer + models

**Files:**
- Create: `lib/db.js`, `models/project.model.js`, `models/repo.model.js`, `models/api.model.js`, `models/conversation.model.js`, `models/message.model.js`, `models/apicall.model.js`
- Test: `tests/models.test.js`

**Interfaces:**
- Produces:
  - `lib/db.js`: `getDb()` → singleton `better-sqlite3` Database (path từ `process.env.OTB_DB_PATH || 'data/otb.sqlite'`), tự chạy schema (idempotent `CREATE TABLE IF NOT EXISTS`). `resetDbForTest()` đóng singleton (test dùng).
  - `project.model.js`: `create({slug,name,keyword,system_prompt,teams_webhook_url})→row`, `findBySlug(slug)→row|undefined`, `findById(id)`, `list()→rows`, `update(id, fields)`, `remove(id)`.
  - `repo.model.js`: `create({project_id,git_url,auth_type,token,ssh_key,branch})`, `listByProject(project_id)`, `remove(id)`.
  - `api.model.js`: `create({project_id,name,base_url,api_key,auth_header,allowed_methods,description_md})`, `listByProject(project_id)`, `findByProjectAndName(project_id,name)`, `remove(id)`.
  - `conversation.model.js`: `findActive(project_id, teams_conversation_id)→row|undefined`, `create(project_id, teams_conversation_id)→row (status='active', opencode_session_id=NULL)`, `close(id)`, `setSession(id, sessionId)`, `listByProject(project_id)`.
  - `message.model.js`: `add({conversation_id,direction,user_id,user_name,content})`, `listByConversation(conversation_id)`.
  - `apicall.model.js`: `add({project_id,group_name,method,url,status})`, `listByProject(project_id)`.

- [ ] **Step 1: Cài dependencies**

```bash
npm install better-sqlite3 ejs
```

- [ ] **Step 2: Viết failing test**

```js
// tests/models.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { getDb, resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');

beforeEach(() => { resetDbForTest(); });

test('project CRUD + findBySlug', () => {
  const p = projects.create({
    slug: 'payment', name: 'Payment', keyword: 'payment-bot',
    system_prompt: 'Bạn là investigator', teams_webhook_url: 'https://hook.example/x',
  });
  assert.ok(p.id);
  assert.strictEqual(projects.findBySlug('payment').name, 'Payment');
  projects.update(p.id, { name: 'Payment 2' });
  assert.strictEqual(projects.findById(p.id).name, 'Payment 2');
  assert.strictEqual(projects.list().length, 1);
  projects.remove(p.id);
  assert.strictEqual(projects.findBySlug('payment'), undefined);
});

test('repos and api groups per project', () => {
  const p = projects.create({ slug: 's', name: 'S', keyword: 'k', system_prompt: '', teams_webhook_url: '' });
  repos.create({ project_id: p.id, git_url: 'https://github.com/a/b.git', auth_type: 'https-token', token: 'tok', ssh_key: null, branch: 'main' });
  const g = apis.create({ project_id: p.id, name: 'txn-api', base_url: 'https://api.internal', api_key: 'key1', auth_header: 'Authorization', allowed_methods: 'GET', description_md: '# Txn API' });
  assert.strictEqual(repos.listByProject(p.id).length, 1);
  assert.strictEqual(apis.findByProjectAndName(p.id, 'txn-api').id, g.id);
});

test('conversation lifecycle + messages', () => {
  const p = projects.create({ slug: 'c', name: 'C', keyword: 'k', system_prompt: '', teams_webhook_url: '' });
  assert.strictEqual(convs.findActive(p.id, 'teams-conv-1'), undefined);
  const c1 = convs.create(p.id, 'teams-conv-1');
  assert.strictEqual(convs.findActive(p.id, 'teams-conv-1').id, c1.id);
  convs.setSession(c1.id, 'ses_abc');
  assert.strictEqual(convs.findActive(p.id, 'teams-conv-1').opencode_session_id, 'ses_abc');
  messages.add({ conversation_id: c1.id, direction: 'in', user_id: 'u1', user_name: 'Son', content: 'hi' });
  assert.strictEqual(messages.listByConversation(c1.id).length, 1);
  convs.close(c1.id);
  assert.strictEqual(convs.findActive(p.id, 'teams-conv-1'), undefined);
});
```

- [ ] **Step 3: Chạy test, xác nhận FAIL**

Run: `node --test tests/`
Expected: FAIL — `Cannot find module '../lib/db'`.

- [ ] **Step 4: Implement lib/db.js**

```js
// lib/db.js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  keyword TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  teams_webhook_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  git_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'none',
  token TEXT,
  ssh_key TEXT,
  branch TEXT NOT NULL DEFAULT 'main'
);
CREATE TABLE IF NOT EXISTS api_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  auth_header TEXT NOT NULL DEFAULT 'Authorization',
  allowed_methods TEXT NOT NULL DEFAULT 'GET',
  description_md TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  teams_conversation_id TEXT NOT NULL,
  opencode_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  group_name TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let db = null;

function getDb() {
  if (db) return db;
  const dbPath = process.env.OTB_DB_PATH || 'data/otb.sqlite';
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function resetDbForTest() {
  if (db) { db.close(); db = null; }
}

module.exports = { getDb, resetDbForTest };
```

- [ ] **Step 5: Implement models**

```js
// models/project.model.js
const { getDb } = require('../lib/db');

function create({ slug, name, keyword, system_prompt, teams_webhook_url }) {
  const info = getDb().prepare(
    `INSERT INTO projects (slug, name, keyword, system_prompt, teams_webhook_url)
     VALUES (?, ?, ?, ?, ?)`
  ).run(slug, name, keyword || '', system_prompt || '', teams_webhook_url || '');
  return findById(info.lastInsertRowid);
}
function findById(id) { return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id); }
function findBySlug(slug) { return getDb().prepare('SELECT * FROM projects WHERE slug = ?').get(slug); }
function list() { return getDb().prepare('SELECT * FROM projects ORDER BY id').all(); }
function update(id, fields) {
  const allowed = ['slug', 'name', 'keyword', 'system_prompt', 'teams_webhook_url'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return findById(id);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE projects SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return findById(id);
}
function remove(id) { getDb().prepare('DELETE FROM projects WHERE id = ?').run(id); }

module.exports = { create, findById, findBySlug, list, update, remove };
```

```js
// models/repo.model.js
const { getDb } = require('../lib/db');

function create({ project_id, git_url, auth_type, token, ssh_key, branch }) {
  const info = getDb().prepare(
    `INSERT INTO repos (project_id, git_url, auth_type, token, ssh_key, branch)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(project_id, git_url, auth_type || 'none', token || null, ssh_key || null, branch || 'main');
  return getDb().prepare('SELECT * FROM repos WHERE id = ?').get(info.lastInsertRowid);
}
function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY id').all(project_id);
}
function remove(id) { getDb().prepare('DELETE FROM repos WHERE id = ?').run(id); }

module.exports = { create, listByProject, remove };
```

```js
// models/api.model.js
const { getDb } = require('../lib/db');

function create({ project_id, name, base_url, api_key, auth_header, allowed_methods, description_md }) {
  const info = getDb().prepare(
    `INSERT INTO api_groups (project_id, name, base_url, api_key, auth_header, allowed_methods, description_md)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(project_id, name, base_url, api_key || '', auth_header || 'Authorization',
    allowed_methods || 'GET', description_md || '');
  return getDb().prepare('SELECT * FROM api_groups WHERE id = ?').get(info.lastInsertRowid);
}
function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM api_groups WHERE project_id = ? ORDER BY id').all(project_id);
}
function findByProjectAndName(project_id, name) {
  return getDb().prepare('SELECT * FROM api_groups WHERE project_id = ? AND name = ?').get(project_id, name);
}
function remove(id) { getDb().prepare('DELETE FROM api_groups WHERE id = ?').run(id); }

module.exports = { create, listByProject, findByProjectAndName, remove };
```

```js
// models/conversation.model.js
const { getDb } = require('../lib/db');

function findActive(project_id, teams_conversation_id) {
  return getDb().prepare(
    `SELECT * FROM conversations WHERE project_id = ? AND teams_conversation_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT 1`
  ).get(project_id, teams_conversation_id);
}
function create(project_id, teams_conversation_id) {
  const info = getDb().prepare(
    `INSERT INTO conversations (project_id, teams_conversation_id) VALUES (?, ?)`
  ).run(project_id, teams_conversation_id);
  return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
}
function close(id) {
  getDb().prepare(`UPDATE conversations SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(id);
}
function setSession(id, sessionId) {
  getDb().prepare(`UPDATE conversations SET opencode_session_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(sessionId, id);
}
function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY id DESC').all(project_id);
}

module.exports = { findActive, create, close, setSession, listByProject };
```

```js
// models/message.model.js
const { getDb } = require('../lib/db');

function add({ conversation_id, direction, user_id, user_name, content }) {
  const info = getDb().prepare(
    `INSERT INTO messages (conversation_id, direction, user_id, user_name, content)
     VALUES (?, ?, ?, ?, ?)`
  ).run(conversation_id, direction, user_id || null, user_name || null, content);
  return getDb().prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
}
function listByConversation(conversation_id) {
  return getDb().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversation_id);
}

module.exports = { add, listByConversation };
```

```js
// models/apicall.model.js
const { getDb } = require('../lib/db');

function add({ project_id, group_name, method, url, status }) {
  getDb().prepare(
    `INSERT INTO api_calls (project_id, group_name, method, url, status) VALUES (?, ?, ?, ?, ?)`
  ).run(project_id, group_name, method, url, status ?? null);
}
function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM api_calls WHERE project_id = ? ORDER BY id DESC').all(project_id);
}

module.exports = { add, listByProject };
```

- [ ] **Step 6: Chạy test, xác nhận PASS**

Run: `node --test tests/`
Expected: 3 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json lib/db.js models/ tests/models.test.js
git commit -m "feat: sqlite layer + models (projects/repos/api_groups/conversations/messages/api_calls)"
```

---

### Task 2: eventGateway — strip keyword + lệnh /new

**Files:**
- Modify: `lib/eventGateway.js`
- Test: `tests/eventGateway.test.js`

**Interfaces:**
- Consumes: (không phụ thuộc task khác)
- Produces: `stripHtml(text)→string` (giữ nguyên), `validateEvent(body)→string|null` (giữ nguyên), **mới**: `extractPrompt(rawText, keyword)→{ isNew: boolean, prompt: string }` — strip HTML, bỏ keyword prefix (case-insensitive, chỉ khi ở đầu), nhận diện `/new`. `parseCommand` cũ bị xoá (không còn cú pháp cứng).

- [ ] **Step 1: Viết failing test**

```js
// tests/eventGateway.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { extractPrompt, stripHtml, validateEvent } = require('../lib/eventGateway');

test('stripHtml removes tags', () => {
  assert.strictEqual(stripHtml('<p>payment-bot hi</p>'), 'payment-bot hi');
});

test('extractPrompt strips keyword prefix case-insensitively', () => {
  const r = extractPrompt('<p>Payment-Bot hi tìm hiểu lỗi txn_123</p>', 'payment-bot');
  assert.strictEqual(r.isNew, false);
  assert.strictEqual(r.prompt, 'hi tìm hiểu lỗi txn_123');
});

test('extractPrompt keeps text when keyword absent or mid-sentence', () => {
  assert.strictEqual(extractPrompt('hi payment-bot oi', 'payment-bot').prompt, 'hi payment-bot oi');
});

test('extractPrompt detects /new after keyword', () => {
  const r = extractPrompt('payment-bot /new', 'payment-bot');
  assert.strictEqual(r.isNew, true);
});

test('extractPrompt with empty keyword just strips html', () => {
  assert.strictEqual(extractPrompt('<p>hello</p>', '').prompt, 'hello');
});

test('validateEvent still works', () => {
  assert.strictEqual(validateEvent({ raw: { text: 'x' }, user: {}, channel: {} }), null);
  assert.ok(validateEvent({}));
});
```

- [ ] **Step 2: Chạy, xác nhận FAIL**

Run: `node --test tests/eventGateway.test.js`
Expected: FAIL — `extractPrompt is not a function`.

- [ ] **Step 3: Implement**

Thay toàn bộ nội dung `lib/eventGateway.js`:

```js
// lib/eventGateway.js
function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip keyword prefix (nếu có, case-insensitive, chỉ ở đầu chuỗi) và nhận diện lệnh /new.
// Mọi text còn lại forward nguyên văn cho agent — không còn parse cú pháp cứng.
function extractPrompt(rawText, keyword) {
  let text = stripHtml(rawText);
  const kw = String(keyword || '').trim();
  if (kw && text.toLowerCase().startsWith(kw.toLowerCase())) {
    text = text.slice(kw.length).trim();
  }
  const isNew = /^\/new\b/.test(text);
  return { isNew, prompt: text };
}

function validateEvent(body) {
  if (!body || typeof body !== 'object') return 'Payload rỗng hoặc không hợp lệ';
  if (!body.raw || typeof body.raw.text !== 'string') return 'Thiếu raw.text';
  if (!body.user) return 'Thiếu user';
  if (!body.channel) return 'Thiếu channel';
  return null;
}

module.exports = { stripHtml, extractPrompt, validateEvent };
```

**Lưu ý:** `server.js` hiện đang import `parseCommand` — sẽ bị lỗi khi restart. Không sao: Task 3 viết lại `server.js` hoàn toàn. KHÔNG restart pm2 giữa Task 2 và Task 3.

- [ ] **Step 4: Chạy test PASS**

Run: `node --test tests/eventGateway.test.js`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/eventGateway.js tests/eventGateway.test.js
git commit -m "feat: extractPrompt (strip keyword, /new detection), drop rigid parseCommand"
```

---

### Task 3: MVC scaffold + Admin UI project CRUD

**Files:**
- Modify: `server.js` (viết lại)
- Create: `routes/admin.routes.js`, `routes/events.routes.js`, `controllers/project.controller.js`, `controllers/event.controller.js` (tạm thời), `views/layout-head.ejs`, `views/layout-foot.ejs`, `views/projects/list.ejs`, `views/projects/form.ejs`

**Interfaces:**
- Consumes: models Task 1.
- Produces:
  - `server.js` export `app` (module.exports = app) và chỉ `listen` khi `require.main === module` (để test/e2e sau này).
  - URL admin: `GET /admin/projects`, `GET /admin/projects/new`, `POST /admin/projects`, `GET /admin/projects/:id/edit`, `POST /admin/projects/:id`, `POST /admin/projects/:id/delete`.
  - `controllers/event.controller.js` export `handleEvent(req, res)` — Task 3 chỉ là stub trả ack (pipeline thật ở Task 8).

- [ ] **Step 1: Viết lại server.js**

```js
// server.js
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/admin', require('./routes/admin.routes'));
app.use('/api', require('./routes/events.routes'));

app.use((req, res) => {
  console.log('Unhandled route:', req.method, req.originalUrl);
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 6666;
if (require.main === module) {
  app.listen(PORT, () => console.log(`OpenTraceBridge server listening on port ${PORT}`));
}
module.exports = app;
```

- [ ] **Step 2: Routes**

```js
// routes/admin.routes.js
const router = require('express').Router();
const pc = require('../controllers/project.controller');

router.get('/', (req, res) => res.redirect('/admin/projects'));
router.get('/projects', pc.listProjects);
router.get('/projects/new', pc.newProjectForm);
router.post('/projects', pc.createProject);
router.get('/projects/:id/edit', pc.editProjectForm);
router.post('/projects/:id', pc.updateProject);
router.post('/projects/:id/delete', pc.deleteProject);

module.exports = router;
```

```js
// routes/events.routes.js
const router = require('express').Router();
const ec = require('../controllers/event.controller');

router.get('/events/:slug', ec.handleEvent);
router.post('/events/:slug', ec.handleEvent);
// Route cũ (Step 1) — giữ để Power Automate cũ không lỗi, nhắc đổi URL
router.all('/events', (req, res) => {
  res.status(200).json({
    handled: false,
    reply: 'URL này đã đổi. Dùng /api/events/<project-slug> — tạo project tại /admin/projects.',
  });
});

module.exports = router;
```

- [ ] **Step 3: Project controller**

```js
// controllers/project.controller.js
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');

function listProjects(req, res) {
  res.render('projects/list', { projects: projects.list() });
}
function newProjectForm(req, res) {
  res.render('projects/form', { project: null, repos: [], apis: [], error: null });
}
function createProject(req, res) {
  const { slug, name, keyword, system_prompt, teams_webhook_url } = req.body;
  if (!slug || !name) {
    return res.status(400).render('projects/form', {
      project: req.body, repos: [], apis: [], error: 'slug và name là bắt buộc',
    });
  }
  if (projects.findBySlug(slug)) {
    return res.status(400).render('projects/form', {
      project: req.body, repos: [], apis: [], error: `slug "${slug}" đã tồn tại`,
    });
  }
  const p = projects.create({ slug, name, keyword, system_prompt, teams_webhook_url });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function editProjectForm(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  res.render('projects/form', {
    project: p, repos: repos.listByProject(p.id), apis: apis.listByProject(p.id), error: null,
  });
}
function updateProject(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const { slug, name, keyword, system_prompt, teams_webhook_url } = req.body;
  projects.update(p.id, { slug, name, keyword, system_prompt, teams_webhook_url });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteProject(req, res) {
  projects.remove(req.params.id);
  res.redirect('/admin/projects');
}

module.exports = { listProjects, newProjectForm, createProject, editProjectForm, updateProject, deleteProject };
```

- [ ] **Step 4: Event controller stub (pipeline thật ở Task 8)**

```js
// controllers/event.controller.js
const projects = require('../models/project.model');

function handleEvent(req, res) {
  const project = projects.findBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: `Không có project slug "${req.params.slug}"` });
  res.json({ handled: true, project: project.slug, note: 'pipeline chưa nối (Task 8)' });
}

module.exports = { handleEvent };
```

- [ ] **Step 5: EJS views**

```html
<!-- views/layout-head.ejs -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenTraceBridge Admin</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: .4rem .6rem; text-align: left; }
    label { display: block; margin-top: .8rem; font-weight: 600; }
    input[type=text], input[type=url], textarea, select { width: 100%; padding: .4rem; box-sizing: border-box; }
    textarea { min-height: 6rem; font-family: monospace; }
    .error { color: #b00; }
    .row { display: flex; gap: 1rem; }
    .row > * { flex: 1; }
    fieldset { margin-top: 1.5rem; }
    .inline-form { display: inline; }
    button { margin-top: .8rem; padding: .4rem 1rem; cursor: pointer; }
    code { background: #f4f4f4; padding: .1rem .3rem; }
  </style>
</head>
<body>
<nav><a href="/admin/projects">Projects</a></nav>
<hr>
```

```html
<!-- views/layout-foot.ejs -->
</body>
</html>
```

```html
<!-- views/projects/list.ejs -->
<%- include('../layout-head') %>
<h1>Projects</h1>
<p><a href="/admin/projects/new">+ New project</a></p>
<table>
  <tr><th>Slug</th><th>Name</th><th>Keyword</th><th>Event URL</th><th></th></tr>
  <% for (const p of projects) { %>
  <tr>
    <td><%= p.slug %></td>
    <td><%= p.name %></td>
    <td><%= p.keyword %></td>
    <td><code>/api/events/<%= p.slug %></code></td>
    <td>
      <a href="/admin/projects/<%= p.id %>/edit">edit</a>
      <form class="inline-form" method="post" action="/admin/projects/<%= p.id %>/delete"
            onsubmit="return confirm('Xoá project <%= p.slug %>?')">
        <button>delete</button>
      </form>
    </td>
  </tr>
  <% } %>
</table>
<%- include('../layout-foot') %>
```

```html
<!-- views/projects/form.ejs -->
<%- include('../layout-head') %>
<h1><%= project && project.id ? 'Edit: ' + project.name : 'New project' %></h1>
<% if (error) { %><p class="error"><%= error %></p><% } %>
<form method="post" action="<%= project && project.id ? '/admin/projects/' + project.id : '/admin/projects' %>">
  <div class="row">
    <div><label>Slug (dùng trong URL event)</label>
      <input type="text" name="slug" value="<%= project ? project.slug : '' %>" required></div>
    <div><label>Name</label>
      <input type="text" name="name" value="<%= project ? project.name : '' %>" required></div>
    <div><label>Keyword (prefix trong Teams, vd payment-bot)</label>
      <input type="text" name="keyword" value="<%= project ? (project.keyword || '') : '' %>"></div>
  </div>
  <label>System prompt (markdown)</label>
  <textarea name="system_prompt"><%= project ? (project.system_prompt || '') : '' %></textarea>
  <label>Teams webhook URL (nhận kết quả)</label>
  <input type="url" name="teams_webhook_url" value="<%= project ? (project.teams_webhook_url || '') : '' %>">
  <button>Save</button>
</form>

<% if (project && project.id) { %>
  <p>Event URL cho Power Automate:
    <code>https://6666.sowndev.com/api/events/<%= project.slug %>?text=...&conversationId=...&userId=...&userName=...</code>
  </p>
  <!-- Task 4 sẽ thêm section Repos + API groups tại đây -->
<% } %>
<%- include('../layout-foot') %>
```

- [ ] **Step 6: Verify thủ công**

```bash
node server.js &
sleep 1
curl -s http://localhost:6666/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:6666/admin/projects        # 200
curl -s -X POST http://localhost:6666/admin/projects -d "slug=payment&name=Payment&keyword=payment-bot" -o /dev/null -w "%{http_code}\n"   # 302
curl -s http://localhost:6666/api/events/payment | grep -o '"handled":true'          # có
curl -s http://localhost:6666/api/events/unknown -o /dev/null -w "%{http_code}\n"    # 404
kill %1
```

Expected: các mã như comment. Sau đó `node --test tests/` vẫn pass toàn bộ.

- [ ] **Step 7: Commit**

```bash
git add server.js routes/ controllers/ views/
git commit -m "feat: MVC scaffold + admin project CRUD + event route per slug"
```

---

### Task 4: Admin UI — Repos & API groups trong trang project

**Files:**
- Modify: `routes/admin.routes.js`, `controllers/project.controller.js`, `views/projects/form.ejs`

**Interfaces:**
- Consumes: `repo.model`, `api.model` (Task 1).
- Produces: URL `POST /admin/projects/:id/repos`, `POST /admin/projects/:id/repos/:repoId/delete`, `POST /admin/projects/:id/apis`, `POST /admin/projects/:id/apis/:apiId/delete`.

- [ ] **Step 1: Thêm routes**

Thêm vào `routes/admin.routes.js` trước `module.exports`:

```js
router.post('/projects/:id/repos', pc.addRepo);
router.post('/projects/:id/repos/:repoId/delete', pc.deleteRepo);
router.post('/projects/:id/apis', pc.addApiGroup);
router.post('/projects/:id/apis/:apiId/delete', pc.deleteApiGroup);
```

- [ ] **Step 2: Thêm controller actions**

Thêm vào `controllers/project.controller.js` (và export thêm 4 hàm):

```js
function addRepo(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const { git_url, auth_type, token, ssh_key, branch } = req.body;
  if (git_url) repos.create({ project_id: p.id, git_url, auth_type, token, ssh_key, branch });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteRepo(req, res) {
  repos.remove(req.params.repoId);
  res.redirect(`/admin/projects/${req.params.id}/edit`);
}
function addApiGroup(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const { name, base_url, api_key, auth_header, allowed_methods, description_md } = req.body;
  if (name && base_url) {
    apis.create({ project_id: p.id, name, base_url, api_key, auth_header, allowed_methods, description_md });
  }
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteApiGroup(req, res) {
  apis.remove(req.params.apiId);
  res.redirect(`/admin/projects/${req.params.id}/edit`);
}

module.exports = {
  listProjects, newProjectForm, createProject, editProjectForm, updateProject, deleteProject,
  addRepo, deleteRepo, addApiGroup, deleteApiGroup,
};
```

- [ ] **Step 3: Thêm 2 section vào views/projects/form.ejs**

Thay comment `<!-- Task 4 sẽ thêm section Repos + API groups tại đây -->` bằng:

```html
<fieldset>
  <legend>Repos (<%= repos.length %>)</legend>
  <table>
    <tr><th>Git URL</th><th>Auth</th><th>Branch</th><th></th></tr>
    <% for (const r of repos) { %>
    <tr>
      <td><%= r.git_url %></td><td><%= r.auth_type %></td><td><%= r.branch %></td>
      <td><form class="inline-form" method="post"
            action="/admin/projects/<%= project.id %>/repos/<%= r.id %>/delete"><button>x</button></form></td>
    </tr>
    <% } %>
  </table>
  <form method="post" action="/admin/projects/<%= project.id %>/repos">
    <div class="row">
      <div><label>Git URL</label><input type="text" name="git_url" required
        placeholder="https://github.com/org/repo.git hoặc git@github.com:org/repo.git"></div>
      <div><label>Auth</label>
        <select name="auth_type">
          <option value="none">none</option>
          <option value="https-token">https-token</option>
          <option value="ssh">ssh</option>
        </select></div>
      <div><label>Branch</label><input type="text" name="branch" value="main"></div>
    </div>
    <label>Token (nếu https-token)</label><input type="text" name="token">
    <label>SSH private key (nếu ssh)</label><textarea name="ssh_key"></textarea>
    <button>Add repo</button>
  </form>
</fieldset>

<fieldset>
  <legend>API groups (<%= apis.length %>) — mỗi group 1 API key</legend>
  <table>
    <tr><th>Name</th><th>Base URL</th><th>Methods</th><th></th></tr>
    <% for (const a of apis) { %>
    <tr>
      <td><%= a.name %></td><td><%= a.base_url %></td><td><%= a.allowed_methods %></td>
      <td><form class="inline-form" method="post"
            action="/admin/projects/<%= project.id %>/apis/<%= a.id %>/delete"><button>x</button></form></td>
    </tr>
    <% } %>
  </table>
  <form method="post" action="/admin/projects/<%= project.id %>/apis">
    <div class="row">
      <div><label>Name</label><input type="text" name="name" required placeholder="transaction-api"></div>
      <div><label>Base URL</label><input type="url" name="base_url" required
        placeholder="https://api.internal.example"></div>
    </div>
    <div class="row">
      <div><label>API key</label><input type="text" name="api_key"></div>
      <div><label>Auth header</label><input type="text" name="auth_header" value="Authorization"></div>
      <div><label>Allowed methods (phẩy)</label><input type="text" name="allowed_methods" value="GET"></div>
    </div>
    <label>Description (markdown — mô tả kỹ endpoints, params, filters cho agent đọc)</label>
    <textarea name="description_md"></textarea>
    <button>Add API group</button>
  </form>
</fieldset>
```

- [ ] **Step 4: Verify thủ công**

```bash
node server.js &
sleep 1
PID=$(curl -s -X POST http://localhost:6666/admin/projects -d "slug=t4&name=T4" -o /dev/null -w "%{redirect_url}" | grep -o '[0-9]*')
curl -s -X POST http://localhost:6666/admin/projects/$PID/repos -d "git_url=https://github.com/a/b.git&auth_type=none&branch=main" -o /dev/null -w "%{http_code}\n"   # 302
curl -s -X POST http://localhost:6666/admin/projects/$PID/apis -d "name=txn&base_url=https://api.x&allowed_methods=GET" -o /dev/null -w "%{http_code}\n"             # 302
curl -s http://localhost:6666/admin/projects/$PID/edit | grep -c 'github.com/a/b.git'   # >= 1
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add routes/admin.routes.js controllers/project.controller.js views/projects/form.ejs
git commit -m "feat: repos + api groups management in project edit page"
```

---

### Task 5: workspace.service — clone/pull + sinh AGENTS.md + opencode.json

**Files:**
- Create: `services/workspace.service.js`
- Test: `tests/workspace.test.js`

**Interfaces:**
- Consumes: project row, repo rows, api_group rows (shape từ Task 1).
- Produces:
  - `buildAgentsMd(project, apiGroups)→string` — pure function.
  - `buildOpencodeConfig(project)→object` — pure function (đọc `data/internal-token` qua `getInternalToken()`).
  - `getInternalToken()→string` — đọc `data/internal-token`, tự sinh (32 hex bytes) nếu chưa có.
  - `ensureWorkspace(project, repoRows)→Promise<string>` — tạo `workspaces/<slug>/`, clone (nếu chưa) hoặc `git pull` từng repo vào `workspaces/<slug>/<repo-dirname>/`, ghi `AGENTS.md` + `opencode.json`. Trả absolute path workspace. Throw Error có message rõ nếu git fail.

- [ ] **Step 1: Viết failing test (pure functions)**

```js
// tests/workspace.test.js
const { test } = require('node:test');
const assert = require('node:assert');
process.env.OTB_DB_PATH = ':memory:';
const { buildAgentsMd, buildOpencodeConfig, repoDirName } = require('../services/workspace.service');

const project = { id: 1, slug: 'payment', name: 'Payment', keyword: 'payment-bot',
  system_prompt: 'Bạn là incident investigator.', teams_webhook_url: '' };
const groups = [{
  name: 'txn-api', base_url: 'https://api.internal', api_key: 'SECRET-KEY',
  auth_header: 'Authorization', allowed_methods: 'GET', description_md: '## GET /transactions/{id}',
}];

test('buildAgentsMd contains prompt + api docs but NEVER the key', () => {
  const md = buildAgentsMd(project, groups);
  assert.ok(md.includes('Bạn là incident investigator.'));
  assert.ok(md.includes('txn-api'));
  assert.ok(md.includes('GET /transactions/{id}'));
  assert.ok(md.includes('call_api'));
  assert.ok(!md.includes('SECRET-KEY'));
});

test('buildOpencodeConfig denies edit/bash/webfetch and wires mcp', () => {
  const cfg = buildOpencodeConfig(project);
  assert.strictEqual(cfg.permission.edit, 'deny');
  assert.strictEqual(cfg.permission.bash, 'deny');
  assert.strictEqual(cfg.permission.webfetch, 'deny');
  assert.strictEqual(cfg.mcp.otb.type, 'local');
  assert.ok(cfg.mcp.otb.command[1].endsWith('mcp/callapi-stdio.js'));
  assert.strictEqual(cfg.mcp.otb.environment.OTB_PROJECT_SLUG, 'payment');
  assert.ok(cfg.mcp.otb.environment.OTB_INTERNAL_TOKEN.length >= 32);
});

test('repoDirName from url', () => {
  assert.strictEqual(repoDirName('https://github.com/org/my-repo.git'), 'my-repo');
  assert.strictEqual(repoDirName('git@github.com:org/other.git'), 'other');
});
```

- [ ] **Step 2: Chạy, FAIL**

Run: `node --test tests/workspace.test.js` — Expected: FAIL (module chưa tồn tại).

- [ ] **Step 3: Implement**

```js
// services/workspace.service.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const WORKSPACES_DIR = process.env.OTB_WORKSPACES_DIR || path.join(process.cwd(), 'workspaces');
const DATA_DIR = path.join(process.cwd(), 'data');

function getInternalToken() {
  const f = path.join(DATA_DIR, 'internal-token');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(f, 'utf8').trim();
}

function repoDirName(gitUrl) {
  return gitUrl.split('/').pop().replace(/\.git$/, '').replace(/[^\w.-]/g, '_');
}

function buildAgentsMd(project, apiGroups) {
  const apiSections = apiGroups.map((g) => `
## API group: ${g.name}

- Base URL: \`${g.base_url}\`
- Allowed methods: ${g.allowed_methods}
- Gọi qua MCP tool \`call_api\` với \`group: "${g.name}"\`. KHÔNG cần API key — server tự gắn.

${g.description_md}
`).join('\n');

  return `# ${project.name} — Incident Investigator

${project.system_prompt}

# Quy tắc

- Bạn CHỈ được đọc source code trong workspace này và gọi các API qua MCP tool \`call_api\`.
- Không sửa code, không chạy lệnh shell, không truy cập URL ngoài danh sách API bên dưới.
- Khi phân tích xong, trả lời NGẮN GỌN bằng markdown: tóm tắt, nguyên nhân khả dĩ (kèm file:line nếu có), bằng chứng, đề xuất bước tiếp theo.

# Các API có thể gọi (qua tool call_api(group, method, path, params))
${apiSections || '\n(Chưa khai báo API nào)'}
`;
}

function buildOpencodeConfig(project) {
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
    mcp: {
      otb: {
        type: 'local',
        command: ['node', path.join(__dirname, '..', 'mcp', 'callapi-stdio.js')],
        enabled: true,
        environment: {
          OTB_PROJECT_SLUG: project.slug,
          OTB_BASE: `http://127.0.0.1:${process.env.PORT || 6666}`,
          OTB_INTERNAL_TOKEN: getInternalToken(),
        },
      },
    },
  };
}

function gitEnvFor(repo, keyFile) {
  if (repo.auth_type === 'ssh' && repo.ssh_key) {
    fs.writeFileSync(keyFile, repo.ssh_key.trim() + '\n', { mode: 0o600 });
    return { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyFile} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes` };
  }
  return { ...process.env };
}

function cloneUrlFor(repo) {
  if (repo.auth_type === 'https-token' && repo.token) {
    return repo.git_url.replace(/^https:\/\//, `https://x-access-token:${repo.token}@`);
  }
  return repo.git_url;
}

async function ensureWorkspace(project, repoRows, apiGroups) {
  const ws = path.join(WORKSPACES_DIR, project.slug);
  const keysDir = path.join(WORKSPACES_DIR, '.keys');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(keysDir, { recursive: true });

  for (const repo of repoRows) {
    const dir = path.join(ws, repoDirName(repo.git_url));
    const keyFile = path.join(keysDir, `repo-${repo.id}`);
    const env = gitEnvFor(repo, keyFile);
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        await execFileP('git', ['-C', dir, 'pull', '--ff-only'], { env, timeout: 120000 });
      } else {
        await execFileP('git', ['clone', '--depth', '1', '--branch', repo.branch || 'main',
          cloneUrlFor(repo), dir], { env, timeout: 300000 });
      }
    } catch (err) {
      throw new Error(`Git fail cho repo ${repo.git_url}: ${err.stderr || err.message}`);
    }
  }

  fs.writeFileSync(path.join(ws, 'AGENTS.md'), buildAgentsMd(project, apiGroups));
  fs.writeFileSync(path.join(ws, 'opencode.json'), JSON.stringify(buildOpencodeConfig(project), null, 2));
  return ws;
}

module.exports = { buildAgentsMd, buildOpencodeConfig, getInternalToken, ensureWorkspace, repoDirName };
```

- [ ] **Step 4: Chạy test PASS**

Run: `node --test tests/workspace.test.js` — Expected: 3 pass.

- [ ] **Step 5: Verify clone thật (repo public nhỏ)**

```bash
node -e "
const ws = require('./services/workspace.service');
ws.ensureWorkspace(
  { slug: 'ws-test', name: 'T', system_prompt: 'x', keyword: '' },
  [{ id: 999, git_url: 'https://github.com/octocat/Hello-World.git', auth_type: 'none', branch: 'master' }],
  []
).then(p => { console.log('OK', p); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
"
ls workspaces/ws-test/           # Hello-World/ AGENTS.md opencode.json
rm -rf workspaces/ws-test
```

- [ ] **Step 6: Commit**

```bash
git add services/workspace.service.js tests/workspace.test.js
git commit -m "feat: workspace service (git clone/pull, AGENTS.md, opencode.json, internal token)"
```

---

### Task 6: Internal call-api endpoint (enforcement + audit)

**Files:**
- Create: `services/callapi.service.js`, `routes/internal.routes.js`
- Modify: `server.js` (mount route)
- Test: `tests/callapi.test.js`

**Interfaces:**
- Consumes: `api.model.findByProjectAndName`, `project.model.findBySlug`, `apicall.model.add`, `getInternalToken` (Task 5).
- Produces:
  - `services/callapi.service.js`: `executeApiCall({ project, groupName, method, path: apiPath, params })→Promise<{status, body}>`. Enforce: group tồn tại; method nằm trong `allowed_methods`; URL cuối = `base_url + path` không escape ra ngoài base (check bằng `new URL()` + `startsWith`); tự gắn header `[auth_header]: api_key`; params là object → query string; timeout 30s; ghi `api_calls` audit.
  - Route `POST /internal/call-api` body `{ slug, group, method, path, params }`, header `x-otb-internal-token` bắt buộc — sai token → 403.

- [ ] **Step 1: Viết failing test (enforcement thuần)**

```js
// tests/callapi.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const apis = require('../models/api.model');
const { executeApiCall } = require('../services/callapi.service');

beforeEach(() => resetDbForTest());

function setup() {
  const p = projects.create({ slug: 'p6', name: 'P6', keyword: '', system_prompt: '', teams_webhook_url: '' });
  apis.create({ project_id: p.id, name: 'txn', base_url: 'https://api.example.com/v1',
    api_key: 'K', auth_header: 'Authorization', allowed_methods: 'GET', description_md: '' });
  return p;
}

test('rejects unknown group', async () => {
  const p = setup();
  await assert.rejects(
    executeApiCall({ project: p, groupName: 'nope', method: 'GET', path: '/x', params: {} }),
    /không tồn tại/i);
});

test('rejects method not allowed', async () => {
  const p = setup();
  await assert.rejects(
    executeApiCall({ project: p, groupName: 'txn', method: 'POST', path: '/x', params: {} }),
    /method/i);
});

test('rejects path escaping base url', async () => {
  const p = setup();
  await assert.rejects(
    executeApiCall({ project: p, groupName: 'txn', method: 'GET', path: '/../../evil', params: {} }),
    /base URL/i);
  await assert.rejects(
    executeApiCall({ project: p, groupName: 'txn', method: 'GET', path: 'https://evil.com/x', params: {} }),
    /base URL/i);
});
```

- [ ] **Step 2: Chạy, FAIL**

Run: `node --test tests/callapi.test.js` — Expected: FAIL (module chưa có).

- [ ] **Step 3: Implement service**

```js
// services/callapi.service.js
const apis = require('../models/api.model');
const apicalls = require('../models/apicall.model');

async function executeApiCall({ project, groupName, method, path: apiPath, params }) {
  const group = apis.findByProjectAndName(project.id, groupName);
  if (!group) throw new Error(`API group "${groupName}" không tồn tại trong project ${project.slug}`);

  const m = String(method || 'GET').toUpperCase();
  const allowed = group.allowed_methods.split(',').map((s) => s.trim().toUpperCase());
  if (!allowed.includes(m)) throw new Error(`Method ${m} không được phép (allowed: ${group.allowed_methods})`);

  const base = group.base_url.replace(/\/$/, '');
  const url = new URL(base + '/' + String(apiPath || '').replace(/^\//, ''));
  if (!url.href.startsWith(base)) throw new Error(`Path vượt ra ngoài base URL đã khai báo`);
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }

  const headers = { accept: 'application/json' };
  if (group.api_key) headers[group.auth_header.toLowerCase()] = group.api_key;

  let status = null;
  try {
    const resp = await fetch(url.href, { method: m, headers, signal: AbortSignal.timeout(30000) });
    status = resp.status;
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status, body };
  } finally {
    apicalls.add({ project_id: project.id, group_name: groupName, method: m, url: url.href, status });
  }
}

module.exports = { executeApiCall };
```

- [ ] **Step 4: Route + mount**

```js
// routes/internal.routes.js
const router = require('express').Router();
const projects = require('../models/project.model');
const { executeApiCall } = require('../services/callapi.service');
const { getInternalToken } = require('../services/workspace.service');

router.post('/call-api', async (req, res) => {
  if (req.get('x-otb-internal-token') !== getInternalToken()) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { slug, group, method, path, params } = req.body || {};
  const project = projects.findBySlug(slug);
  if (!project) return res.status(404).json({ error: `project "${slug}" không tồn tại` });
  try {
    const result = await executeApiCall({ project, groupName: group, method, path, params });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
```

Trong `server.js`, thêm sau dòng mount `/api`:

```js
app.use('/internal', require('./routes/internal.routes'));
```

- [ ] **Step 5: Chạy test PASS + verify route**

Run: `node --test tests/callapi.test.js` — Expected: 3 pass.

```bash
node server.js &
sleep 1
curl -s -X POST http://localhost:6666/internal/call-api -H 'content-type: application/json' -d '{}' -o /dev/null -w "%{http_code}\n"   # 403 (thiếu token)
TOKEN=$(cat data/internal-token)
curl -s -X POST http://localhost:6666/internal/call-api -H "x-otb-internal-token: $TOKEN" -H 'content-type: application/json' -d '{"slug":"nope"}' -o /dev/null -w "%{http_code}\n"  # 404
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add services/callapi.service.js routes/internal.routes.js server.js tests/callapi.test.js
git commit -m "feat: internal call-api endpoint with enforcement (base url, methods, key injection, audit)"
```

---

### Task 7: MCP stdio tool `call_api`

**Files:**
- Create: `mcp/callapi-stdio.js`

**Interfaces:**
- Consumes: env `OTB_PROJECT_SLUG`, `OTB_BASE`, `OTB_INTERNAL_TOKEN` (do opencode.json Task 5 cung cấp); endpoint `/internal/call-api` (Task 6).
- Produces: MCP server stdio tên `otb` với tool `call_api(group, method, path, params?)` — được opencode load qua `opencode.json`.

- [ ] **Step 1: Cài SDK**

```bash
npm install @modelcontextprotocol/sdk zod
```

- [ ] **Step 2: Implement**

```js
// mcp/callapi-stdio.js
// MCP stdio server: expose 1 tool call_api — forward về Express /internal/call-api.
// Chạy bởi opencode (config trong workspaces/<slug>/opencode.json), KHÔNG chạy tay.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const SLUG = process.env.OTB_PROJECT_SLUG;
const BASE = process.env.OTB_BASE || 'http://127.0.0.1:6666';
const TOKEN = process.env.OTB_INTERNAL_TOKEN;

const server = new McpServer({ name: 'otb', version: '1.0.0' });

server.tool(
  'call_api',
  'Gọi API nội bộ đã khai báo cho project. Đọc AGENTS.md để biết group nào có endpoint/params gì. Server tự gắn API key.',
  {
    group: z.string().describe('Tên API group (xem AGENTS.md)'),
    method: z.string().default('GET').describe('HTTP method, thường là GET'),
    path: z.string().describe('Path tương đối dưới base URL, vd /transactions/txn_123'),
    params: z.record(z.string()).optional().describe('Query params'),
  },
  async ({ group, method, path, params }) => {
    const resp = await fetch(`${BASE}/internal/call-api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-otb-internal-token': TOKEN },
      body: JSON.stringify({ slug: SLUG, group, method, path, params: params || {} }),
      signal: AbortSignal.timeout(35000),
    });
    const data = await resp.json();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

new Promise(async () => {
  await server.connect(new StdioServerTransport());
});
```

- [ ] **Step 3: Verify script khởi động được (smoke)**

```bash
OTB_PROJECT_SLUG=x OTB_INTERNAL_TOKEN=t timeout 2 node mcp/callapi-stdio.js < /dev/null; echo "exit=$? (124=timeout là ĐÚNG — server chờ stdin)"
```

Expected: `exit=124` (script sống chờ stdio, không crash ngay). Nếu crash ngay (exit 1) → đọc lỗi import, sửa đường dẫn require theo version SDK đã cài.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json mcp/callapi-stdio.js
git commit -m "feat: MCP stdio tool call_api forwarding to internal endpoint"
```

---

### Task 8: opencode.service + webhook.service + nối pipeline thật

**Files:**
- Create: `services/opencode.service.js`, `services/webhook.service.js`
- Modify: `controllers/event.controller.js` (viết lại toàn bộ)
- Test: `tests/opencode-parse.test.js`

**Interfaces:**
- Consumes: `extractPrompt` (Task 2), models (Task 1), `ensureWorkspace` (Task 5).
- Produces:
  - `opencode.service.js`: `parseRunOutput(stdout)→{sessionId, text}` (pure, testable); `runPrompt({ dir, sessionId, text })→Promise<{sessionId, text}>` — spawn `opencode run --format json [-s sessionId] "<text>"` cwd=dir, timeout 300000ms → kill; reject với Error message rõ khi exit≠0/timeout.
  - `webhook.service.js`: `sendTeamsMessage(webhookUrl, markdownText)→Promise<void>` — POST Adaptive Card wrap; throw nếu non-2xx.
  - `event.controller.handleEvent` — pipeline đầy đủ theo REQUIREMENT.md §7.

- [ ] **Step 1: Failing test cho parser**

```js
// tests/opencode-parse.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseRunOutput } = require('../services/opencode.service');

// Shape thật đã verify bằng opencode v1.2.10 (xem Global Constraints)
const sample = [
  '{"type":"step_start","timestamp":1,"sessionID":"ses_abc","part":{"type":"step-start"}}',
  '{"type":"text","timestamp":2,"sessionID":"ses_abc","part":{"type":"text","text":"Hello "}}',
  '{"type":"text","timestamp":3,"sessionID":"ses_abc","part":{"type":"text","text":"world"}}',
  '{"type":"step_finish","timestamp":4,"sessionID":"ses_abc","part":{"type":"step-finish","reason":"stop"}}',
  'not-json-line-should-be-ignored',
].join('\n');

test('parseRunOutput extracts sessionId and concatenated text', () => {
  const r = parseRunOutput(sample);
  assert.strictEqual(r.sessionId, 'ses_abc');
  assert.strictEqual(r.text, 'Hello world');
});

test('parseRunOutput empty output', () => {
  const r = parseRunOutput('');
  assert.strictEqual(r.sessionId, null);
  assert.strictEqual(r.text, '');
});
```

- [ ] **Step 2: Chạy, FAIL** — `node --test tests/opencode-parse.test.js`

- [ ] **Step 3: Implement opencode.service.js**

```js
// services/opencode.service.js
const { spawn } = require('child_process');

const TIMEOUT_MS = 300000;

function parseRunOutput(stdout) {
  let sessionId = null;
  const chunks = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!sessionId && ev.sessionID) sessionId = ev.sessionID;
    if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') chunks.push(ev.part.text);
  }
  return { sessionId, text: chunks.join('') };
}

function runPrompt({ dir, sessionId, text }) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--format', 'json'];
    if (sessionId) args.push('-s', sessionId);
    args.push(text);
    const child = spawn('opencode', args, { cwd: dir, env: process.env });

    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`opencode timeout sau ${TIMEOUT_MS / 60000} phút`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`opencode exit ${code}: ${stderr.slice(0, 500)}`));
      const parsed = parseRunOutput(stdout);
      if (!parsed.sessionId) return reject(new Error(`Không parse được sessionID từ output opencode`));
      resolve(parsed);
    });
  });
}

module.exports = { parseRunOutput, runPrompt };
```

- [ ] **Step 4: Implement webhook.service.js**

```js
// services/webhook.service.js
// Gửi message về Teams qua webhook của project (Power Automate "When a Teams webhook
// request is received" hoặc Incoming Webhook — cả 2 nhận Adaptive Card payload này).
async function sendTeamsMessage(webhookUrl, markdownText) {
  if (!webhookUrl) throw new Error('Project chưa cấu hình teams_webhook_url');
  const payload = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [{ type: 'TextBlock', text: markdownText, wrap: true }],
      },
    }],
  };
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Webhook trả ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
}

module.exports = { sendTeamsMessage };
```

- [ ] **Step 5: Viết lại event.controller.js (pipeline REQUIREMENT.md §7)**

```js
// controllers/event.controller.js
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const { extractPrompt } = require('../lib/eventGateway');
const { ensureWorkspace } = require('../services/workspace.service');
const { runPrompt } = require('../services/opencode.service');
const { sendTeamsMessage } = require('../services/webhook.service');

function eventFromRequest(req) {
  if (req.method === 'GET') {
    const q = req.query;
    return {
      text: q.text || '', userId: q.userId || '', userName: q.userName || '',
      conversationId: q.conversationId || '',
    };
  }
  const b = req.body || {};
  return {
    text: (b.raw && b.raw.text) || '', userId: (b.user && b.user.id) || '',
    userName: (b.user && b.user.name) || '',
    conversationId: (b.channel && b.channel.conversationId) || '',
  };
}

async function investigate(project, conv, prompt) {
  const ws = await ensureWorkspace(project, repos.listByProject(project.id), apis.listByProject(project.id));
  const result = await runPrompt({ dir: ws, sessionId: conv.opencode_session_id, text: prompt });
  if (!conv.opencode_session_id) convs.setSession(conv.id, result.sessionId);
  return result.text || '(agent không trả text)';
}

function handleEvent(req, res) {
  const project = projects.findBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: `Không có project slug "${req.params.slug}"` });

  const ev = eventFromRequest(req);
  if (!ev.text || !ev.conversationId) {
    return res.status(400).json({ error: 'Thiếu text hoặc conversationId' });
  }

  const { isNew, prompt } = extractPrompt(ev.text, project.keyword);

  let conv = convs.findActive(project.id, ev.conversationId);
  if (isNew) {
    if (conv) convs.close(conv.id);
    conv = convs.create(project.id, ev.conversationId);
    messages.add({ conversation_id: conv.id, direction: 'in', user_id: ev.userId, user_name: ev.userName, content: ev.text });
    res.json({ handled: true, action: 'new-session', conversationId: conv.id });
    sendTeamsMessage(project.teams_webhook_url, `🆕 Đã tạo cuộc hội thoại mới cho **${project.name}**. Gõ \`${project.keyword}\` kèm câu hỏi để bắt đầu.`)
      .then((/* ok */) => messages.add({ conversation_id: conv.id, direction: 'out', content: 'Đã tạo cuộc hội thoại mới' }))
      .catch((err) => console.error('Webhook fail:', err.message));
    return;
  }

  if (!conv) conv = convs.create(project.id, ev.conversationId);
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: ev.userId, user_name: ev.userName, content: ev.text });

  // Ack ngay — kết quả trả async qua webhook (tránh Power Automate timeout)
  res.json({ handled: true, action: 'investigating', conversationId: conv.id });

  investigate(project, conv, prompt)
    .then((answer) => {
      messages.add({ conversation_id: conv.id, direction: 'out', content: answer });
      return sendTeamsMessage(project.teams_webhook_url, answer);
    })
    .catch((err) => {
      console.error(`Investigation fail (project=${project.slug}):`, err);
      messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
      return sendTeamsMessage(project.teams_webhook_url,
        `⚠️ Không hoàn tất được phân tích: ${err.message}`).catch((e) => console.error('Webhook fail:', e.message));
    });
}

module.exports = { handleEvent };
```

- [ ] **Step 6: Chạy toàn bộ test PASS**

Run: `node --test tests/`
Expected: tất cả pass (models, eventGateway, workspace, callapi, opencode-parse).

- [ ] **Step 7: Commit**

```bash
git add services/opencode.service.js services/webhook.service.js controllers/event.controller.js tests/opencode-parse.test.js
git commit -m "feat: full investigation pipeline (opencode session, webhook reply, audit)"
```

---

### Task 9: Admin — Conversations & audit view

**Files:**
- Modify: `routes/admin.routes.js`, tạo `controllers/conversation.controller.js`, `views/conversations/list.ejs`, `views/conversations/detail.ejs`

**Interfaces:**
- Consumes: `conversation.model.listByProject`, `message.model.listByConversation`, `apicall.model.listByProject`, `project.model`.
- Produces: `GET /admin/projects/:id/conversations`, `GET /admin/conversations/:id`.

- [ ] **Step 1: Controller**

```js
// controllers/conversation.controller.js
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const apicalls = require('../models/apicall.model');
const { getDb } = require('../lib/db');

function listForProject(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  res.render('conversations/list', {
    project: p,
    conversations: convs.listByProject(p.id),
    apiCalls: apicalls.listByProject(p.id).slice(0, 50),
  });
}
function detail(req, res) {
  const conv = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).send('Conversation not found');
  res.render('conversations/detail', {
    conv,
    project: projects.findById(conv.project_id),
    messages: messages.listByConversation(conv.id),
  });
}

module.exports = { listForProject, detail };
```

- [ ] **Step 2: Routes + link từ trang project**

Thêm vào `routes/admin.routes.js`:

```js
const cc = require('../controllers/conversation.controller');
router.get('/projects/:id/conversations', cc.listForProject);
router.get('/conversations/:id', cc.detail);
```

Thêm vào `views/projects/form.ejs` (trong block `<% if (project && project.id) { %>`):

```html
<p><a href="/admin/projects/<%= project.id %>/conversations">Conversations & audit →</a></p>
```

- [ ] **Step 3: Views**

```html
<!-- views/conversations/list.ejs -->
<%- include('../layout-head') %>
<h1>Conversations — <%= project.name %></h1>
<table>
  <tr><th>ID</th><th>Teams conversation</th><th>OpenCode session</th><th>Status</th><th>Updated</th></tr>
  <% for (const c of conversations) { %>
  <tr>
    <td><a href="/admin/conversations/<%= c.id %>"><%= c.id %></a></td>
    <td><%= c.teams_conversation_id %></td>
    <td><code><%= c.opencode_session_id || '-' %></code></td>
    <td><%= c.status %></td>
    <td><%= c.updated_at %></td>
  </tr>
  <% } %>
</table>
<h2>API calls (50 gần nhất)</h2>
<table>
  <tr><th>Time</th><th>Group</th><th>Method</th><th>URL</th><th>Status</th></tr>
  <% for (const a of apiCalls) { %>
  <tr><td><%= a.created_at %></td><td><%= a.group_name %></td><td><%= a.method %></td>
      <td><%= a.url %></td><td><%= a.status %></td></tr>
  <% } %>
</table>
<%- include('../layout-foot') %>
```

```html
<!-- views/conversations/detail.ejs -->
<%- include('../layout-head') %>
<h1>Conversation #<%= conv.id %> — <%= project.name %></h1>
<p>Session: <code><%= conv.opencode_session_id || '-' %></code> | Status: <%= conv.status %></p>
<% for (const m of messages) { %>
  <p><strong><%= m.direction === 'in' ? (m.user_name || 'user') : 'bot' %></strong>
     <small>(<%= m.created_at %>)</small><br>
     <span style="white-space: pre-wrap"><%= m.content %></span></p>
  <hr>
<% } %>
<%- include('../layout-foot') %>
```

- [ ] **Step 4: Verify thủ công**

```bash
node server.js &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:6666/admin/projects/1/conversations   # 200 (nếu project id 1 tồn tại từ task trước, không thì tạo mới rồi thử)
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add controllers/conversation.controller.js routes/admin.routes.js views/conversations/ views/projects/form.ejs
git commit -m "feat: conversations + api-call audit views"
```

---

### Task 10: E2E smoke với opencode thật + restart pm2

**Files:**
- Không file mới — verify tích hợp thật.

**Interfaces:**
- Consumes: toàn bộ task trước.

- [ ] **Step 1: Chạy toàn bộ unit test**

Run: `node --test tests/` — Expected: tất cả pass.

- [ ] **Step 2: Tạo project test qua UI/curl với repo public**

```bash
node server.js &
sleep 1
curl -s -X POST http://localhost:6666/admin/projects \
  -d "slug=smoke&name=Smoke&keyword=payment-bot&teams_webhook_url=" -o /dev/null
PID=$(node -e "process.env.OTB_DB_PATH='data/otb.sqlite';console.log(require('./models/project.model').findBySlug('smoke').id)")
curl -s -X POST http://localhost:6666/admin/projects/$PID/repos \
  -d "git_url=https://github.com/octocat/Hello-World.git&auth_type=none&branch=master" -o /dev/null
```

- [ ] **Step 3: Bắn event giả lập (webhook trống → sẽ báo lỗi webhook, nhưng opencode phải chạy)**

```bash
curl -s "http://localhost:6666/api/events/smoke?text=payment-bot%20trong%20repo%20nay%20co%20file%20README%20khong%3F%20tra%20loi%201%20cau&conversationId=smoketest-1&userId=u&userName=tester"
# Expected ngay: {"handled":true,"action":"investigating","conversationId":N}
sleep 90
node -e "
process.env.OTB_DB_PATH='data/otb.sqlite';
const msgs = require('./models/message.model').listByConversation(1);
console.log(JSON.stringify(msgs, null, 2));
"
```

Expected: có message `direction=out` chứa câu trả lời thật của agent về README (hoặc `[error] Project chưa cấu hình teams_webhook_url` NHƯNG content trước đó là answer — đọc kỹ: answer được lưu TRƯỚC khi gửi webhook, nên phải thấy answer trong messages).

- [ ] **Step 4: Test session continuity**

```bash
curl -s "http://localhost:6666/api/events/smoke?text=payment-bot%20cau%20hoi%20truoc%20cua%20toi%20la%20gi%3F&conversationId=smoketest-1&userId=u&userName=tester"
sleep 90
# Kiểm tra message out mới nhất có nhắc lại đúng câu hỏi trước (chứng minh cùng session)
```

- [ ] **Step 5: Test /new**

```bash
curl -s "http://localhost:6666/api/events/smoke?text=payment-bot%20/new&conversationId=smoketest-1"
node -e "
process.env.OTB_DB_PATH='data/otb.sqlite';
const { getDb } = require('./lib/db');
console.log(getDb().prepare('SELECT id, status, opencode_session_id FROM conversations').all());
"
```

Expected: conversation cũ `closed`, có row mới `active` với session NULL.

- [ ] **Step 6: Restart pm2 với code mới**

```bash
kill %1
pm2 restart open-trace-bridge
pm2 logs open-trace-bridge --lines 5 --nostream
curl -s https://6666.sowndev.com/health
```

- [ ] **Step 7: Commit (nếu có sửa lỗi phát sinh) + cập nhật FLOW.md**

Thêm vào cuối section Step 2 trong `FLOW.md`: dòng `> Đã implement + smoke test OK ngày <ngày chạy>.`

```bash
git add -A
git commit -m "test: e2e smoke pass (session continuity + /new + agent answer)"
```

---

### Task 11: Docker

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.dockerignore`

**Interfaces:**
- Consumes: toàn bộ app.
- Produces: `docker compose up -d` chạy được: Express 6666 (public qua tunnel), `opencode serve` 4096 (bind localhost host-side), volumes persist data/workspaces/opencode auth.

- [ ] **Step 1: .dockerignore**

```
node_modules
data
workspaces
.git
docs
```

- [ ] **Step 2: Dockerfile**

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# opencode CLI (npm package chính thức)
RUN npm install -g opencode-ai

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=6666
EXPOSE 6666 4096

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
CMD ["/docker-entrypoint.sh"]
```

- [ ] **Step 3: Entrypoint (chạy song song serve + express)**

```bash
#!/bin/sh
# docker-entrypoint.sh
set -e

# OpenCode remote control — LUÔN chạy để setup key/debug từ ngoài container.
# Bind 0.0.0.0 trong container; docker-compose chỉ publish ra 127.0.0.1 host.
opencode serve --hostname 0.0.0.0 --port 4096 &

exec node server.js
```

- [ ] **Step 4: docker-compose.yml**

```yaml
services:
  otb:
    build: .
    restart: unless-stopped
    ports:
      - "6666:6666"                 # Express — tunnel public trỏ vào đây
      - "127.0.0.1:4096:4096"       # OpenCode serve — CHỈ localhost host, không ra internet (không auth)
    volumes:
      - ./data:/app/data
      - ./workspaces:/app/workspaces
      - opencode-state:/root/.local/share/opencode
      - opencode-config:/root/.config/opencode
    environment:
      - PORT=6666

volumes:
  opencode-state:
  opencode-config:
```

- [ ] **Step 5: Build + run + setup key**

```bash
pm2 stop open-trace-bridge          # tránh trùng port 6666
docker compose up -d --build
curl -s http://localhost:6666/health          # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4096/   # opencode serve trả lời (bất kỳ mã nào ≠ connection refused)
```

Setup provider key cho opencode TRONG container (lần đầu):

```bash
docker compose exec otb opencode auth login
# hoặc mở http://localhost:4096 từ máy host để remote control/debug
```

Sau đó smoke lại 1 event như Task 10 Step 3 (qua cổng 6666 của container).

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml docker-entrypoint.sh .dockerignore
git commit -m "feat: docker deployment (express 6666 + opencode serve 4096, persistent volumes)"
```

---

## Self-Review Notes

- **Spec coverage:** §3 multi-project/slug (T3), UI CRUD repos+API (T3–T4), workspace+AGENTS.md+opencode.json (T5), MCP call_api + enforcement + không lộ key (T5–T7), session continuity + `/new` + keyword strip (T2, T8), webhook async (T8), audit messages+api_calls (T1, T8, T9), Docker+4096 (T11), error handling timeout/git/webhook (T5 throw, T8 catch), route cũ giữ lại (T3).
- **Known risk:** shape import của `@modelcontextprotocol/sdk` thay đổi theo version — T7 Step 3 có smoke check riêng; nếu fail, sửa import theo README của version cài được.
- **Known deferred:** `docker-entrypoint.sh` không đợi serve sẵn sàng trước khi start Express (không cần — Express không phụ thuộc serve; `opencode run` CLI độc lập). Nếu về sau chuyển sang gọi qua serve API thì thêm wait.
