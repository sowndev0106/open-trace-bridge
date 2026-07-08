# Discord Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host multiple Discord bots inside the existing server so projects answer investigation questions in designated Discord channels, and allowlisted users can DM a bot privately — all through the same OpenCode pipeline as Teams.

**Architecture:** One `discord.js` v14 gateway client per enabled bot runs in-process (outbound WebSocket, no new public port). A pure router (`services/discordRouter.js`) resolves permissions/context and reuses the extracted `investigate()` pipeline (workspace sync, per-project OS user, OpenCode session per conversation, runs/messages recording). Replies are plain markdown chunks (code-fence-aware, ≤2000 chars) with colored embeds for status, emoji reactions for lifecycle, and typing refresh while running.

**Tech Stack:** Node.js (CommonJS), Express, better-sqlite3, EJS admin UI, `discord.js` ^14, `node --test` + supertest for tests.

**Spec:** `docs/superpowers/specs/2026-07-08-discord-integration-design.md` — read it before starting any task.

## Global Constraints

- Everything in English: code, comments, strings, tests, docs (CLAUDE.md rule).
- Never commit secrets; bot tokens live only in SQLite (root-only `data/` dir), never in workspaces or client responses.
- Preserve the two-port boundary: no new listening ports; Discord gateway is outbound only.
- Conversation external ids: Teams keeps raw ids; Discord channel = `discord:<channelId>`; Discord DM = `discord:dm:<botId>:<userId>`.
- Discord hard limits: message content 2,000 chars; embed description 4,096 / total 6,000; bot file upload 8 MB.
- Env defaults: `DISCORD_MAX_ATTACHMENT_MB=20`, `DISCORD_MAX_ATTACHMENTS=5`, `DISCORD_LONG_ANSWER_THRESHOLD=6000`, `DISCORD_TYPING_REFRESH_MS=8000`.
- Tests: `npm test` runs `node --test 'tests/*.test.js'`. Every test file sets `process.env.OTB_DB_PATH = ':memory:'` before requiring `lib/db` and calls `resetDbForTest()` in `beforeEach`.
- The working tree already contains an uncommitted conversation-inactivity feature (`touch`, `autoCloseInactive`, `startInactivityJob`). Build on top of it; do not revert it. Commit only files your task touches.
- DM admin role grants full OpenCode tools but still runs as OS user `otb-<slug>` — never root.

---

### Task 1: DB schema — Discord tables, settings, conversation `external_id` rename + override columns

**Files:**
- Modify: `lib/db.js` (SCHEMA + migrations)
- Modify: `models/conversation.model.js`
- Modify: `views/conversations/list.ejs:44-45`
- Test: `tests/models.test.js` (append tests)

**Interfaces:**
- Consumes: existing `getDb()` / `resetDbForTest()` from `lib/db.js`.
- Produces: tables `discord_bots`, `discord_channels`, `discord_dm_users`, `discord_dm_user_projects`, `discord_dm_selections`, `settings`; `projects.discord_bot_id` column; `conversations.external_id` (renamed from `teams_conversation_id`), `conversations.model`, `conversations.agent`. Conversation model exports: `findActive(project_id, external_id)`, `create(project_id, external_id)`, `findById(id)`, `setOverrides(id, { model, agent })` (plus all existing exports unchanged).

- [ ] **Step 1: Write the failing tests** — append to `tests/models.test.js`:

```js
test('conversations use external_id and store model/agent overrides', () => {
  const p = projects.create({ slug: 'd1', name: 'D1', keyword: '', system_prompt: '', teams_webhook_url: '' });
  const c = convs.create(p.id, 'discord:123');
  assert.strictEqual(c.external_id, 'discord:123');
  assert.strictEqual(convs.findActive(p.id, 'discord:123').id, c.id);
  convs.setOverrides(c.id, { model: 'anthropic/claude-sonnet-5', agent: 'plan' });
  const row = convs.findById(c.id);
  assert.strictEqual(row.model, 'anthropic/claude-sonnet-5');
  assert.strictEqual(row.agent, 'plan');
  convs.setOverrides(c.id, { model: null, agent: null });
  assert.strictEqual(convs.findById(c.id).model, null);
});

test('discord tables exist with expected columns', () => {
  const { getDb } = require('../lib/db');
  const cols = (t) => getDb().prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('discord_bots').includes('token'));
  assert.ok(cols('discord_channels').includes('mode'));
  assert.ok(cols('discord_dm_users').includes('role'));
  assert.ok(cols('discord_dm_user_projects').includes('project_id'));
  assert.ok(cols('discord_dm_selections').includes('bot_id'));
  assert.ok(cols('settings').includes('value'));
  assert.ok(cols('projects').includes('discord_bot_id'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/models.test.js`
Expected: FAIL — `external_id` undefined / `no such table: discord_bots`.

- [ ] **Step 3: Implement schema changes in `lib/db.js`**

In `SCHEMA`, change the `conversations` line `teams_conversation_id TEXT NOT NULL,` to `external_id TEXT NOT NULL,` and add `model TEXT,` and `agent TEXT,` after `opencode_session_id TEXT,`. Append to `SCHEMA` (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS discord_bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discord_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'mention' CHECK (mode IN ('mention','all')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discord_dm_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  all_projects INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discord_dm_user_projects (
  dm_user_id INTEGER NOT NULL REFERENCES discord_dm_users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (dm_user_id, project_id)
);
CREATE TABLE IF NOT EXISTS discord_dm_selections (
  dm_user_id INTEGER NOT NULL REFERENCES discord_dm_users(id) ON DELETE CASCADE,
  bot_id INTEGER NOT NULL REFERENCES discord_bots(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (dm_user_id, bot_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
```

Append to the `migrations` array (order matters — rename first):

```js
"ALTER TABLE conversations RENAME COLUMN teams_conversation_id TO external_id",
"ALTER TABLE conversations ADD COLUMN model TEXT",
"ALTER TABLE conversations ADD COLUMN agent TEXT",
"ALTER TABLE projects ADD COLUMN discord_bot_id INTEGER REFERENCES discord_bots(id)",
```

- [ ] **Step 4: Update `models/conversation.model.js`**

Rename the parameter and column in `findActive`/`create` (`teams_conversation_id` → `external_id`), and add:

```js
function findById(id) { return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id); }
function setOverrides(id, { model = null, agent = null } = {}) {
  getDb().prepare(`UPDATE conversations SET model = ?, agent = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(model, agent, id);
}
```

Export `findById` and `setOverrides` alongside existing exports.

- [ ] **Step 5: Update `views/conversations/list.ejs`** — replace both `c.teams_conversation_id` references with `c.external_id`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all PASS (existing tests exercise the renamed column through the model API only).

- [ ] **Step 7: Commit**

```bash
git add lib/db.js models/conversation.model.js views/conversations/list.ejs tests/models.test.js
git commit -m "feat: add discord schema and generalize conversation external_id"
```

---

### Task 2: Discord models, settings model, run stats

**Files:**
- Create: `models/discordBot.model.js`, `models/discordChannel.model.js`, `models/discordUser.model.js`, `models/setting.model.js`
- Modify: `models/run.model.js` (append two functions)
- Test: `tests/discordModels.test.js`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces:
  - `discordBot.model`: `create({ name, token, enabled = 1 })`, `findById(id)`, `list()`, `listEnabled()`, `update(id, fields)` (allowed: `name`, `token`, `enabled`, `last_error`), `remove(id)`.
  - `discordChannel.model`: `listByProject(project_id)`, `findByChannelId(channel_id)`, `replaceForProject(project_id, rows)` where rows = `[{ channel_id, mode }]`.
  - `discordUser.model`: `create({ discord_user_id, label = '', role = 'member', all_projects = 0 })`, `findById(id)`, `findByDiscordId(discord_user_id)`, `list()`, `update(id, fields)` (allowed: `label`, `role`, `all_projects`), `remove(id)`, `setProjects(dm_user_id, projectIds)`, `listProjectIds(dm_user_id)` → number[], `getSelection(dm_user_id, bot_id)` → project_id|null, `setSelection(dm_user_id, bot_id, project_id)`.
  - `setting.model`: `get(key)` → string|null, `set(key, value)`.
  - `run.model`: `statsForConversation(conversation_id)` and `statsForProject(project_id)` → `{ runs, tokens_input, tokens_output, cost_usd }` (SUMs may be null when empty — coalesce to 0).

- [ ] **Step 1: Write the failing tests** — create `tests/discordModels.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const bots = require('../models/discordBot.model');
const channels = require('../models/discordChannel.model');
const dmUsers = require('../models/discordUser.model');
const settings = require('../models/setting.model');
const runs = require('../models/run.model');

beforeEach(() => { resetDbForTest(); });

function seedProject(slug = 'p1') {
  return projects.create({ slug, name: slug, keyword: '', system_prompt: '', teams_webhook_url: '' });
}

test('discord bot CRUD keeps token and tracks last_error', () => {
  const b = bots.create({ name: 'Main bot', token: 'tok-secret' });
  assert.ok(b.id);
  assert.strictEqual(b.enabled, 1);
  bots.update(b.id, { last_error: 'login failed', enabled: 0 });
  const row = bots.findById(b.id);
  assert.strictEqual(row.last_error, 'login failed');
  assert.strictEqual(bots.listEnabled().length, 0);
  assert.strictEqual(bots.list().length, 1);
  bots.remove(b.id);
  assert.strictEqual(bots.list().length, 0);
});

test('discord channels replaceForProject reconciles rows and enforces unique channel', () => {
  const p = seedProject();
  channels.replaceForProject(p.id, [{ channel_id: '111', mode: 'all' }, { channel_id: '222', mode: 'mention' }]);
  assert.strictEqual(channels.listByProject(p.id).length, 2);
  assert.strictEqual(channels.findByChannelId('111').mode, 'all');
  channels.replaceForProject(p.id, [{ channel_id: '222', mode: 'all' }]);
  assert.strictEqual(channels.listByProject(p.id).length, 1);
  assert.strictEqual(channels.findByChannelId('111'), undefined);
  assert.strictEqual(channels.findByChannelId('222').mode, 'all');
});

test('dm users: allowlist, per-user projects, selections', () => {
  const p1 = seedProject('p1');
  const p2 = seedProject('p2');
  const b = require('../models/discordBot.model').create({ name: 'b', token: 't' });
  const u = dmUsers.create({ discord_user_id: '42', label: 'Alice', role: 'member' });
  assert.strictEqual(dmUsers.findByDiscordId('42').label, 'Alice');
  dmUsers.setProjects(u.id, [p1.id, p2.id]);
  assert.deepStrictEqual(dmUsers.listProjectIds(u.id).sort(), [p1.id, p2.id].sort());
  dmUsers.setProjects(u.id, [p2.id]);
  assert.deepStrictEqual(dmUsers.listProjectIds(u.id), [p2.id]);
  assert.strictEqual(dmUsers.getSelection(u.id, b.id), null);
  dmUsers.setSelection(u.id, b.id, p2.id);
  assert.strictEqual(dmUsers.getSelection(u.id, b.id), p2.id);
  dmUsers.setSelection(u.id, b.id, p1.id);
  assert.strictEqual(dmUsers.getSelection(u.id, b.id), p1.id);
  dmUsers.update(u.id, { role: 'admin', all_projects: 1 });
  assert.strictEqual(dmUsers.findById(u.id).role, 'admin');
});

test('settings KV get/set', () => {
  assert.strictEqual(settings.get('discord_allowed_models'), null);
  settings.set('discord_allowed_models', 'anthropic/claude-sonnet-5');
  assert.strictEqual(settings.get('discord_allowed_models'), 'anthropic/claude-sonnet-5');
  settings.set('discord_allowed_models', 'x');
  assert.strictEqual(settings.get('discord_allowed_models'), 'x');
});

test('run stats aggregate per conversation and project', () => {
  const p = seedProject();
  const convs = require('../models/conversation.model');
  const c = convs.create(p.id, 'discord:1');
  runs.add({ project_id: p.id, conversation_id: c.id, status: 'success', duration_ms: 10, tokens_input: 100, tokens_output: 50, tokens_reasoning: 0, cost_usd: 0.5 });
  runs.add({ project_id: p.id, conversation_id: c.id, status: 'error', duration_ms: 10, error: 'x' });
  const cs = runs.statsForConversation(c.id);
  assert.strictEqual(cs.runs, 2);
  assert.strictEqual(cs.tokens_input, 100);
  assert.strictEqual(cs.cost_usd, 0.5);
  const ps = runs.statsForProject(p.id);
  assert.strictEqual(ps.runs, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/discordModels.test.js`
Expected: FAIL — `Cannot find module '../models/discordBot.model'`.

- [ ] **Step 3: Implement the four models**

`models/discordBot.model.js`:

```js
const { getDb } = require('../lib/db');

function create({ name, token, enabled = 1 }) {
  const info = getDb().prepare('INSERT INTO discord_bots (name, token, enabled) VALUES (?, ?, ?)')
    .run(name, token, enabled ? 1 : 0);
  return findById(info.lastInsertRowid);
}
function findById(id) { return getDb().prepare('SELECT * FROM discord_bots WHERE id = ?').get(id); }
function list() { return getDb().prepare('SELECT * FROM discord_bots ORDER BY id').all(); }
function listEnabled() { return getDb().prepare('SELECT * FROM discord_bots WHERE enabled = 1 ORDER BY id').all(); }
function update(id, fields) {
  const allowed = ['name', 'token', 'enabled', 'last_error'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return findById(id);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE discord_bots SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return findById(id);
}
function remove(id) { getDb().prepare('DELETE FROM discord_bots WHERE id = ?').run(id); }

module.exports = { create, findById, list, listEnabled, update, remove };
```

`models/discordChannel.model.js`:

```js
const { getDb } = require('../lib/db');

function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM discord_channels WHERE project_id = ? ORDER BY id').all(project_id);
}
function findByChannelId(channel_id) {
  return getDb().prepare('SELECT * FROM discord_channels WHERE channel_id = ?').get(String(channel_id));
}
// Full replace: the project form submits the complete channel list every save.
function replaceForProject(project_id, rows) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM discord_channels WHERE project_id = ?').run(project_id);
    const ins = db.prepare('INSERT INTO discord_channels (project_id, channel_id, mode) VALUES (?, ?, ?)');
    for (const r of rows) ins.run(project_id, String(r.channel_id), r.mode === 'all' ? 'all' : 'mention');
  })();
}

module.exports = { listByProject, findByChannelId, replaceForProject };
```

`models/discordUser.model.js`:

```js
const { getDb } = require('../lib/db');

function create({ discord_user_id, label = '', role = 'member', all_projects = 0 }) {
  const info = getDb().prepare(
    'INSERT INTO discord_dm_users (discord_user_id, label, role, all_projects) VALUES (?, ?, ?, ?)'
  ).run(String(discord_user_id), label, role, all_projects ? 1 : 0);
  return findById(info.lastInsertRowid);
}
function findById(id) { return getDb().prepare('SELECT * FROM discord_dm_users WHERE id = ?').get(id); }
function findByDiscordId(discord_user_id) {
  return getDb().prepare('SELECT * FROM discord_dm_users WHERE discord_user_id = ?').get(String(discord_user_id));
}
function list() { return getDb().prepare('SELECT * FROM discord_dm_users ORDER BY id').all(); }
function update(id, fields) {
  const allowed = ['label', 'role', 'all_projects'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return findById(id);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE discord_dm_users SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return findById(id);
}
function remove(id) { getDb().prepare('DELETE FROM discord_dm_users WHERE id = ?').run(id); }

function setProjects(dm_user_id, projectIds) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM discord_dm_user_projects WHERE dm_user_id = ?').run(dm_user_id);
    const ins = db.prepare('INSERT INTO discord_dm_user_projects (dm_user_id, project_id) VALUES (?, ?)');
    for (const pid of projectIds) ins.run(dm_user_id, pid);
  })();
}
function listProjectIds(dm_user_id) {
  return getDb().prepare('SELECT project_id FROM discord_dm_user_projects WHERE dm_user_id = ?')
    .all(dm_user_id).map((r) => r.project_id);
}
function getSelection(dm_user_id, bot_id) {
  const row = getDb().prepare(
    'SELECT project_id FROM discord_dm_selections WHERE dm_user_id = ? AND bot_id = ?'
  ).get(dm_user_id, bot_id);
  return row ? row.project_id : null;
}
function setSelection(dm_user_id, bot_id, project_id) {
  getDb().prepare(
    `INSERT INTO discord_dm_selections (dm_user_id, bot_id, project_id) VALUES (?, ?, ?)
     ON CONFLICT(dm_user_id, bot_id) DO UPDATE SET project_id = excluded.project_id`
  ).run(dm_user_id, bot_id, project_id);
}

module.exports = {
  create, findById, findByDiscordId, list, update, remove,
  setProjects, listProjectIds, getSelection, setSelection,
};
```

`models/setting.model.js`:

```js
const { getDb } = require('../lib/db');

function get(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function set(key, value) {
  getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

module.exports = { get, set };
```

Append to `models/run.model.js` (and add to its exports):

```js
function statsForConversation(conversation_id) {
  return getDb().prepare(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_input),0) AS tokens_input,
            COALESCE(SUM(tokens_output),0) AS tokens_output, COALESCE(SUM(cost_usd),0) AS cost_usd
     FROM runs WHERE conversation_id = ?`
  ).get(conversation_id);
}
function statsForProject(project_id) {
  return getDb().prepare(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_input),0) AS tokens_input,
            COALESCE(SUM(tokens_output),0) AS tokens_output, COALESCE(SUM(cost_usd),0) AS cost_usd
     FROM runs WHERE project_id = ?`
  ).get(project_id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/discordModels.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add models/discordBot.model.js models/discordChannel.model.js models/discordUser.model.js models/setting.model.js models/run.model.js tests/discordModels.test.js
git commit -m "feat: add discord bot/channel/dm-user/settings models and run stats"
```

---

### Task 3: Discord formatting library (chunking, embeds, reactions)

**Files:**
- Create: `lib/discordFormat.js`
- Test: `tests/discordFormat.test.js`

**Interfaces:**
- Consumes: `redact`, `splitMarkdown` from `services/teamsFormat.js` (already code-fence-aware).
- Produces:
  - `COLORS = { info: 0x3b82f6, success: 0x22c55e, warning: 0xeab308, error: 0xef4444 }`
  - `EMOJI = { accepted: '👀', success: '✅', error: '❌', timeout: '⏱️', stopped: '🛑' }`
  - `renderAnswer(text, { maxLength, fileThreshold })` → `{ chunks: string[], file: { name: 'answer.md', content: string } | null }`
  - `statusEmbed({ status, title, description, footer })` → `{ color, title, description, footer? }` (footer is `{ text }`), sliced to Discord limits.
  - `attachmentMarkers(attachments)` → string like `[attachment: a.png]\n[attachment: b.log]`.

- [ ] **Step 1: Write the failing tests** — create `tests/discordFormat.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fmt = require('../lib/discordFormat');

test('renderAnswer chunks at 2000 chars without breaking code fences', () => {
  const code = '```js\n' + 'x = 1;\n'.repeat(500) + '```';
  const { chunks, file } = fmt.renderAnswer(code, { maxLength: 20000, fileThreshold: 100000 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 2000, `chunk too long: ${c.length}`);
    const fences = (c.match(/```/g) || []).length;
    assert.strictEqual(fences % 2, 0, 'unbalanced code fence in chunk');
  }
  assert.strictEqual(file, null);
});

test('renderAnswer attaches answer.md above the file threshold', () => {
  const long = 'word '.repeat(2000); // 10,000 chars
  const { chunks, file } = fmt.renderAnswer(long, { maxLength: 20000, fileThreshold: 6000 });
  assert.strictEqual(chunks.length, 1);
  assert.match(chunks[0], /full answer attached/);
  assert.strictEqual(file.name, 'answer.md');
  assert.ok(file.content.length >= 9000);
});

test('renderAnswer respects project maxLength before chunking', () => {
  const long = 'a'.repeat(5000);
  const { chunks } = fmt.renderAnswer(long, { maxLength: 100, fileThreshold: 6000 });
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].length <= 110);
});

test('statusEmbed maps status to color and slices limits', () => {
  const e = fmt.statusEmbed({ status: 'error', title: 't'.repeat(300), description: 'd'.repeat(5000), footer: 'f' });
  assert.strictEqual(e.color, fmt.COLORS.error);
  assert.strictEqual(e.title.length, 256);
  assert.strictEqual(e.description.length, 4096);
  assert.deepStrictEqual(e.footer, { text: 'f' });
  const i = fmt.statusEmbed({ status: 'nope', title: 'x', description: 'y' });
  assert.strictEqual(i.color, fmt.COLORS.info);
  assert.strictEqual(i.footer, undefined);
});

test('attachmentMarkers renders one marker per file', () => {
  assert.strictEqual(
    fmt.attachmentMarkers([{ name: 'a.png' }, { name: 'b.log' }]),
    '[attachment: a.png]\n[attachment: b.log]'
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/discordFormat.test.js`
Expected: FAIL — `Cannot find module '../lib/discordFormat'`.

- [ ] **Step 3: Implement `lib/discordFormat.js`**

```js
// Discord rendering rules: plain markdown chunks for answers (2000-char bot
// limit, code fences kept balanced), colored embeds for status notices,
// emoji reactions for the question lifecycle. Pure functions; no discord.js.
const { redact, splitMarkdown } = require('../services/teamsFormat');

const DISCORD_CHUNK_LEN = 2000;
const HEAD_LEN = 1800; // room left for the "full answer attached" note

const COLORS = { info: 0x3b82f6, success: 0x22c55e, warning: 0xeab308, error: 0xef4444 };
const EMOJI = { accepted: '👀', success: '✅', error: '❌', timeout: '⏱️', stopped: '🛑' };

function renderAnswer(text, { maxLength = 20000, fileThreshold = Number(process.env.DISCORD_LONG_ANSWER_THRESHOLD || 6000) } = {}) {
  let clean = redact(String(text || ''));
  if (clean.length > maxLength) clean = clean.slice(0, maxLength) + '\n…(truncated)';
  if (clean.length > fileThreshold) {
    const head = splitMarkdown(clean, HEAD_LEN)[0] || '';
    return {
      chunks: [head + '\n\n*(full answer attached as answer.md)*'],
      file: { name: 'answer.md', content: clean },
    };
  }
  return { chunks: splitMarkdown(clean, DISCORD_CHUNK_LEN), file: null };
}

function statusEmbed({ status, title, description, footer }) {
  const embed = {
    color: COLORS[status] || COLORS.info,
    title: String(title || '').slice(0, 256),
    description: redact(String(description || '')).slice(0, 4096),
  };
  if (footer) embed.footer = { text: String(footer).slice(0, 2048) };
  return embed;
}

function attachmentMarkers(attachments) {
  return (attachments || []).map((a) => `[attachment: ${a.name}]`).join('\n');
}

module.exports = { COLORS, EMOJI, DISCORD_CHUNK_LEN, renderAnswer, statusEmbed, attachmentMarkers };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/discordFormat.test.js`
Expected: PASS. If the fence-balance test fails, inspect `splitMarkdown` in `services/teamsFormat.js` — it already closes/reopens fences; do not reimplement chunking.

- [ ] **Step 5: Commit**

```bash
git add lib/discordFormat.js tests/discordFormat.test.js
git commit -m "feat: add discord formatting helpers (chunks, embeds, reactions)"
```

---

### Task 4: OpenCode runner — model/agent/variant/files/command args, admin config path, cancellation

**Files:**
- Modify: `services/opencode.service.js`
- Test: `tests/opencode-args.test.js` (new)

**Interfaces:**
- Consumes: existing `runPromptStream({ dir, sessionId, text, conversationId, onEvent, runAs })` and the `proc.spawn` stub indirection.
- Produces: `runPromptStream` accepts additional opts `{ model, variant, agent, command, files, configPath, cancelKey }`; new exports `cancel(cancelKey)` → boolean and `isRunning(cancelKey)` → boolean. A run killed via `cancel` rejects with an Error whose `.stopped === true` and message `'stopped by user'`.

- [ ] **Step 1: Write the failing tests** — create `tests/opencode-args.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

process.env.OTB_DB_PATH = ':memory:';
const opencode = require('../services/opencode.service');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

let spawnCalls;
beforeEach(() => { spawnCalls = []; });

function stubSpawn(child) {
  opencode.proc.spawn = (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return child; };
}

function finish(child, sessionId = 'ses_1') {
  child.stdout.emit('data', JSON.stringify({ sessionID: sessionId, type: 'text', part: { text: 'ok' } }) + '\n');
  child.emit('close', 0);
}

test('passes model, variant, agent, files and command flags to opencode run', async () => {
  const child = fakeChild();
  stubSpawn(child);
  const p = opencode.runPrompt({
    dir: '/tmp/ws', text: 'hello', model: 'anthropic/claude-sonnet-5', variant: 'high',
    agent: 'plan', files: ['/tmp/ws/.otb-uploads/1/a.png'], configPath: '/tmp/ws/opencode.admin.json',
  });
  finish(child);
  await p;
  const { args, opts } = spawnCalls[0];
  assert.deepStrictEqual(args.slice(0, 2), ['run', '--format']);
  assert.ok(args.includes('-m') && args[args.indexOf('-m') + 1] === 'anthropic/claude-sonnet-5');
  assert.ok(args.includes('--variant') && args[args.indexOf('--variant') + 1] === 'high');
  assert.ok(args.includes('--agent') && args[args.indexOf('--agent') + 1] === 'plan');
  assert.ok(args.includes('-f') && args[args.indexOf('-f') + 1] === '/tmp/ws/.otb-uploads/1/a.png');
  assert.strictEqual(args[args.length - 1], 'hello');
  assert.strictEqual(opts.env.OPENCODE_CONFIG, '/tmp/ws/opencode.admin.json');
});

test('command flag runs a custom command and omits empty text', async () => {
  const child = fakeChild();
  stubSpawn(child);
  const p = opencode.runPrompt({ dir: '/tmp/ws', text: '', command: 'deploy-check' });
  finish(child);
  await p;
  const { args } = spawnCalls[0];
  assert.ok(args.includes('--command') && args[args.indexOf('--command') + 1] === 'deploy-check');
  assert.notStrictEqual(args[args.length - 1], '');
});

test('cancel kills the child and rejects with stopped error', async () => {
  const child = fakeChild();
  stubSpawn(child);
  const p = opencode.runPrompt({ dir: '/tmp/ws', text: 'long question', cancelKey: 77 });
  assert.strictEqual(opencode.isRunning(77), true);
  assert.strictEqual(opencode.cancel(77), true);
  assert.strictEqual(child.killed, true);
  child.emit('close', 137);
  await assert.rejects(p, (err) => err.stopped === true && /stopped by user/.test(err.message));
  assert.strictEqual(opencode.isRunning(77), false);
  assert.strictEqual(opencode.cancel(77), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/opencode-args.test.js`
Expected: FAIL — flags missing from args / `opencode.cancel is not a function`.

- [ ] **Step 3: Implement in `services/opencode.service.js`**

Add near the top:

```js
// Running children keyed by cancelKey (conversation id) so /stop can kill them.
const running = new Map();

function cancel(cancelKey) {
  const entry = running.get(cancelKey);
  if (!entry) return false;
  entry.stopped = true;
  entry.child.kill('SIGKILL');
  return true;
}
function isRunning(cancelKey) { return running.has(cancelKey); }
```

Change `runPromptStream` signature to
`function runPromptStream({ dir, sessionId, text, conversationId, onEvent, runAs, model, variant, agent, command, files, configPath, cancelKey })`
and replace the args construction with:

```js
    const args = ['run', '--format', 'json'];
    if (sessionId) args.push('-s', sessionId);
    if (model) args.push('-m', model);
    if (variant) args.push('--variant', variant);
    if (agent) args.push('--agent', agent);
    if (command) args.push('--command', command);
    for (const f of files || []) args.push('-f', f);
    if (text) args.push(text);
```

After `const env = { ...process.env, PWD: dir };` add:

```js
    if (configPath) env.OPENCODE_CONFIG = configPath;
```

After `const child = proc.spawn('opencode', args, spawnOpts);` add:

```js
    const entry = { child, stopped: false };
    if (cancelKey != null) running.set(cancelKey, entry);
    const done = () => { if (cancelKey != null) running.delete(cancelKey); };
```

Call `done()` in every terminal path (timeout handler, `'error'` handler, `'close'` handler — first line). In the `'close'` handler, before the exit-code check, add:

```js
      if (entry.stopped) {
        const err = new Error('stopped by user');
        err.stopped = true;
        return reject(err);
      }
```

Export `cancel` and `isRunning` in `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/opencode-args.test.js && npm test`
Expected: PASS (existing `opencode-run.test.js` / `opencode-stream.test.js` must stay green — the new opts are all optional).

- [ ] **Step 5: Commit**

```bash
git add services/opencode.service.js tests/opencode-args.test.js
git commit -m "feat: opencode runner supports model/agent/files/command args and cancellation"
```

---

### Task 5: Extract shared investigation service

**Files:**
- Create: `services/investigation.service.js`
- Modify: `controllers/event.controller.js` (delete its local `investigate`, import the service)
- Test: `tests/investigation.test.js` (new)

**Interfaces:**
- Consumes: `sync.ensureReady(project)` → ws path; `projectUser.ensureProjectUser(slug)` / `ownWorkspace(ws, user)`; `opencode.runPrompt(opts)` (Task 4 opts); `convs.setSession`; `runs.add`; `workspace.adminConfigPathFor(ws)` (Task 6 — until Task 6 lands, compute the path inline as `path.join(ws, 'opencode.admin.json')`).
- Produces: `investigate(project, conv, prompt, opts = {})` → Promise<string> where opts = `{ files, admin, onEvent, command }`. Behavior: uses `conv.model` / `conv.agent` overrides (conversation row fields), passes `cancelKey: conv.id`, records a `runs` row with status `success` | `timeout` | `error` | `stopped`, stores the session id on first run, throws the original error on failure (preserving `err.stopped`).

- [ ] **Step 1: Write the failing test** — create `tests/investigation.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const runsModel = require('../models/run.model');
const investigation = require('../services/investigation.service');

beforeEach(() => { resetDbForTest(); });

function seed() {
  const p = projects.create({ slug: 'inv', name: 'Inv', keyword: '', system_prompt: '', teams_webhook_url: '' });
  const c = convs.create(p.id, 'discord:9');
  return { p, c };
}

test('investigate runs opencode with conversation overrides and records a success run', async () => {
  const { p, c } = seed();
  convs.setOverrides(c.id, { model: 'anthropic/claude-sonnet-5', agent: null });
  const seen = {};
  investigation.deps.ensureReady = async () => '/tmp/ws-inv';
  investigation.deps.ensureProjectUser = () => null;
  investigation.deps.ownWorkspace = () => {};
  investigation.deps.runPrompt = async (opts) => { Object.assign(seen, opts); return { sessionId: 'ses_9', text: 'answer', usage: {} }; };
  const answer = await investigation.investigate(p, convs.findById(c.id), 'why is it down?', { files: ['/tmp/a.png'] });
  assert.strictEqual(answer, 'answer');
  assert.strictEqual(seen.model, 'anthropic/claude-sonnet-5');
  assert.strictEqual(seen.cancelKey, c.id);
  assert.deepStrictEqual(seen.files, ['/tmp/a.png']);
  assert.strictEqual(seen.configPath, undefined);
  assert.strictEqual(convs.findById(c.id).opencode_session_id, 'ses_9');
  assert.strictEqual(runsModel.statsForConversation(c.id).runs, 1);
});

test('admin flag points opencode at the admin config in the workspace', async () => {
  const { p, c } = seed();
  const seen = {};
  investigation.deps.ensureReady = async () => '/tmp/ws-inv';
  investigation.deps.ensureProjectUser = () => null;
  investigation.deps.ownWorkspace = () => {};
  investigation.deps.runPrompt = async (opts) => { Object.assign(seen, opts); return { sessionId: 's', text: 'ok', usage: {} }; };
  await investigation.investigate(p, c, 'q', { admin: true });
  assert.strictEqual(seen.configPath, '/tmp/ws-inv/opencode.admin.json');
});

test('stopped run is recorded with status stopped and rethrown', async () => {
  const { p, c } = seed();
  investigation.deps.ensureReady = async () => '/tmp/ws-inv';
  investigation.deps.ensureProjectUser = () => null;
  investigation.deps.ownWorkspace = () => {};
  investigation.deps.runPrompt = async () => { const e = new Error('stopped by user'); e.stopped = true; throw e; };
  await assert.rejects(investigation.investigate(p, c, 'q'), (e) => e.stopped === true);
  const { getDb } = require('../lib/db');
  const run = getDb().prepare('SELECT * FROM runs WHERE conversation_id = ?').get(c.id);
  assert.strictEqual(run.status, 'stopped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/investigation.test.js`
Expected: FAIL — `Cannot find module '../services/investigation.service'`.

- [ ] **Step 3: Implement `services/investigation.service.js`** (logic moved from `controllers/event.controller.js:27-53`):

```js
const path = require('path');
const convs = require('../models/conversation.model');
const runs = require('../models/run.model');
const sync = require('./sync.service');
const opencode = require('./opencode.service');
const projectUser = require('./projectUser.service');

// Indirection so tests can stub external effects without touching the DB layer.
const deps = {
  ensureReady: (project) => sync.ensureReady(project),
  ensureProjectUser: (slug) => projectUser.ensureProjectUser(slug),
  ownWorkspace: (ws, user) => projectUser.ownWorkspace(ws, user),
  runPrompt: (opts) => opencode.runPrompt(opts),
};

// Shared Teams/Discord investigation pipeline: workspace sync, per-project OS
// user, one OpenCode session per conversation, run accounting.
// opts: { files, admin, onEvent, command }
async function investigate(project, conv, prompt, opts = {}) {
  const startedAt = Date.now();
  try {
    const ws = await deps.ensureReady(project);
    const runAs = deps.ensureProjectUser(project.slug);
    deps.ownWorkspace(ws, runAs);
    const result = await deps.runPrompt({
      dir: ws,
      sessionId: conv.opencode_session_id,
      text: prompt,
      conversationId: conv.id,
      runAs,
      model: conv.model || undefined,
      agent: conv.agent || undefined,
      command: opts.command,
      files: opts.files,
      configPath: opts.admin ? path.join(ws, 'opencode.admin.json') : undefined,
      cancelKey: conv.id,
      onEvent: opts.onEvent,
    });
    if (!conv.opencode_session_id) convs.setSession(conv.id, result.sessionId);
    const usage = result.usage || {};
    runs.add({
      project_id: project.id, conversation_id: conv.id, status: 'success',
      duration_ms: Date.now() - startedAt,
      tokens_input: usage.tokensInput ?? null, tokens_output: usage.tokensOutput ?? null,
      tokens_reasoning: usage.tokensReasoning ?? null, cost_usd: usage.costUsd ?? null,
    });
    return result.text || '(agent returned no text)';
  } catch (err) {
    const isTimeout = /timeout|timed out/i.test(err.message);
    runs.add({
      project_id: project.id, conversation_id: conv.id,
      status: err.stopped ? 'stopped' : (isTimeout ? 'timeout' : 'error'),
      duration_ms: Date.now() - startedAt,
      error: err.message.slice(0, 1000),
    });
    throw err;
  }
}

module.exports = { investigate, deps };
```

- [ ] **Step 4: Rewire `controllers/event.controller.js`**

Delete its local `investigate` function (lines 27–53) and the now-unused `sync`, `opencode`, `projectUser`, `runs` imports if nothing else uses them (`sync` is still used by `pull-source`; keep it). Add `const investigation = require('../services/investigation.service');` and replace the call `investigate(project, conv, prompt)` with `investigation.investigate(project, conv, prompt)`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — `tests/eventController.test.js` must stay green.

- [ ] **Step 6: Commit**

```bash
git add services/investigation.service.js controllers/event.controller.js tests/investigation.test.js
git commit -m "refactor: extract shared investigation pipeline for teams and discord"
```

---

### Task 6: Workspace admin config (`opencode.admin.json`)

**Files:**
- Modify: `services/workspace.service.js`
- Test: `tests/workspace.test.js` (append)

**Interfaces:**
- Consumes: existing `buildOpencodeConfig(project)`, `writeWorkspaceFiles(project, apiGroups)`.
- Produces: `buildOpencodeAdminConfig(project)` → same shape as `buildOpencodeConfig` but `permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' }`; `adminConfigPathFor(ws)` → `<ws>/opencode.admin.json`; `writeWorkspaceFiles` also writes `opencode.admin.json`.

- [ ] **Step 1: Write the failing tests** — append to `tests/workspace.test.js` (match its existing imports/patterns; it already imports the service and uses temp dirs):

```js
test('admin config allows all tools but keeps the same MCP wiring', () => {
  const project = { slug: 'adm', name: 'Adm', system_prompt: '' };
  const cfg = workspace.buildOpencodeAdminConfig(project);
  assert.deepStrictEqual(cfg.permission, { edit: 'allow', bash: 'allow', webfetch: 'allow' });
  assert.strictEqual(cfg.mcp.otb.environment.OTB_PROJECT_SLUG, 'adm');
});

test('writeWorkspaceFiles writes opencode.admin.json next to opencode.json', () => {
  const project = { slug: 'adm2', name: 'Adm2', system_prompt: '' };
  const ws = workspace.writeWorkspaceFiles(project, []);
  assert.ok(fs.existsSync(path.join(ws, 'opencode.admin.json')));
  assert.strictEqual(workspace.adminConfigPathFor(ws), path.join(ws, 'opencode.admin.json'));
  const parsed = JSON.parse(fs.readFileSync(path.join(ws, 'opencode.admin.json'), 'utf8'));
  assert.strictEqual(parsed.permission.bash, 'allow');
});
```

If `tests/workspace.test.js` does not already import `workspace`, `fs`, `path` under those names, adapt the test to the file's local names — do not rename its existing imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/workspace.test.js`
Expected: FAIL — `buildOpencodeAdminConfig is not a function`.

- [ ] **Step 3: Implement in `services/workspace.service.js`**

```js
// DM-admin sessions: full tool access, same guarded MCP. The OS-user sandbox
// (otb-<slug>) still applies; this config must never be the default one.
function buildOpencodeAdminConfig(project) {
  const cfg = buildOpencodeConfig(project);
  return { ...cfg, permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' } };
}

function adminConfigPathFor(ws) {
  return path.join(ws, 'opencode.admin.json');
}
```

In `writeWorkspaceFiles`, after the `opencode.json` write add:

```js
  fs.writeFileSync(adminConfigPathFor(ws), JSON.stringify(buildOpencodeAdminConfig(project), null, 2));
```

Add `buildOpencodeAdminConfig` and `adminConfigPathFor` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/workspace.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/workspace.service.js tests/workspace.test.js
git commit -m "feat: generate full-permission opencode.admin.json per workspace"
```

---

### Task 7: OpenCode info service (models, agents, skills, custom commands)

**Files:**
- Create: `services/opencodeInfo.service.js`
- Test: `tests/opencodeInfo.test.js`

**Interfaces:**
- Consumes: `setting.model` `get(key)` (keys `discord_allowed_models`, `discord_default_model`); `opencode models` / `opencode agent list` CLI.
- Produces:
  - `proc` — stubbable `{ execFile(cmd, args, opts) → Promise<{stdout}> }`.
  - `listModels(dir)` → Promise<string[]> (CLI output lines, cached 10 min; `_resetCache()` export for tests).
  - `allowedModels(dir)` → Promise<string[]> — intersection with the `discord_allowed_models` setting (newline-separated); when the setting is empty/null, returns all CLI models.
  - `defaultModel()` → string|null from `discord_default_model` setting.
  - `listAgents(dir)` → Promise<string[]>.
  - `listSkills(ws)` → `[{ name, description }]` from `<ws>/.opencode/skill/*/SKILL.md` and `~/.config/opencode/skill/*/SKILL.md` (missing dirs → skip).
  - `listCommands(ws)` → `[{ name, description }]` from `<ws>/.opencode/command/*.md` (name = filename without `.md`; description = frontmatter `description:` line or first non-empty non-frontmatter line, else '').

- [ ] **Step 1: Write the failing tests** — create `tests/opencodeInfo.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const settings = require('../models/setting.model');
const info = require('../services/opencodeInfo.service');

beforeEach(() => { resetDbForTest(); info._resetCache(); });

test('allowedModels intersects CLI output with the admin allowlist', async () => {
  info.proc.execFile = async () => ({ stdout: 'anthropic/claude-sonnet-5\nanthropic/claude-opus-4-8\nopenai/gpt-5\n' });
  settings.set('discord_allowed_models', 'anthropic/claude-sonnet-5\nopenai/gpt-5');
  const models = await info.allowedModels('/tmp/ws');
  assert.deepStrictEqual(models, ['anthropic/claude-sonnet-5', 'openai/gpt-5']);
});

test('allowedModels returns all CLI models when no allowlist is set', async () => {
  info.proc.execFile = async () => ({ stdout: 'a/m1\nb/m2\n' });
  assert.deepStrictEqual(await info.allowedModels('/tmp/ws'), ['a/m1', 'b/m2']);
});

test('listModels caches CLI output', async () => {
  let calls = 0;
  info.proc.execFile = async () => { calls += 1; return { stdout: 'a/m1\n' }; };
  await info.listModels('/tmp/ws');
  await info.listModels('/tmp/ws');
  assert.strictEqual(calls, 1);
});

test('listSkills and listCommands scan the workspace', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-info-'));
  fs.mkdirSync(path.join(ws, '.opencode', 'skill', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.opencode', 'skill', 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploy helper\n---\nBody');
  fs.mkdirSync(path.join(ws, '.opencode', 'command'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.opencode', 'command', 'health.md'), 'Check service health');
  const skills = info.listSkills(ws);
  assert.deepStrictEqual(skills.find((s) => s.name === 'deploy'), { name: 'deploy', description: 'Deploy helper' });
  assert.deepStrictEqual(info.listCommands(ws), [{ name: 'health', description: 'Check service health' }]);
});

test('listAgents parses CLI lines', async () => {
  info.proc.execFile = async () => ({ stdout: 'build\nplan\n' });
  assert.deepStrictEqual(await info.listAgents('/tmp/ws'), ['build', 'plan']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/opencodeInfo.test.js`
Expected: FAIL — `Cannot find module '../services/opencodeInfo.service'`.

- [ ] **Step 3: Implement `services/opencodeInfo.service.js`**

```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const settings = require('../models/setting.model');

const CACHE_TTL_MS = 10 * 60 * 1000;

// Indirection over execFile so tests can stub CLI calls.
const proc = { execFile: promisify(execFile) };

let modelCache = null; // { at, values }
function _resetCache() { modelCache = null; }

async function listModels(dir) {
  if (modelCache && Date.now() - modelCache.at < CACHE_TTL_MS) return modelCache.values;
  const { stdout } = await proc.execFile('opencode', ['models'], { cwd: dir, timeout: 30000 });
  const values = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  modelCache = { at: Date.now(), values };
  return values;
}

async function allowedModels(dir) {
  const all = await listModels(dir);
  const raw = settings.get('discord_allowed_models');
  const allow = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!allow.length) return all;
  return all.filter((m) => allow.includes(m));
}

function defaultModel() {
  const v = settings.get('discord_default_model');
  return v && v.trim() ? v.trim() : null;
}

async function listAgents(dir) {
  const { stdout } = await proc.execFile('opencode', ['agent', 'list'], { cwd: dir, timeout: 30000 });
  return String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
}

function frontmatterField(md, field) {
  const m = String(md).match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
}

function scanSkillDir(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const md = fs.readFileSync(f, 'utf8');
    out.push({ name: frontmatterField(md, 'name') || e.name, description: frontmatterField(md, 'description') });
  }
  return out;
}

function listSkills(ws) {
  return [
    ...scanSkillDir(path.join(ws, '.opencode', 'skill')),
    ...scanSkillDir(path.join(os.homedir(), '.config', 'opencode', 'skill')),
  ];
}

function listCommands(ws) {
  const dir = path.join(ws, '.opencode', 'command');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries.filter((f) => f.endsWith('.md')).map((f) => {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    const desc = frontmatterField(md, 'description')
      || md.split('\n').find((l) => l.trim() && !l.startsWith('---')) || '';
    return { name: f.replace(/\.md$/, ''), description: desc.trim() };
  });
}

module.exports = { proc, _resetCache, listModels, allowedModels, defaultModel, listAgents, listSkills, listCommands };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/opencodeInfo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/opencodeInfo.service.js tests/opencodeInfo.test.js
git commit -m "feat: add opencode info service (models, agents, skills, commands)"
```

---

### Task 8: Inbound attachment service

**Files:**
- Create: `services/discordAttachment.service.js`
- Test: `tests/discordAttachments.test.js`

**Interfaces:**
- Consumes: env `DISCORD_MAX_ATTACHMENT_MB` (default 20), `DISCORD_MAX_ATTACHMENTS` (default 5).
- Produces:
  - `net` — stubbable `{ fetch }`.
  - `limits()` → `{ maxBytes, maxCount }`.
  - `validate(attachments)` → `{ ok: true }` or `{ ok: false, reason }` (checks count, size, type). Attachment shape: `{ name, url, size, contentType }`.
  - `downloadAll(attachments, destDir, prefix)` → Promise<string[]> of written paths `<destDir>/<prefix>-<sanitized name>`; creates destDir recursively; throws on non-OK HTTP.
  - `uploadDirFor(ws, conversationId)` → `<ws>/.otb-uploads/<conversationId>`.
  - `DEFAULT_ATTACHMENT_PROMPT = 'Analyze the attached file(s) in the context of this project.'`

- [ ] **Step 1: Write the failing tests** — create `tests/discordAttachments.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const att = require('../services/discordAttachment.service');

const png = { name: 'shot.png', url: 'https://cdn/x.png', size: 1024, contentType: 'image/png' };

test('validate rejects too many, too large, and disallowed types', () => {
  assert.deepStrictEqual(att.validate([png]), { ok: true });
  const six = Array(6).fill(png);
  assert.match(att.validate(six).reason, /at most 5/i);
  const big = { ...png, size: 21 * 1024 * 1024 };
  assert.match(att.validate([big]).reason, /20 MB/i);
  const exe = { name: 'evil.exe', url: 'u', size: 10, contentType: 'application/octet-stream' };
  assert.match(att.validate([exe]).reason, /not supported/i);
  const log = { name: 'app.log', url: 'u', size: 10, contentType: 'application/octet-stream' };
  assert.deepStrictEqual(att.validate([log]), { ok: true }); // extension allowlist wins
});

test('downloadAll writes each attachment under prefix and sanitizes names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-att-'));
  att.net.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('data').buffer });
  const paths = await att.downloadAll(
    [{ name: 'a b/../c.png', url: 'https://cdn/a.png', size: 4, contentType: 'image/png' }],
    dir, 'msg1'
  );
  assert.strictEqual(paths.length, 1);
  assert.ok(paths[0].startsWith(path.join(dir, 'msg1-')));
  assert.ok(!paths[0].includes('..'));
  assert.strictEqual(fs.readFileSync(paths[0], 'utf8'), 'data');
});

test('downloadAll throws on http failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-att-'));
  att.net.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(att.downloadAll([png], dir, 'm'), /403/);
});

test('uploadDirFor builds the per-conversation path', () => {
  assert.strictEqual(att.uploadDirFor('/ws/proj', 12), path.join('/ws/proj', '.otb-uploads', '12'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/discordAttachments.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `services/discordAttachment.service.js`**

```js
const fs = require('fs');
const path = require('path');

// Discord CDN URLs are signed and expire (~24h) — always download immediately,
// never store the URL for later.
const net = { fetch: (...args) => fetch(...args) };

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const TEXT_EXT = new Set(['txt', 'md', 'log', 'json', 'csv', 'yaml', 'yml', 'xml', 'html', 'css',
  'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php',
  'sh', 'sql', 'toml', 'ini', 'env', 'conf', 'diff', 'patch']);

const DEFAULT_ATTACHMENT_PROMPT = 'Analyze the attached file(s) in the context of this project.';

function limits() {
  return {
    maxBytes: Number(process.env.DISCORD_MAX_ATTACHMENT_MB || 20) * 1024 * 1024,
    maxCount: Number(process.env.DISCORD_MAX_ATTACHMENTS || 5),
  };
}

function ext(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function isAllowedType(a) {
  const e = ext(a.name);
  if (IMAGE_EXT.has(e) || TEXT_EXT.has(e)) return true;
  const ct = String(a.contentType || '');
  return ct.startsWith('text/') || ct.startsWith('image/');
}

function validate(attachments) {
  const { maxBytes, maxCount } = limits();
  if (attachments.length > maxCount) {
    return { ok: false, reason: `Please attach at most ${maxCount} files per message.` };
  }
  for (const a of attachments) {
    if (Number(a.size) > maxBytes) {
      return { ok: false, reason: `"${a.name}" is larger than ${maxBytes / 1024 / 1024} MB.` };
    }
    if (!isAllowedType(a)) {
      return { ok: false, reason: `"${a.name}" is not supported. Send images or text-based files.` };
    }
  }
  return { ok: true };
}

function sanitizeName(name) {
  return String(name || 'file').replace(/[^\w.-]/g, '_').slice(0, 120);
}

async function downloadAll(attachments, destDir, prefix) {
  fs.mkdirSync(destDir, { recursive: true });
  const paths = [];
  for (const a of attachments) {
    const resp = await net.fetch(a.url);
    if (!resp.ok) throw new Error(`Attachment download failed (${resp.status}) for ${a.name}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const p = path.join(destDir, `${sanitizeName(prefix)}-${sanitizeName(a.name)}`);
    fs.writeFileSync(p, buf);
    paths.push(p);
  }
  return paths;
}

function uploadDirFor(ws, conversationId) {
  return path.join(ws, '.otb-uploads', String(conversationId));
}

module.exports = { net, limits, isAllowedType, validate, downloadAll, uploadDirFor, DEFAULT_ATTACHMENT_PROMPT };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/discordAttachments.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/discordAttachment.service.js tests/discordAttachments.test.js
git commit -m "feat: add discord inbound attachment validation and download"
```

---

### Task 9: Discord router — plain messages (channels + DMs)

**Files:**
- Create: `services/discordRouter.js`
- Test: `tests/discordRouter.test.js`

**Interfaces:**
- Consumes: models from Tasks 1–2; `discordFormat` (Task 3); `investigation.investigate` (Task 5); `discordAttachment` (Task 8); `sync.ensureReady`; `opencode.cancel/isRunning` (Task 4); `opencodeInfo` (Task 7).
- Produces:
  - `deps` — stubbable `{ investigate, ensureReady, syncProject, opencode, info, attachments }` (defaults wired to the real modules).
  - `externalIdFor(msg)` → `discord:<channelId>` or `discord:dm:<botId>:<userId>`.
  - `resolveContext(msg)` → `null` (stay silent) or `{ project, dmUser|null, needsSelection?: true }`.
  - `allowedProjectsFor(user, botId)` → project rows the user may access on this bot.
  - `handleMessage(msg, io)` → Promise<void>.
  - **msg shape** (produced by the adapter in Task 11): `{ botId, channelId, isDM, authorId, authorName, authorIsBot, mentionsBot, content, attachments: [{ name, url, size, contentType }], messageId }`.
  - **io shape** (implemented by the adapter in Task 11): `{ reply(text), replyEmbed(embed), sendFile(name, content), react(emoji), setReaction(emoji), startTyping(), stopTyping() }` — all return Promises.

- [ ] **Step 1: Write the failing tests** — create `tests/discordRouter.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const bots = require('../models/discordBot.model');
const channels = require('../models/discordChannel.model');
const dmUsers = require('../models/discordUser.model');
const router = require('../services/discordRouter');
const { EMOJI } = require('../lib/discordFormat');

let bot, project;
beforeEach(() => {
  resetDbForTest();
  bot = bots.create({ name: 'b', token: 't' });
  project = projects.create({ slug: 'pay', name: 'Pay', keyword: '', system_prompt: '', teams_webhook_url: '' });
  projects.update(project.id, { discord_bot_id: bot.id });
  project = projects.findById(project.id);
  router.deps.investigate = async () => 'the answer';
  router.deps.ensureReady = async () => '/tmp/ws-router';
});

function fakeIo() {
  const calls = { replies: [], embeds: [], reactions: [], files: [], typing: 0 };
  return {
    calls,
    reply: async (t) => calls.replies.push(t),
    replyEmbed: async (e) => calls.embeds.push(e),
    sendFile: async (name, content) => calls.files.push({ name, content }),
    react: async (e) => calls.reactions.push(e),
    setReaction: async (e) => calls.reactions.push(e),
    startTyping: async () => { calls.typing += 1; },
    stopTyping: async () => {},
  };
}

function guildMsg(over = {}) {
  return {
    botId: bot.id, channelId: '111', isDM: false, authorId: 'u1', authorName: 'Alice',
    authorIsBot: false, mentionsBot: false, content: 'why down?', attachments: [], messageId: 'm1', ...over,
  };
}

test('ignores undesignated channels and bot authors', async () => {
  const io = fakeIo();
  await router.handleMessage(guildMsg(), io); // no channel row yet
  await router.handleMessage(guildMsg({ authorIsBot: true }), io);
  assert.strictEqual(io.calls.replies.length, 0);
  assert.strictEqual(io.calls.reactions.length, 0);
});

test('mention mode requires a mention; all mode answers everything', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'mention' }]);
  const io1 = fakeIo();
  await router.handleMessage(guildMsg({ mentionsBot: false }), io1);
  assert.strictEqual(io1.calls.replies.length, 0);
  const io2 = fakeIo();
  await router.handleMessage(guildMsg({ mentionsBot: true }), io2);
  assert.deepStrictEqual(io2.calls.replies, ['the answer']);
  assert.deepStrictEqual(io2.calls.reactions, [EMOJI.accepted, EMOJI.success]);
  const conv = convs.findActive(project.id, 'discord:111');
  assert.ok(conv);
  const msgs = messages.listByConversation ? messages.listByConversation(conv.id) : null;
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  const io3 = fakeIo();
  await router.handleMessage(guildMsg({ mentionsBot: false }), io3);
  assert.strictEqual(io3.calls.replies.length, 1);
});

test('channel bound to another bot stays silent', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  const io = fakeIo();
  await router.handleMessage(guildMsg({ botId: bot.id + 999 }), io);
  assert.strictEqual(io.calls.replies.length, 0);
});

test('investigation error posts an error embed and error reaction', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  router.deps.investigate = async () => { throw new Error('boom'); };
  const io = fakeIo();
  await router.handleMessage(guildMsg(), io);
  assert.strictEqual(io.calls.embeds.length, 1);
  assert.match(io.calls.embeds[0].description, /boom/);
  assert.deepStrictEqual(io.calls.reactions, [EMOJI.accepted, EMOJI.error]);
});

test('DM from unknown user is silent; allowlisted user without selection is prompted', async () => {
  const dm = guildMsg({ isDM: true, channelId: 'dm-1', authorId: '42' });
  const io1 = fakeIo();
  await router.handleMessage(dm, io1);
  assert.strictEqual(io1.calls.replies.length + io1.calls.embeds.length, 0);
  const u = dmUsers.create({ discord_user_id: '42', all_projects: 1 });
  const io2 = fakeIo();
  await router.handleMessage(dm, io2);
  assert.strictEqual(io2.calls.embeds.length, 1);
  assert.match(io2.calls.embeds[0].description, /\/project/);
});

test('DM with a selected project runs and keeps a per-user conversation id', async () => {
  const u = dmUsers.create({ discord_user_id: '42', all_projects: 1 });
  dmUsers.setSelection(u.id, bot.id, project.id);
  const io = fakeIo();
  await router.handleMessage(guildMsg({ isDM: true, channelId: 'dm-1', authorId: '42' }), io);
  assert.deepStrictEqual(io.calls.replies, ['the answer']);
  assert.ok(convs.findActive(project.id, `discord:dm:${bot.id}:42`));
});

test('DM admin runs with admin=true', async () => {
  const u = dmUsers.create({ discord_user_id: '42', role: 'admin' });
  dmUsers.setSelection(u.id, bot.id, project.id);
  let seenOpts = null;
  router.deps.investigate = async (p, c, prompt, opts) => { seenOpts = opts; return 'ok'; };
  const io = fakeIo();
  await router.handleMessage(guildMsg({ isDM: true, channelId: 'dm-1', authorId: '42' }), io);
  assert.strictEqual(seenOpts.admin, true);
});

test('attachments are validated, downloaded, and passed as files', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  let seenOpts = null;
  router.deps.investigate = async (p, c, prompt, opts) => { seenOpts = opts; return 'ok'; };
  router.deps.attachments = {
    ...require('../services/discordAttachment.service'),
    validate: () => ({ ok: true }),
    downloadAll: async () => ['/tmp/ws-router/.otb-uploads/1/m1-a.png'],
  };
  const io = fakeIo();
  await router.handleMessage(guildMsg({ content: '', attachments: [{ name: 'a.png', url: 'u', size: 1, contentType: 'image/png' }] }), io);
  assert.deepStrictEqual(seenOpts.files, ['/tmp/ws-router/.otb-uploads/1/m1-a.png']);
});

test('oversize attachment posts a warning embed and does not run', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  let ran = false;
  router.deps.investigate = async () => { ran = true; return 'x'; };
  router.deps.attachments = {
    ...require('../services/discordAttachment.service'),
    validate: () => ({ ok: false, reason: 'too big' }),
  };
  const io = fakeIo();
  await router.handleMessage(guildMsg({ attachments: [{ name: 'a.bin', url: 'u', size: 1, contentType: 'x' }] }), io);
  assert.strictEqual(ran, false);
  assert.match(io.calls.embeds[0].description, /too big/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/discordRouter.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `services/discordRouter.js`** (message half; `handleInteraction` comes in Task 10):

```js
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const discordChannels = require('../models/discordChannel.model');
const dmUsers = require('../models/discordUser.model');
const fmt = require('../lib/discordFormat');
const investigation = require('./investigation.service');
const sync = require('./sync.service');
const opencode = require('./opencode.service');
const info = require('./opencodeInfo.service');
const attachmentsSvc = require('./discordAttachment.service');

// Stubbable seams for tests; everything else in this file is pure DB logic.
const deps = {
  investigate: (p, c, prompt, opts) => investigation.investigate(p, c, prompt, opts),
  ensureReady: (p) => sync.ensureReady(p),
  syncProject: (id) => sync.syncProject(id),
  opencode,
  info,
  attachments: attachmentsSvc,
};

function externalIdFor(msg) {
  return msg.isDM ? `discord:dm:${msg.botId}:${msg.authorId}` : `discord:${msg.channelId}`;
}

function allowedProjectsFor(user, botId) {
  const bound = projects.list().filter((p) => Number(p.discord_bot_id) === Number(botId));
  if (user.role === 'admin' || user.all_projects) return bound;
  const ids = new Set(dmUsers.listProjectIds(user.id));
  return bound.filter((p) => ids.has(p.id));
}

// null => stay silent. { needsSelection } => allowlisted DM without a project.
function resolveContext(msg) {
  if (msg.isDM) {
    const user = dmUsers.findByDiscordId(msg.authorId);
    if (!user) return null;
    const selectedId = dmUsers.getSelection(user.id, msg.botId);
    const allowed = allowedProjectsFor(user, msg.botId);
    const project = allowed.find((p) => p.id === selectedId) || null;
    if (!project) return { project: null, dmUser: user, needsSelection: true };
    return { project, dmUser: user };
  }
  const ch = discordChannels.findByChannelId(msg.channelId);
  if (!ch) return null;
  const project = projects.findById(ch.project_id);
  if (!project || Number(project.discord_bot_id) !== Number(msg.botId)) return null;
  if (ch.mode === 'mention' && !msg.mentionsBot) return null;
  return { project, dmUser: null };
}

function ensureConversation(project, externalId) {
  return convs.findActive(project.id, externalId) || convs.create(project.id, externalId);
}

async function runAndReply({ project, conv, prompt, files, admin, io }) {
  await io.react(fmt.EMOJI.accepted);
  await io.startTyping();
  try {
    const answer = await deps.investigate(project, convs.findById(conv.id), prompt, { files, admin });
    messages.add({ conversation_id: conv.id, direction: 'out', content: answer });
    const { chunks, file } = fmt.renderAnswer(answer, { maxLength: project.max_msg_length });
    for (const chunk of chunks) await io.reply(chunk);
    if (file) await io.sendFile(file.name, file.content);
    await io.setReaction(fmt.EMOJI.success);
  } catch (err) {
    messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
    const isTimeout = /timeout|timed out/i.test(err.message);
    if (err.stopped) {
      await io.replyEmbed(fmt.statusEmbed({
        status: 'warning', title: 'Investigation stopped',
        description: 'The running investigation was stopped with /stop.', footer: project.slug,
      }));
      await io.setReaction(fmt.EMOJI.stopped);
    } else if (isTimeout) {
      await io.replyEmbed(fmt.statusEmbed({
        status: 'warning', title: 'Investigation did not finish',
        description: 'OpenCode ran too long, so the server stopped the job.\n\nAsk again with a narrower scope.',
        footer: project.slug,
      }));
      await io.setReaction(fmt.EMOJI.timeout);
    } else {
      await io.replyEmbed(fmt.statusEmbed({
        status: 'error', title: 'Investigation failed',
        description: `**Reason**\n${err.message}\n\nCheck the project configuration in the admin UI, then try again.`,
        footer: project.slug,
      }));
      await io.setReaction(fmt.EMOJI.error);
    }
  } finally {
    await io.stopTyping();
  }
}

async function handleMessage(msg, io) {
  if (msg.authorIsBot) return;
  const ctx = resolveContext(msg);
  if (!ctx) return;
  if (ctx.needsSelection) {
    await io.replyEmbed(fmt.statusEmbed({
      status: 'info', title: 'Select a project first',
      description: 'Use `/projects` to list projects you can access, then `/project <slug>` to select one.',
    }));
    return;
  }
  const { project, dmUser } = ctx;
  const prompt = String(msg.content || '').trim();
  const atts = msg.attachments || [];
  if (!prompt && !atts.length) return;

  const conv = ensureConversation(project, externalIdFor(msg));
  let content = prompt;
  if (atts.length) content = [prompt, fmt.attachmentMarkers(atts)].filter(Boolean).join('\n');
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: msg.authorId, user_name: msg.authorName, content });
  convs.touch(conv.id);

  let files;
  if (atts.length) {
    const verdict = deps.attachments.validate(atts);
    if (!verdict.ok) {
      await io.replyEmbed(fmt.statusEmbed({ status: 'warning', title: 'Attachment rejected', description: verdict.reason }));
      return;
    }
    const ws = await deps.ensureReady(project);
    files = await deps.attachments.downloadAll(atts, deps.attachments.uploadDirFor(ws, conv.id), msg.messageId);
  }

  await runAndReply({
    project, conv,
    prompt: prompt || deps.attachments.DEFAULT_ATTACHMENT_PROMPT,
    files,
    admin: Boolean(dmUser && dmUser.role === 'admin'),
    io,
  });
}

module.exports = { deps, externalIdFor, allowedProjectsFor, resolveContext, ensureConversation, runAndReply, handleMessage };
```

Note: `messages.listByConversation` may not exist — the test only calls it guarded; do not add it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/discordRouter.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/discordRouter.js tests/discordRouter.test.js
git commit -m "feat: discord message router with channel modes, DM allowlist, attachments"
```

---

### Task 10: Discord router — slash commands + autocomplete

**Files:**
- Modify: `services/discordRouter.js`
- Test: `tests/discordRouterCommands.test.js`

**Interfaces:**
- Consumes: everything from Task 9; `runs.statsForConversation/statsForProject` (Task 2); `opencode.cancel/isRunning` (Task 4); `info.allowedModels/listAgents/listSkills/listCommands/defaultModel` (Task 7); `repos.listByProject` for sync footer.
- Produces:
  - `handleInteraction(cmd, io)` → Promise<void>. **cmd shape:** `{ name, options: {…string values}, botId, channelId, isDM, userId, userName }`. **interaction io shape:** `{ respond(text), respondEmbed(embed), followUp(text), sendFile(name, content) }` (all after an already-sent defer).
  - `autocompleteOptions(cmd)` → Promise<`[{ name, value }]`> (≤25) for `cmd.focused` in `{ 'model', 'agent', 'slug' }` with `cmd.partial` prefix string.
  - `GUIDE_TEXT` — markdown listing all commands.

- [ ] **Step 1: Write the failing tests** — create `tests/discordRouterCommands.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const bots = require('../models/discordBot.model');
const channels = require('../models/discordChannel.model');
const dmUsers = require('../models/discordUser.model');
const router = require('../services/discordRouter');

let bot, project;
beforeEach(() => {
  resetDbForTest();
  bot = bots.create({ name: 'b', token: 't' });
  project = projects.create({ slug: 'pay', name: 'Pay', keyword: '', system_prompt: '', teams_webhook_url: '' });
  projects.update(project.id, { discord_bot_id: bot.id });
  project = projects.findById(project.id);
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'mention' }]);
  router.deps.investigate = async () => 'answer';
  router.deps.ensureReady = async () => '/tmp/ws-cmd';
});

function fakeIo() {
  const calls = { texts: [], embeds: [], followUps: [], files: [] };
  return {
    calls,
    respond: async (t) => calls.texts.push(t),
    respondEmbed: async (e) => calls.embeds.push(e),
    followUp: async (t) => calls.followUps.push(t),
    sendFile: async (n, c) => calls.files.push({ n, c }),
  };
}

function cmd(name, options = {}, over = {}) {
  return { name, options, botId: bot.id, channelId: '111', isDM: false, userId: 'u1', userName: 'Alice', ...over };
}

test('/new closes the active conversation and starts a new one', async () => {
  const c1 = convs.create(project.id, 'discord:111');
  const io = fakeIo();
  await router.handleInteraction(cmd('new'), io);
  assert.strictEqual(convs.findById(c1.id).status, 'closed');
  const c2 = convs.findActive(project.id, 'discord:111');
  assert.ok(c2 && c2.id !== c1.id);
  assert.match(io.calls.embeds[0].title, /New conversation/i);
});

test('/model with no args lists allowed models; with arg sets the override', async () => {
  router.deps.info = { ...router.deps.info, allowedModels: async () => ['a/m1', 'b/m2'], defaultModel: () => null };
  const io1 = fakeIo();
  await router.handleInteraction(cmd('model'), io1);
  assert.match(io1.calls.embeds[0].description, /a\/m1/);
  const io2 = fakeIo();
  await router.handleInteraction(cmd('model', { name: 'a/m1' }), io2);
  const conv = convs.findActive(project.id, 'discord:111');
  assert.strictEqual(conv.model, 'a/m1');
  const io3 = fakeIo();
  await router.handleInteraction(cmd('model', { name: 'not/allowed' }), io3);
  assert.match(io3.calls.embeds[0].description, /not in the allowed list/i);
});

test('/status reports project, session, model, and running state', async () => {
  router.deps.info = { ...router.deps.info, defaultModel: () => 'a/m1' };
  router.deps.opencode = { ...router.deps.opencode, isRunning: () => true };
  const io = fakeIo();
  await router.handleInteraction(cmd('status'), io);
  const d = io.calls.embeds[0].description;
  assert.match(d, /Pay/);
  assert.match(d, /a\/m1/);
  assert.match(d, /running/i);
});

test('/stop cancels a running investigation', async () => {
  const c = convs.create(project.id, 'discord:111');
  let cancelled = null;
  router.deps.opencode = { ...router.deps.opencode, cancel: (k) => { cancelled = k; return true; } };
  const io = fakeIo();
  await router.handleInteraction(cmd('stop'), io);
  assert.strictEqual(cancelled, c.id);
  const io2 = fakeIo();
  router.deps.opencode = { ...router.deps.opencode, cancel: () => false };
  await router.handleInteraction(cmd('stop'), io2);
  assert.match(io2.calls.embeds[0].description, /no running/i);
});

test('/projects and /project work in DM for allowlisted users', async () => {
  const u = dmUsers.create({ discord_user_id: '42', all_projects: 1 });
  const dm = { channelId: 'dm-1', isDM: true, userId: '42' };
  const io1 = fakeIo();
  await router.handleInteraction(cmd('projects', {}, dm), io1);
  assert.match(io1.calls.embeds[0].description, /pay/);
  const io2 = fakeIo();
  await router.handleInteraction(cmd('project', { slug: 'pay' }, dm), io2);
  assert.strictEqual(dmUsers.getSelection(u.id, bot.id), project.id);
  const io3 = fakeIo();
  await router.handleInteraction(cmd('project', { slug: 'nope' }, dm), io3);
  assert.match(io3.calls.embeds[0].description, /not.*(found|allowed)/i);
});

test('/projects in a guild channel explains it is DM-only', async () => {
  const io = fakeIo();
  await router.handleInteraction(cmd('projects'), io);
  assert.match(io.calls.embeds[0].description, /DM/);
});

test('/skills and /commands list workspace inventory', async () => {
  router.deps.info = {
    ...router.deps.info,
    listSkills: () => [{ name: 'deploy', description: 'Deploy helper' }],
    listCommands: () => [{ name: 'health', description: 'Check health' }],
  };
  const io1 = fakeIo();
  await router.handleInteraction(cmd('skills'), io1);
  assert.match(io1.calls.embeds[0].description, /deploy/);
  const io2 = fakeIo();
  await router.handleInteraction(cmd('commands'), io2);
  assert.match(io2.calls.embeds[0].description, /health/);
});

test('/ask runs an investigation and responds with the answer', async () => {
  const io = fakeIo();
  await router.handleInteraction(cmd('ask', { question: 'why?' }), io);
  assert.deepStrictEqual(io.calls.texts, ['answer']);
});

test('/cmd runs a custom workspace command', async () => {
  let seen = null;
  router.deps.investigate = async (p, c, prompt, opts) => { seen = { prompt, opts }; return 'done'; };
  const io = fakeIo();
  await router.handleInteraction(cmd('cmd', { name: 'health', args: 'prod' }), io);
  assert.strictEqual(seen.opts.command, 'health');
  assert.strictEqual(seen.prompt, 'prod');
});

test('/stats reports run totals', async () => {
  const c = convs.create(project.id, 'discord:111');
  require('../models/run.model').add({ project_id: project.id, conversation_id: c.id, status: 'success', duration_ms: 5, tokens_input: 10, tokens_output: 5, tokens_reasoning: 0, cost_usd: 0.1 });
  const io = fakeIo();
  await router.handleInteraction(cmd('stats'), io);
  assert.match(io.calls.embeds[0].description, /0.1/);
});

test('/sync re-pulls sources', async () => {
  router.deps.syncProject = async () => ({ ok: true, results: [{ git_url: 'g', status: 'success' }] });
  const io = fakeIo();
  await router.handleInteraction(cmd('sync'), io);
  assert.match(io.calls.embeds[0].title, /Sources updated/i);
});

test('autocomplete returns model, agent, and slug choices filtered by prefix', async () => {
  router.deps.info = { ...router.deps.info, allowedModels: async () => ['a/m1', 'b/m2'], listAgents: async () => ['plan'] };
  const models = await router.autocompleteOptions({ ...cmd('model'), focused: 'model', partial: 'a/' });
  assert.deepStrictEqual(models, [{ name: 'a/m1', value: 'a/m1' }]);
  dmUsers.create({ discord_user_id: '42', all_projects: 1 });
  const slugs = await router.autocompleteOptions({ ...cmd('project', {}, { isDM: true, userId: '42' }), focused: 'slug', partial: '' });
  assert.deepStrictEqual(slugs, [{ name: 'pay', value: 'pay' }]);
});

test('interactions from non-designated contexts are refused politely', async () => {
  const io = fakeIo();
  await router.handleInteraction(cmd('new', {}, { channelId: '999' }), io);
  assert.match(io.calls.embeds[0].description, /not configured/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/discordRouterCommands.test.js`
Expected: FAIL — `router.handleInteraction is not a function`.

- [ ] **Step 3: Implement in `services/discordRouter.js`** — append (and export the new symbols):

```js
const runsModel = require('../models/run.model');
const repos = require('../models/repo.model');

const GUIDE_TEXT = [
  '**Ask a question**: mention the bot (or just type, in `all` channels / DMs) — or use `/ask`.',
  '',
  '**Commands**',
  '- `/ask <question>` — run an investigation',
  '- `/new` — start a fresh conversation and OpenCode session',
  '- `/stop` — cancel the running investigation',
  '- `/status` — project, session, model, run state',
  '- `/model [name] [variant]` — show or set the model for this conversation',
  '- `/agent [name]` — show or set the agent',
  '- `/skills` — list workspace skills',
  '- `/commands` — list custom workspace commands',
  '- `/cmd <name> [args]` — run a custom workspace command',
  '- `/stats` — token and cost totals',
  '- `/sync` — re-pull project sources',
  '- `/projects`, `/project <slug>` — (DM) list / select your project',
].join('\n');

// Interactions carry no message to react to; context resolution mirrors
// handleMessage but ignores channel mode (slash commands always answer).
function resolveInteractionContext(cmd) {
  if (cmd.isDM) {
    const user = dmUsers.findByDiscordId(cmd.userId);
    if (!user) return { refuse: 'You are not authorized to use this bot in DMs.' };
    const selectedId = dmUsers.getSelection(user.id, cmd.botId);
    const allowed = allowedProjectsFor(user, cmd.botId);
    const project = allowed.find((p) => p.id === selectedId) || null;
    return { project, dmUser: user, allowed };
  }
  const ch = discordChannels.findByChannelId(cmd.channelId);
  const project = ch ? projects.findById(ch.project_id) : null;
  if (!project || Number(project.discord_bot_id) !== Number(cmd.botId)) {
    return { refuse: 'This channel is not configured for any project.' };
  }
  return { project, dmUser: null };
}

function requireProject(ctx) {
  if (ctx.refuse) return { embed: fmt.statusEmbed({ status: 'warning', title: 'Not available here', description: ctx.refuse }) };
  if (!ctx.project) {
    return { embed: fmt.statusEmbed({
      status: 'info', title: 'Select a project first',
      description: 'Use `/projects` to list projects you can access, then `/project <slug>` to select one.',
    }) };
  }
  return null;
}

function interactionExternalId(cmd) {
  return cmd.isDM ? `discord:dm:${cmd.botId}:${cmd.userId}` : `discord:${cmd.channelId}`;
}

async function handleInteraction(cmd, io) {
  const ctx = resolveInteractionContext(cmd);

  if (cmd.name === 'guide') {
    return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'How to use this bot', description: GUIDE_TEXT }));
  }

  if (cmd.name === 'projects') {
    if (!cmd.isDM) {
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'DM only', description: 'Use `/projects` in a DM with the bot.' }));
    }
    if (ctx.refuse) return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Not authorized', description: ctx.refuse }));
    const lines = ctx.allowed.map((p) => `- \`${p.slug}\` — ${p.name}`).join('\n') || '(none)';
    return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'Your projects', description: lines }));
  }

  if (cmd.name === 'project') {
    if (!cmd.isDM) {
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'DM only', description: 'Use `/project` in a DM with the bot.' }));
    }
    if (ctx.refuse) return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Not authorized', description: ctx.refuse }));
    const slug = String(cmd.options.slug || '').trim();
    const target = ctx.allowed.find((p) => p.slug === slug);
    if (!target) {
      return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Unknown project', description: `Project \`${slug}\` was not found or is not allowed for you.` }));
    }
    dmUsers.setSelection(ctx.dmUser.id, cmd.botId, target.id);
    return io.respondEmbed(fmt.statusEmbed({ status: 'success', title: 'Project selected', description: `Now chatting with **${target.name}** (\`${target.slug}\`).` }));
  }

  const missing = requireProject(ctx);
  if (missing) return io.respondEmbed(missing.embed);
  const { project, dmUser } = ctx;
  const externalId = interactionExternalId(cmd);

  switch (cmd.name) {
    case 'new': {
      const active = convs.findActive(project.id, externalId);
      if (active) convs.close(active.id);
      convs.create(project.id, externalId);
      return io.respondEmbed(fmt.statusEmbed({
        status: 'info', title: 'New conversation created',
        description: `Project: ${project.name}\n\nThe next questions here will use a new OpenCode session.`,
        footer: project.slug,
      }));
    }
    case 'stop': {
      const active = convs.findActive(project.id, externalId);
      const cancelled = active ? deps.opencode.cancel(active.id) : false;
      return io.respondEmbed(fmt.statusEmbed({
        status: cancelled ? 'success' : 'info',
        title: cancelled ? 'Investigation stopped' : 'Nothing to stop',
        description: cancelled ? 'The running investigation was cancelled.' : 'There is no running investigation for this conversation.',
      }));
    }
    case 'status': {
      const active = convs.findActive(project.id, externalId);
      const model = (active && active.model) || deps.info.defaultModel() || '(opencode default)';
      const agent = (active && active.agent) || '(default)';
      const running = active ? deps.opencode.isRunning(active.id) : false;
      const repoRows = repos.listByProject(project.id);
      const lastSync = repoRows.map((r) => r.synced_at).filter(Boolean).sort().pop() || 'never';
      const lines = [
        `**Project**: ${project.name} (\`${project.slug}\`)`,
        `**Conversation**: ${active ? `#${active.id}` : 'none yet'}`,
        `**Session**: ${active && active.opencode_session_id ? active.opencode_session_id : 'not started'}`,
        `**Model**: ${model}`,
        `**Agent**: ${agent}`,
        `**State**: ${running ? 'running an investigation' : 'idle'}`,
        `**Last source sync**: ${lastSync}`,
      ];
      if (dmUser) lines.push(`**Your role**: ${dmUser.role}`);
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'Status', description: lines.join('\n'), footer: project.slug }));
    }
    case 'model': {
      const name = String(cmd.options.name || '').trim();
      const conv = ensureConversation(project, externalId);
      if (!name) {
        const models = await deps.info.allowedModels(await deps.ensureReady(project));
        const current = conv.model || deps.info.defaultModel() || '(opencode default)';
        return io.respondEmbed(fmt.statusEmbed({
          status: 'info', title: 'Model',
          description: `**Current**: ${current}\n\n**Allowed**\n${models.map((m) => `- \`${m}\``).join('\n') || '(none)'}`,
        }));
      }
      const models = await deps.info.allowedModels(await deps.ensureReady(project));
      if (!models.includes(name)) {
        return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Model not allowed', description: `\`${name}\` is not in the allowed list. Use \`/model\` to see it.` }));
      }
      convs.setOverrides(conv.id, { model: name, agent: conv.agent });
      const variant = String(cmd.options.variant || '').trim();
      return io.respondEmbed(fmt.statusEmbed({
        status: 'success', title: 'Model set',
        description: `This conversation now uses \`${name}\`${variant ? ` (variant: ${variant})` : ''}. \`/new\` resets it.`,
      }));
    }
    case 'agent': {
      const name = String(cmd.options.name || '').trim();
      const conv = ensureConversation(project, externalId);
      if (!name) {
        const agents = await deps.info.listAgents(await deps.ensureReady(project));
        return io.respondEmbed(fmt.statusEmbed({
          status: 'info', title: 'Agents',
          description: agents.map((a) => `- \`${a}\``).join('\n') || '(none found)',
        }));
      }
      convs.setOverrides(conv.id, { model: conv.model, agent: name });
      return io.respondEmbed(fmt.statusEmbed({ status: 'success', title: 'Agent set', description: `This conversation now uses agent \`${name}\`. \`/new\` resets it.` }));
    }
    case 'skills': {
      const ws = await deps.ensureReady(project);
      const skills = deps.info.listSkills(ws);
      const lines = skills.map((s) => `- **${s.name}** — ${s.description || '(no description)'}`).join('\n');
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'Workspace skills', description: lines || '(no skills found)' }));
    }
    case 'commands': {
      const ws = await deps.ensureReady(project);
      const cmds = deps.info.listCommands(ws);
      const lines = cmds.map((c) => `- **${c.name}** — ${c.description || '(no description)'}`).join('\n');
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'Workspace commands', description: lines || '(no custom commands found)' }));
    }
    case 'stats': {
      const active = convs.findActive(project.id, externalId);
      const conv = active ? runsModel.statsForConversation(active.id) : { runs: 0, tokens_input: 0, tokens_output: 0, cost_usd: 0 };
      const proj = runsModel.statsForProject(project.id);
      const fmtRow = (s) => `${s.runs} runs · in ${s.tokens_input} / out ${s.tokens_output} tokens · $${Number(s.cost_usd).toFixed(4)}`;
      return io.respondEmbed(fmt.statusEmbed({
        status: 'info', title: 'Usage stats',
        description: `**This conversation**: ${fmtRow(conv)}\n**Project total**: ${fmtRow(proj)}`,
        footer: project.slug,
      }));
    }
    case 'sync': {
      const { ok, results } = await deps.syncProject(project.id);
      const lines = results.map((r) => `- ${r.git_url}: ${r.status}${r.error ? ` - ${r.error}` : ''}`).join('\n');
      return io.respondEmbed(fmt.statusEmbed({
        status: ok ? 'success' : 'error',
        title: ok ? 'Sources updated to latest' : 'Source sync failed',
        description: lines || 'No repositories configured.',
        footer: project.slug,
      }));
    }
    case 'ask':
    case 'cmd': {
      const conv = ensureConversation(project, externalId);
      const prompt = String(cmd.name === 'ask' ? cmd.options.question : (cmd.options.args || '')).trim();
      const opts = { admin: Boolean(dmUser && dmUser.role === 'admin') };
      if (cmd.name === 'cmd') opts.command = String(cmd.options.name || '').trim();
      messages.add({ conversation_id: conv.id, direction: 'in', user_id: cmd.userId, user_name: cmd.userName, content: cmd.name === 'cmd' ? `/cmd ${opts.command} ${prompt}` : prompt });
      convs.touch(conv.id);
      try {
        const answer = await deps.investigate(project, convs.findById(conv.id), prompt, opts);
        messages.add({ conversation_id: conv.id, direction: 'out', content: answer });
        const { chunks, file } = fmt.renderAnswer(answer, { maxLength: project.max_msg_length });
        await io.respond(chunks[0]);
        for (const extra of chunks.slice(1)) await io.followUp(extra);
        if (file) await io.sendFile(file.name, file.content);
      } catch (err) {
        messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
        await io.respondEmbed(fmt.statusEmbed({ status: 'error', title: 'Investigation failed', description: err.message, footer: project.slug }));
      }
      return undefined;
    }
    default:
      return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Unknown command', description: `Command \`/${cmd.name}\` is not implemented.` }));
  }
}

async function autocompleteOptions(cmd) {
  const prefix = String(cmd.partial || '').toLowerCase();
  const toChoices = (values) => values
    .filter((v) => v.toLowerCase().startsWith(prefix))
    .slice(0, 25)
    .map((v) => ({ name: v, value: v }));

  if (cmd.focused === 'slug') {
    const user = dmUsers.findByDiscordId(cmd.userId);
    if (!user) return [];
    return toChoices(allowedProjectsFor(user, cmd.botId).map((p) => p.slug));
  }
  const ctx = resolveInteractionContext(cmd);
  if (ctx.refuse || !ctx.project) return [];
  const ws = await deps.ensureReady(ctx.project);
  if (cmd.focused === 'model') return toChoices(await deps.info.allowedModels(ws));
  if (cmd.focused === 'agent') return toChoices(await deps.info.listAgents(ws));
  return [];
}
```

Add `handleInteraction`, `autocompleteOptions`, `GUIDE_TEXT` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/discordRouterCommands.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/discordRouter.js tests/discordRouterCommands.test.js
git commit -m "feat: discord slash command handlers and autocomplete"
```

---

### Task 11: discord.js adapter, command definitions, bot manager service

**Files:**
- Modify: `package.json` (add dependency)
- Create: `lib/discordCommands.js`, `lib/discordClient.js`, `services/discord.service.js`
- Test: `tests/discordClient.test.js`

**Interfaces:**
- Consumes: `discordRouter.handleMessage/handleInteraction/autocompleteOptions` (Tasks 9–10); `discordBot.model` (Task 2); `discordFormat.EMOJI`.
- Produces:
  - `lib/discordCommands.js`: `COMMAND_DEFS` — array of raw application-command JSON (option type 3 = STRING).
  - `lib/discordClient.js`: `mapMessage(message, botUser, botId)` → router msg shape; `mapInteraction(interaction, botId)` → router cmd shape; `createBotClient({ botId, token, onMessage, onInteraction, onAutocomplete, onReady, onError })` → `{ start(), stop(), getClient() }`.
  - `services/discord.service.js`: `startAll()`, `startBot(row)`, `stopBot(id)`, `restartBot(id)`, `statusAll()` → `[{ id, name, enabled, status, botUserTag, inviteUrl, lastError }]` where status ∈ `'disabled' | 'connecting' | 'connected' | 'error'`.

- [ ] **Step 1: Install discord.js**

Run: `npm install discord.js@14`
Expected: `package.json` gains `"discord.js": "^14.x"`, lockfile updated. (Also remove the duplicated `devDependencies` block in `package.json` — keep one copy; JSON with duplicate keys silently drops the first.)

- [ ] **Step 2: Write the failing tests** — create `tests/discordClient.test.js` (pure mapping only; no gateway connection):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { COMMAND_DEFS } = require('../lib/discordCommands');
const { mapMessage, mapInteraction } = require('../lib/discordClient');

test('COMMAND_DEFS contains all 14 commands with autocomplete where needed', () => {
  const names = COMMAND_DEFS.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['agent', 'ask', 'cmd', 'commands', 'guide', 'model', 'new',
    'project', 'projects', 'skills', 'stats', 'status', 'stop', 'sync']);
  const model = COMMAND_DEFS.find((c) => c.name === 'model');
  assert.strictEqual(model.options[0].autocomplete, true);
  const project = COMMAND_DEFS.find((c) => c.name === 'project');
  assert.strictEqual(project.options[0].required, true);
  const ask = COMMAND_DEFS.find((c) => c.name === 'ask');
  assert.strictEqual(ask.options[0].required, true);
});

test('mapMessage strips the bot mention and detects DM vs guild', () => {
  const botUser = { id: '999' };
  const message = {
    id: 'm1',
    content: '<@999> why is checkout down?',
    channelId: '111',
    guildId: 'g1',
    author: { id: 'u1', username: 'alice', bot: false },
    mentions: { users: new Map([['999', botUser]]) },
    attachments: new Map([['a1', { name: 'x.png', url: 'https://cdn/x.png', size: 5, contentType: 'image/png' }]]),
  };
  const msg = mapMessage(message, botUser, 7);
  assert.strictEqual(msg.botId, 7);
  assert.strictEqual(msg.isDM, false);
  assert.strictEqual(msg.mentionsBot, true);
  assert.strictEqual(msg.content, 'why is checkout down?');
  assert.deepStrictEqual(msg.attachments, [{ name: 'x.png', url: 'https://cdn/x.png', size: 5, contentType: 'image/png' }]);
  const dm = mapMessage({ ...message, guildId: null, content: 'hello', mentions: { users: new Map() } }, botUser, 7);
  assert.strictEqual(dm.isDM, true);
  assert.strictEqual(dm.mentionsBot, false);
});

test('mapInteraction extracts name, options, and DM flag', () => {
  const interaction = {
    commandName: 'model',
    channelId: '111',
    guildId: null,
    user: { id: 'u1', username: 'alice' },
    options: { data: [{ name: 'name', value: 'a/m1' }, { name: 'variant', value: 'high' }] },
  };
  const cmd = mapInteraction(interaction, 7);
  assert.deepStrictEqual(cmd, {
    name: 'model', options: { name: 'a/m1', variant: 'high' },
    botId: 7, channelId: '111', isDM: true, userId: 'u1', userName: 'alice',
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/discordClient.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `lib/discordCommands.js`**

```js
// Raw application-command payloads registered per bot on connect.
// Option type 3 = STRING (Discord API constant).
const STR = 3;

const COMMAND_DEFS = [
  { name: 'ask', description: 'Ask the investigator a question',
    options: [{ type: STR, name: 'question', description: 'Your question', required: true }] },
  { name: 'new', description: 'Start a new conversation and OpenCode session' },
  { name: 'stop', description: 'Cancel the running investigation' },
  { name: 'status', description: 'Show project, session, model, and run state' },
  { name: 'model', description: 'Show or set the model for this conversation',
    options: [
      { type: STR, name: 'name', description: 'provider/model', autocomplete: true },
      { type: STR, name: 'variant', description: 'Reasoning effort (e.g. high, max, minimal)' },
    ] },
  { name: 'agent', description: 'Show or set the agent for this conversation',
    options: [{ type: STR, name: 'name', description: 'Agent name', autocomplete: true }] },
  { name: 'skills', description: 'List skills available in this project workspace' },
  { name: 'commands', description: 'List custom workspace commands' },
  { name: 'cmd', description: 'Run a custom workspace command',
    options: [
      { type: STR, name: 'name', description: 'Command name', required: true },
      { type: STR, name: 'args', description: 'Arguments' },
    ] },
  { name: 'stats', description: 'Token and cost statistics' },
  { name: 'sync', description: 'Re-pull project sources to the latest remote state' },
  { name: 'guide', description: 'How to use this bot' },
  { name: 'projects', description: 'List projects you can access (DM only)' },
  { name: 'project', description: 'Select the project for this DM (DM only)',
    options: [{ type: STR, name: 'slug', description: 'Project slug', required: true, autocomplete: true }] },
];

module.exports = { COMMAND_DEFS };
```

- [ ] **Step 5: Implement `lib/discordClient.js`**

```js
// Thin adapter over discord.js: maps gateway objects to the plain shapes the
// router understands and implements the io side effects (reply, react,
// typing). Everything above this file is testable without a network.
const { COMMAND_DEFS } = require('./discordCommands');

const TYPING_REFRESH_MS = () => Number(process.env.DISCORD_TYPING_REFRESH_MS || 8000);

function mapMessage(message, botUser, botId) {
  const mentionsBot = Boolean(message.mentions && message.mentions.users && message.mentions.users.has(botUser.id));
  const content = String(message.content || '')
    .replace(new RegExp(`<@!?${botUser.id}>`, 'g'), '')
    .trim();
  return {
    botId,
    channelId: message.channelId,
    isDM: !message.guildId,
    authorId: message.author.id,
    authorName: message.author.username,
    authorIsBot: Boolean(message.author.bot),
    mentionsBot,
    content,
    attachments: [...(message.attachments ? message.attachments.values() : [])].map((a) => ({
      name: a.name, url: a.url, size: a.size, contentType: a.contentType,
    })),
    messageId: message.id,
  };
}

function mapInteraction(interaction, botId) {
  const options = {};
  for (const o of (interaction.options && interaction.options.data) || []) options[o.name] = o.value;
  return {
    name: interaction.commandName,
    options,
    botId,
    channelId: interaction.channelId,
    isDM: !interaction.guildId,
    userId: interaction.user.id,
    userName: interaction.user.username,
  };
}

function messageIo(message) {
  let typingTimer = null;
  let lastReaction = null;
  return {
    reply: (text) => message.reply({ content: text, allowedMentions: { repliedUser: false } }),
    replyEmbed: (embed) => message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }),
    sendFile: (name, content) => message.channel.send({ files: [{ attachment: Buffer.from(content, 'utf8'), name }] }),
    react: async (emoji) => { lastReaction = await message.react(emoji); },
    setReaction: async (emoji) => {
      try { if (lastReaction) await lastReaction.remove(); } catch { /* missing perms — leave it */ }
      lastReaction = await message.react(emoji);
    },
    startTyping: async () => {
      await message.channel.sendTyping().catch(() => {});
      typingTimer = setInterval(() => message.channel.sendTyping().catch(() => {}), TYPING_REFRESH_MS());
    },
    stopTyping: async () => { if (typingTimer) clearInterval(typingTimer); typingTimer = null; },
  };
}

function interactionIo(interaction) {
  return {
    respond: (text) => interaction.editReply({ content: text }).catch(() => interaction.channel.send({ content: text })),
    respondEmbed: (embed) => interaction.editReply({ embeds: [embed] }).catch(() => interaction.channel.send({ embeds: [embed] })),
    followUp: (text) => interaction.followUp({ content: text }).catch(() => interaction.channel.send({ content: text })),
    sendFile: (name, content) => interaction.followUp({ files: [{ attachment: Buffer.from(content, 'utf8'), name }] })
      .catch(() => interaction.channel.send({ files: [{ attachment: Buffer.from(content, 'utf8'), name }] })),
  };
}

function createBotClient({ botId, token, onMessage, onInteraction, onAutocomplete, onReady, onError }) {
  // Lazy-require so unit tests never load the gateway stack.
  const { Client, GatewayIntentBits, Partials } = require('discord.js');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel], // required to receive DMs
  });

  // discord.js v14 emits 'ready'; newer versions rename it to 'clientReady'.
  // Listen to both but fire the handler exactly once.
  let readyFired = false;
  const onGatewayReady = async () => {
    if (readyFired) return;
    readyFired = true;
    try { await client.application.commands.set(COMMAND_DEFS); } catch (err) { onError(err); }
    onReady({ botUserTag: client.user.tag, applicationId: client.application.id });
  };
  client.on('ready', onGatewayReady);
  client.on('clientReady', onGatewayReady);

  client.on('messageCreate', async (message) => {
    try {
      if (message.partial) await message.fetch();
      await onMessage(mapMessage(message, client.user, botId), messageIo(message));
    } catch (err) { onError(err); }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isAutocomplete && interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused(true);
        const choices = await onAutocomplete({
          ...mapInteraction(interaction, botId), focused: focused.name, partial: focused.value,
        });
        return interaction.respond(choices);
      }
      if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
        await interaction.deferReply();
        return onInteraction(mapInteraction(interaction, botId), interactionIo(interaction));
      }
    } catch (err) { onError(err); }
    return undefined;
  });

  client.on('error', onError);

  return {
    start: () => client.login(token),
    stop: () => client.destroy(),
    getClient: () => client,
  };
}

module.exports = { mapMessage, mapInteraction, messageIo, interactionIo, createBotClient };
```

- [ ] **Step 6: Implement `services/discord.service.js`**

```js
// Manages one gateway client per enabled bot. Started from server.js; the
// admin controller calls restartBot/stopBot after saves so token rotation
// needs no server restart.
const botsModel = require('../models/discordBot.model');
const router = require('./discordRouter');
const { createBotClient } = require('../lib/discordClient');

const registry = new Map(); // botId -> { handle, status, botUserTag, applicationId, lastError }

function startBot(row) {
  stopBot(row.id);
  const entry = { handle: null, status: 'connecting', botUserTag: null, applicationId: null, lastError: null };
  registry.set(row.id, entry);
  try {
    entry.handle = createBotClient({
      botId: row.id,
      token: row.token,
      onMessage: (msg, io) => router.handleMessage(msg, io),
      onInteraction: (cmd, io) => router.handleInteraction(cmd, io),
      onAutocomplete: (cmd) => router.autocompleteOptions(cmd),
      onReady: ({ botUserTag, applicationId }) => {
        entry.status = 'connected';
        entry.botUserTag = botUserTag;
        entry.applicationId = applicationId;
        entry.lastError = null;
        botsModel.update(row.id, { last_error: null });
        console.log(`[discord] bot ${row.name} connected as ${botUserTag}`);
      },
      onError: (err) => {
        entry.lastError = err.message;
        botsModel.update(row.id, { last_error: err.message.slice(0, 500) });
        console.error(`[discord] bot ${row.name}:`, err.message);
      },
    });
    entry.handle.start().catch((err) => {
      entry.status = 'error';
      entry.lastError = err.message;
      botsModel.update(row.id, { last_error: err.message.slice(0, 500) });
      console.error(`[discord] bot ${row.name} login failed:`, err.message);
    });
  } catch (err) {
    entry.status = 'error';
    entry.lastError = err.message;
  }
}

function stopBot(id) {
  const entry = registry.get(id);
  if (entry && entry.handle) { try { entry.handle.stop(); } catch { /* already down */ } }
  registry.delete(id);
}

function restartBot(id) {
  const row = botsModel.findById(id);
  if (row && row.enabled) startBot(row);
  else stopBot(id);
}

function startAll() {
  for (const row of botsModel.listEnabled()) startBot(row);
}

function statusAll() {
  return botsModel.list().map((row) => {
    const entry = registry.get(row.id);
    return {
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      status: !row.enabled ? 'disabled' : (entry ? entry.status : 'error'),
      botUserTag: entry ? entry.botUserTag : null,
      inviteUrl: entry && entry.applicationId
        ? `https://discord.com/oauth2/authorize?client_id=${entry.applicationId}&scope=bot`
        : null,
      lastError: (entry && entry.lastError) || row.last_error || null,
    };
  });
}

module.exports = { startAll, startBot, stopBot, restartBot, statusAll };
```

- [ ] **Step 7: Run tests**

Run: `node --test tests/discordClient.test.js && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json lib/discordCommands.js lib/discordClient.js services/discord.service.js tests/discordClient.test.js
git commit -m "feat: discord.js gateway adapter, command registration, bot manager"
```

---

### Task 12: Admin UI — global Discord page (bots, DM allowlist, models)

**Files:**
- Create: `controllers/discordAdmin.controller.js`, `views/discord/index.ejs`
- Modify: `routes/admin.routes.js`, `views/layout-head.ejs` (nav link after the Projects link, around line 57)
- Test: `tests/discordAdmin.test.js`

**Interfaces:**
- Consumes: `discordBot.model`, `discordUser.model`, `setting.model` (Task 2); `discord.service.statusAll/restartBot/stopBot` (Task 11); `loginAgent` helper from `tests/helpers/auth.js`.
- Produces: routes `GET /admin/discord`, `POST /admin/discord/bots`, `POST /admin/discord/bots/:id`, `POST /admin/discord/bots/:id/delete`, `POST /admin/discord/users`, `POST /admin/discord/users/:id`, `POST /admin/discord/users/:id/delete`, `POST /admin/discord/models`.

- [ ] **Step 1: Write the failing tests** — create `tests/discordAdmin.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { loginAgent } = require('./helpers/auth');
const { adminApp } = require('../server');
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const bots = require('../models/discordBot.model');
const dmUsers = require('../models/discordUser.model');
const settings = require('../models/setting.model');

let agent;
beforeEach(async () => { resetDbForTest(); agent = await loginAgent(adminApp); });

test('discord page lists bots with redacted tokens', async () => {
  bots.create({ name: 'Main', token: 'super-secret-token' });
  const page = await agent.get('/admin/discord').expect(200);
  assert.match(page.text, /Main/);
  assert.ok(!page.text.includes('super-secret-token'), 'token must never render');
});

test('create bot requires name and token; update keeps token when blank', async () => {
  await agent.post('/admin/discord/bots').type('form').send({ name: '', token: '' }).expect(400);
  await agent.post('/admin/discord/bots').type('form').send({ name: 'Main', token: 'tok-1' }).expect(302);
  const b = bots.list()[0];
  assert.strictEqual(b.token, 'tok-1');
  await agent.post(`/admin/discord/bots/${b.id}`).type('form')
    .send({ name: 'Renamed', token: '', enabled: '1' }).expect(302);
  const updated = bots.findById(b.id);
  assert.strictEqual(updated.name, 'Renamed');
  assert.strictEqual(updated.token, 'tok-1'); // blank keeps stored token
  await agent.post(`/admin/discord/bots/${b.id}/delete`).expect(302);
  assert.strictEqual(bots.list().length, 0);
});

test('dm user CRUD with role and project entitlements', async () => {
  const p = projects.create({ slug: 'pay', name: 'Pay', keyword: '', system_prompt: '', teams_webhook_url: '' });
  await agent.post('/admin/discord/users').type('form')
    .send({ discord_user_id: '42', label: 'Alice', role: 'member', project_ids: [String(p.id)] }).expect(302);
  const u = dmUsers.findByDiscordId('42');
  assert.deepStrictEqual(dmUsers.listProjectIds(u.id), [p.id]);
  await agent.post(`/admin/discord/users/${u.id}`).type('form')
    .send({ label: 'Alice A', role: 'admin', all_projects: '1' }).expect(302);
  assert.strictEqual(dmUsers.findById(u.id).role, 'admin');
  await agent.post('/admin/discord/users').type('form')
    .send({ discord_user_id: 'not-digits', label: 'x', role: 'member' }).expect(400);
  await agent.post(`/admin/discord/users/${u.id}/delete`).expect(302);
  assert.strictEqual(dmUsers.list().length, 0);
});

test('models settings save allowlist and default', async () => {
  await agent.post('/admin/discord/models').type('form')
    .send({ allowed_models: 'a/m1\nb/m2', default_model: 'a/m1' }).expect(302);
  assert.strictEqual(settings.get('discord_allowed_models'), 'a/m1\nb/m2');
  assert.strictEqual(settings.get('discord_default_model'), 'a/m1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/discordAdmin.test.js`
Expected: FAIL — 404 on `/admin/discord`.

- [ ] **Step 3: Implement `controllers/discordAdmin.controller.js`**

```js
const bots = require('../models/discordBot.model');
const dmUsers = require('../models/discordUser.model');
const settings = require('../models/setting.model');
const projects = require('../models/project.model');
const discord = require('../services/discord.service');

const DIGITS_RE = /^\d{5,25}$/;

function renderPage(res, status, { errors = [] } = {}) {
  const statusById = new Map(discord.statusAll().map((s) => [s.id, s]));
  res.status(status).render('discord/index', {
    bots: bots.list().map((b) => ({ ...b, token: undefined, live: statusById.get(b.id) })),
    users: dmUsers.list().map((u) => ({ ...u, project_ids: dmUsers.listProjectIds(u.id) })),
    projects: projects.list(),
    allowedModels: settings.get('discord_allowed_models') || '',
    defaultModel: settings.get('discord_default_model') || '',
    errors,
  });
}

function page(req, res) { renderPage(res, 200); }

function createBot(req, res) {
  const name = String(req.body.name || '').trim();
  const token = String(req.body.token || '').trim();
  const errors = [];
  if (!name) errors.push('Bot name is required.');
  if (!token) errors.push('Bot token is required.');
  if (errors.length) return renderPage(res, 400, { errors });
  const b = bots.create({ name, token, enabled: 1 });
  discord.restartBot(b.id);
  return res.redirect('/admin/discord');
}

function updateBot(req, res) {
  const b = bots.findById(req.params.id);
  if (!b) return res.status(404).send('Bot not found');
  const name = String(req.body.name || '').trim();
  if (!name) return renderPage(res, 400, { errors: ['Bot name is required.'] });
  const fields = { name, enabled: req.body.enabled ? 1 : 0 };
  const token = String(req.body.token || '').trim();
  if (token) fields.token = token; // blank keeps the stored token
  bots.update(b.id, fields);
  discord.restartBot(b.id);
  return res.redirect('/admin/discord');
}

function deleteBot(req, res) {
  discord.stopBot(Number(req.params.id));
  bots.remove(req.params.id);
  res.redirect('/admin/discord');
}

function parseUserInput(body) {
  const errors = [];
  const label = String(body.label || '').trim();
  const role = body.role === 'admin' ? 'admin' : 'member';
  const all_projects = body.all_projects ? 1 : 0;
  const project_ids = [].concat(body.project_ids || []).map(Number).filter(Number.isInteger);
  return { errors, values: { label, role, all_projects, project_ids } };
}

function createUser(req, res) {
  const discord_user_id = String(req.body.discord_user_id || '').trim();
  const { errors, values } = parseUserInput(req.body);
  if (!DIGITS_RE.test(discord_user_id)) errors.push('Discord user id must be the numeric snowflake id.');
  if (dmUsers.findByDiscordId(discord_user_id)) errors.push('This Discord user is already allowlisted.');
  if (errors.length) return renderPage(res, 400, { errors });
  const u = dmUsers.create({ discord_user_id, label: values.label, role: values.role, all_projects: values.all_projects });
  dmUsers.setProjects(u.id, values.project_ids);
  return res.redirect('/admin/discord');
}

function updateUser(req, res) {
  const u = dmUsers.findById(req.params.id);
  if (!u) return res.status(404).send('User not found');
  const { errors, values } = parseUserInput(req.body);
  if (errors.length) return renderPage(res, 400, { errors });
  dmUsers.update(u.id, { label: values.label, role: values.role, all_projects: values.all_projects });
  dmUsers.setProjects(u.id, values.project_ids);
  return res.redirect('/admin/discord');
}

function deleteUser(req, res) {
  dmUsers.remove(req.params.id);
  res.redirect('/admin/discord');
}

function saveModels(req, res) {
  settings.set('discord_allowed_models', String(req.body.allowed_models || '').trim());
  settings.set('discord_default_model', String(req.body.default_model || '').trim());
  res.redirect('/admin/discord');
}

module.exports = { page, createBot, updateBot, deleteBot, createUser, updateUser, deleteUser, saveModels };
```

- [ ] **Step 4: Add routes** — in `routes/admin.routes.js` before `module.exports`:

```js
const discordAdmin = require('../controllers/discordAdmin.controller');
router.get('/discord', discordAdmin.page);
router.post('/discord/bots', discordAdmin.createBot);
router.post('/discord/bots/:id', discordAdmin.updateBot);
router.post('/discord/bots/:id/delete', discordAdmin.deleteBot);
router.post('/discord/users', discordAdmin.createUser);
router.post('/discord/users/:id', discordAdmin.updateUser);
router.post('/discord/users/:id/delete', discordAdmin.deleteUser);
router.post('/discord/models', discordAdmin.saveModels);
```

- [ ] **Step 5: Create `views/discord/index.ejs`** (follows the `views/projects/list.ejs` panel/table idiom):

```ejs
<%- include('../layout-head') %>

<section style="margin-bottom:1.5rem">
  <p class="page-kicker">Global integration</p>
  <h1 class="page-title">Discord</h1>
  <p class="page-subtitle">Bots, DM allowlist, and model policy. Bind bots to projects from each project's edit page.</p>
</section>

<% if (errors && errors.length) { %>
  <section class="error" style="margin-bottom:1.25rem" role="alert">
    <ul class="error-list"><% for (const e of errors) { %><li><%= e %></li><% } %></ul>
  </section>
<% } %>

<!-- Bots -->
<section class="panel" style="margin-bottom:1.25rem">
  <div class="panel-body">
    <h2 class="section-heading">Bots</h2>
    <div class="table-scroll" style="margin-top:0.75rem">
      <table class="data-table">
        <thead><tr><th>Name</th><th>Status</th><th>Invite</th><th>Enabled</th><th>Token</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>
          <% for (const b of bots) { %>
          <tr>
            <form method="post" action="/admin/discord/bots/<%= b.id %>">
              <td><input class="input" name="name" value="<%= b.name %>" required></td>
              <td>
                <span class="status-badge <%= b.live && b.live.status === 'connected' ? 'status-active' : (b.live && b.live.status === 'error' ? 'status-error' : 'status-muted') %>">
                  <%= b.live ? b.live.status : 'unknown' %>
                </span>
                <% if (b.live && b.live.botUserTag) { %><div style="font-size:0.6875rem;color:var(--color-ink-500)"><%= b.live.botUserTag %></div><% } %>
                <% if (b.live && b.live.lastError) { %><div style="font-size:0.6875rem;color:var(--color-danger)"><%= b.live.lastError %></div><% } %>
              </td>
              <td><% if (b.live && b.live.inviteUrl) { %><a href="<%= b.live.inviteUrl %>" target="_blank" rel="noopener">Invite link</a><% } else { %><span style="color:var(--color-ink-300)">—</span><% } %></td>
              <td><input type="checkbox" name="enabled" value="1" <%= b.enabled ? 'checked' : '' %>></td>
              <td><input class="input" name="token" type="password" placeholder="•••••• (blank keeps current)" autocomplete="new-password"></td>
              <td style="text-align:right">
                <button class="btn btn-primary" type="submit">Save</button>
            </form>
                <form class="inline-form" method="post" action="/admin/discord/bots/<%= b.id %>/delete"
                      onsubmit="return confirm('Delete bot <%= b.name %>?')">
                  <button class="btn btn-danger" type="submit">Delete</button>
                </form>
              </td>
          </tr>
          <% } %>
          <tr>
            <form method="post" action="/admin/discord/bots">
              <td><input class="input" name="name" placeholder="New bot name" required></td>
              <td colspan="2" style="color:var(--color-ink-500);font-size:0.8125rem">Create the application at discord.com/developers, enable the Message Content intent, paste the bot token here.</td>
              <td></td>
              <td><input class="input" name="token" type="password" placeholder="Bot token" required autocomplete="new-password"></td>
              <td style="text-align:right"><button class="btn btn-primary" type="submit">Add bot</button></td>
            </form>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<!-- DM allowlist -->
<section class="panel" style="margin-bottom:1.25rem">
  <div class="panel-body">
    <h2 class="section-heading">DM allowlist</h2>
    <p style="font-size:0.8125rem;color:var(--color-ink-500);margin-top:0.25rem">Users allowed to chat with a bot in private DMs. Admins get every project and full agent tools (edit/bash/webfetch) — still sandboxed to the project OS user.</p>
    <div class="table-scroll" style="margin-top:0.75rem">
      <table class="data-table">
        <thead><tr><th>Discord user id</th><th>Label</th><th>Role</th><th>Projects</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>
          <% for (const u of users) { %>
          <tr>
            <form method="post" action="/admin/discord/users/<%= u.id %>">
              <td><code><%= u.discord_user_id %></code></td>
              <td><input class="input" name="label" value="<%= u.label %>"></td>
              <td>
                <select class="input" name="role">
                  <option value="member" <%= u.role === 'member' ? 'selected' : '' %>>member</option>
                  <option value="admin" <%= u.role === 'admin' ? 'selected' : '' %>>admin (full tools)</option>
                </select>
              </td>
              <td>
                <label style="display:block;font-size:0.8125rem"><input type="checkbox" name="all_projects" value="1" <%= u.all_projects ? 'checked' : '' %>> all projects</label>
                <% for (const p of projects) { %>
                  <label style="display:block;font-size:0.8125rem">
                    <input type="checkbox" name="project_ids" value="<%= p.id %>" <%= u.project_ids.includes(p.id) ? 'checked' : '' %>> <%= p.slug %>
                  </label>
                <% } %>
              </td>
              <td style="text-align:right">
                <button class="btn btn-primary" type="submit">Save</button>
            </form>
                <form class="inline-form" method="post" action="/admin/discord/users/<%= u.id %>/delete"
                      onsubmit="return confirm('Remove this user from the allowlist?')">
                  <button class="btn btn-danger" type="submit">Delete</button>
                </form>
              </td>
          </tr>
          <% } %>
          <tr>
            <form method="post" action="/admin/discord/users">
              <td><input class="input" name="discord_user_id" placeholder="e.g. 236224983549280257" required></td>
              <td><input class="input" name="label" placeholder="Who is this?"></td>
              <td>
                <select class="input" name="role">
                  <option value="member">member</option>
                  <option value="admin">admin (full tools)</option>
                </select>
              </td>
              <td>
                <label style="display:block;font-size:0.8125rem"><input type="checkbox" name="all_projects" value="1"> all projects</label>
                <% for (const p of projects) { %>
                  <label style="display:block;font-size:0.8125rem"><input type="checkbox" name="project_ids" value="<%= p.id %>"> <%= p.slug %></label>
                <% } %>
              </td>
              <td style="text-align:right"><button class="btn btn-primary" type="submit">Add user</button></td>
            </form>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<!-- Model policy -->
<section class="panel">
  <div class="panel-body">
    <h2 class="section-heading">Models</h2>
    <form method="post" action="/admin/discord/models" style="margin-top:0.75rem;display:grid;gap:0.75rem;max-width:32rem">
      <label style="font-size:0.8125rem;font-weight:600">Allowed models (one provider/model per line; empty = all available)
        <textarea class="input" name="allowed_models" rows="4" style="width:100%;font-family:var(--font-mono)"><%= allowedModels %></textarea>
      </label>
      <label style="font-size:0.8125rem;font-weight:600">Default model shown in /status (optional)
        <input class="input" name="default_model" value="<%= defaultModel %>" placeholder="anthropic/claude-sonnet-5">
      </label>
      <div><button class="btn btn-primary" type="submit">Save models</button></div>
    </form>
  </div>
</section>

<%- include('../layout-foot') %>
```

- [ ] **Step 6: Add the nav link** — in `views/layout-head.ejs`, directly after the Projects `</a>` (around line 57):

```html
        <!-- Discord -->
        <a class="nav-link" id="nav-discord" href="/admin/discord">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.79 19.79 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z"/></svg>
          Discord
        </a>
```

- [ ] **Step 7: Run tests**

Run: `node --test tests/discordAdmin.test.js && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add controllers/discordAdmin.controller.js views/discord/index.ejs routes/admin.routes.js views/layout-head.ejs tests/discordAdmin.test.js
git commit -m "feat: admin discord page for bots, DM allowlist, and model policy"
```

---

### Task 13: Project form — bot binding and designated channels

**Files:**
- Modify: `services/adminValidation.js` (new exported function), `controllers/project.controller.js`, `models/project.model.js` (allow `discord_bot_id`), `views/projects/form.ejs`
- Test: `tests/adminValidation.test.js` (append), `tests/discordAdmin.test.js` (append one integration test)

**Interfaces:**
- Consumes: `discordChannel.model.replaceForProject/listByProject/findByChannelId`, `discordBot.model.list` (Task 2).
- Produces: `validateDiscordSection(body)` → `{ values: { discord_bot_id: number|null, channels: [{ channel_id, mode }] }, errors: string[] }`. Form fields: `discord_bot_id` (select, `''` = none), parallel arrays `discord_channel_id[]` and `discord_channel_mode[]`.

- [ ] **Step 1: Write the failing tests** — append to `tests/adminValidation.test.js` (match its local import name for the service):

```js
test('validateDiscordSection parses bot id and channel rows', () => {
  const { validateDiscordSection } = require('../services/adminValidation');
  const r = validateDiscordSection({
    discord_bot_id: '3',
    discord_channel_id: ['123456789', ' 987654321 ', ''],
    discord_channel_mode: ['all', 'mention', 'mention'],
  });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.values.discord_bot_id, 3);
  assert.deepStrictEqual(r.values.channels, [
    { channel_id: '123456789', mode: 'all' },
    { channel_id: '987654321', mode: 'mention' },
  ]);
});

test('validateDiscordSection rejects non-numeric channel ids and requires a bot when channels exist', () => {
  const { validateDiscordSection } = require('../services/adminValidation');
  const r1 = validateDiscordSection({ discord_bot_id: '', discord_channel_id: ['abc'], discord_channel_mode: ['all'] });
  assert.ok(r1.errors.some((e) => /numeric/i.test(e)));
  assert.ok(r1.errors.some((e) => /select a bot/i.test(e)));
  const r2 = validateDiscordSection({});
  assert.deepStrictEqual(r2, { values: { discord_bot_id: null, channels: [] }, errors: [] });
});
```

Append to `tests/discordAdmin.test.js`:

```js
test('project save binds a bot and reconciles designated channels', async () => {
  const b = bots.create({ name: 'Main', token: 't' });
  const p = projects.create({ slug: 'pay2', name: 'Pay2', keyword: '', system_prompt: '', teams_webhook_url: '' });
  const channels = require('../models/discordChannel.model');
  await agent.post(`/admin/projects/${p.id}`).type('form').send({
    slug: 'pay2', name: 'Pay2', keyword: '', system_prompt: '', teams_webhook_url: '',
    max_msg_length: '20000', chat_retention_days: '90',
    discord_bot_id: String(b.id),
    discord_channel_id: ['111222333'], discord_channel_mode: ['all'],
  }).expect(302);
  assert.strictEqual(projects.findById(p.id).discord_bot_id, b.id);
  assert.strictEqual(channels.findByChannelId('111222333').project_id, p.id);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/adminValidation.test.js tests/discordAdmin.test.js`
Expected: FAIL — `validateDiscordSection` not exported / project save ignores discord fields.

- [ ] **Step 3: Implement `validateDiscordSection` in `services/adminValidation.js`** (and export it):

```js
const CHANNEL_ID_RE = /^\d{5,25}$/;

// Discord section of the project form: a bot select plus parallel arrays of
// channel id / mode rows. Empty channel_id rows are skipped (deleted rows).
function validateDiscordSection(body) {
  const errors = [];
  const rawBot = clean(body.discord_bot_id);
  const discord_bot_id = rawBot ? Number(rawBot) : null;
  if (rawBot && !Number.isInteger(discord_bot_id)) errors.push('Discord bot selection is invalid.');

  const ids = [].concat(body.discord_channel_id || []);
  const modes = [].concat(body.discord_channel_mode || []);
  const channels = [];
  ids.forEach((raw, i) => {
    const channel_id = clean(raw);
    if (!channel_id) return;
    if (!CHANNEL_ID_RE.test(channel_id)) {
      errors.push(`Channel id "${channel_id}" must be the numeric channel snowflake.`);
      return;
    }
    channels.push({ channel_id, mode: clean(modes[i]) === 'all' ? 'all' : 'mention' });
  });
  if (channels.length && !discord_bot_id) errors.push('Select a bot before adding Discord channels.');
  return { values: { discord_bot_id, channels }, errors };
}
```

- [ ] **Step 4: Wire into `controllers/project.controller.js`**

- Import: `const discordChannels = require('../models/discordChannel.model');`, `const discordBots = require('../models/discordBot.model');`, and add `validateDiscordSection` to the existing adminValidation import.
- In `renderProjectForm`, add to the render locals: `discordBots: discordBots.list().map((b) => ({ id: b.id, name: b.name }))` and accept/forward a `discordChannels` array (default `[]`).
- In `editProjectForm`, pass `discordChannels: discordChannels.listByProject(p.id)`.
- In both `createProject` and `updateProject`:

In `updateProject` (where `p` exists):

```js
  const discord = validateDiscordSection(req.body);
  errors.push(...discord.errors);
  for (const row of discord.values.channels) {
    const existing = discordChannels.findByChannelId(row.channel_id);
    if (existing && Number(existing.project_id) !== Number(p.id)) {
      errors.push(`Discord channel ${row.channel_id} is already bound to another project.`);
    }
  }
```

In `createProject` (no `p` variable exists yet — any existing binding is a conflict):

```js
  const discord = validateDiscordSection(req.body);
  errors.push(...discord.errors);
  for (const row of discord.values.channels) {
    if (discordChannels.findByChannelId(row.channel_id)) {
      errors.push(`Discord channel ${row.channel_id} is already bound to another project.`);
    }
  }
```

Inside the existing save transactions add:

```js
    projects.update(created.id, { discord_bot_id: discord.values.discord_bot_id }); // createProject
    discordChannels.replaceForProject(created.id, discord.values.channels);
```

and in `updateProject`'s transaction:

```js
    projects.update(p.id, { ...values.project, discord_bot_id: discord.values.discord_bot_id });
    discordChannels.replaceForProject(p.id, discord.values.channels);
```

(replace the existing `projects.update(p.id, values.project)` line). On validation-error re-render, forward `discordChannels: discord.values.channels`.

- [ ] **Step 5: Allow the column in `models/project.model.js`** — add `'discord_bot_id'` to the `allowed` array in `update`.

- [ ] **Step 6: Add the form section** — in `views/projects/form.ejs`, before the closing `</form>` of the main form, add:

```ejs
  <!-- Discord -->
  <section class="panel" style="margin-bottom:1.25rem">
    <div class="panel-body">
      <h2 class="section-heading">Discord</h2>
      <p style="font-size:0.8125rem;color:var(--color-ink-500);margin-top:0.25rem">
        Bind a bot (managed on the <a href="/admin/discord">Discord page</a>) and designate the channels it may answer in.
        Mode <strong>mention</strong> answers only @bot messages; <strong>all</strong> answers every message in the channel.
      </p>
      <div style="margin-top:0.75rem;max-width:20rem">
        <label style="font-size:0.8125rem;font-weight:600">Bot
          <select class="input" name="discord_bot_id">
            <option value="">(none — Discord disabled)</option>
            <% for (const b of discordBots) { %>
              <option value="<%= b.id %>" <%= project && Number(project.discord_bot_id) === b.id ? 'selected' : '' %>><%= b.name %></option>
            <% } %>
          </select>
        </label>
      </div>
      <div id="discord-channel-rows" style="margin-top:0.75rem;display:grid;gap:0.5rem">
        <% for (const ch of (discordChannels || [])) { %>
          <div style="display:flex;gap:0.5rem">
            <input class="input" name="discord_channel_id" value="<%= ch.channel_id %>" placeholder="Channel id (numeric)">
            <select class="input" name="discord_channel_mode" style="max-width:10rem">
              <option value="mention" <%= ch.mode === 'mention' ? 'selected' : '' %>>mention</option>
              <option value="all" <%= ch.mode === 'all' ? 'selected' : '' %>>all</option>
            </select>
          </div>
        <% } %>
      </div>
      <button type="button" class="btn btn-secondary" style="margin-top:0.75rem"
              onclick="const d=document.createElement('div');d.style.cssText='display:flex;gap:0.5rem';d.innerHTML=document.getElementById('discord-row-template').innerHTML;document.getElementById('discord-channel-rows').appendChild(d)">
        Add channel
      </button>
      <template id="discord-row-template">
        <input class="input" name="discord_channel_id" value="" placeholder="Channel id (numeric)">
        <select class="input" name="discord_channel_mode" style="max-width:10rem">
          <option value="mention">mention</option>
          <option value="all">all</option>
        </select>
      </template>
    </div>
  </section>
```

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS — including the existing `adminUi.test.js` form tests (the new section must not break form parsing; `discordBots`/`discordChannels` locals must be provided by every `renderProjectForm` call).

- [ ] **Step 8: Commit**

```bash
git add services/adminValidation.js controllers/project.controller.js models/project.model.js views/projects/form.ejs tests/adminValidation.test.js tests/discordAdmin.test.js
git commit -m "feat: bind discord bot and designated channels on the project form"
```

---

### Task 14: Retention — delete per-conversation upload dirs

**Files:**
- Modify: `models/conversation.model.js` (add `listOlderThan`), `services/retention.service.js`
- Test: `tests/retention.test.js` (append)

**Interfaces:**
- Consumes: `workspace.workspacePathFor(project)`; `discordAttachment.uploadDirFor(ws, conversationId)` (Task 8).
- Produces: `convs.listOlderThan(project_id, cutoff)` → rows; `runRetentionCleanup` removes `<ws>/.otb-uploads/<conversation_id>` for every conversation it deletes.

- [ ] **Step 1: Write the failing test** — append to `tests/retention.test.js` (reuse its existing seeding helpers/imports; add `fs`, `os`, `path`, `workspace` requires if missing):

```js
test('retention removes discord upload dirs of deleted conversations', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-ret-'));
  process.env.OTB_WORKSPACES_DIR = tmpWs;
  const p = projects.create({ slug: 'ret-d', name: 'RetD', keyword: '', system_prompt: '', teams_webhook_url: '', chat_retention_days: 1 });
  const c = convs.create(p.id, 'discord:1');
  const uploadDir = path.join(tmpWs, 'ret-d', '.otb-uploads', String(c.id));
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'a.png'), 'x');
  const { getDb } = require('../lib/db');
  getDb().prepare(`UPDATE conversations SET updated_at = datetime('now', '-10 days') WHERE id = ?`).run(c.id);
  runRetentionCleanup(new Date());
  assert.strictEqual(fs.existsSync(uploadDir), false);
  delete process.env.OTB_WORKSPACES_DIR;
});
```

Note: `services/workspace.service.js` reads `OTB_WORKSPACES_DIR` at module load. The retention service must therefore build the path itself from `process.env.OTB_WORKSPACES_DIR` at call time (see Step 3), not via `workspacePathFor`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/retention.test.js`
Expected: FAIL — upload dir still exists.

- [ ] **Step 3: Implement**

`models/conversation.model.js` — add and export:

```js
function listOlderThan(project_id, cutoff) {
  return getDb().prepare(
    `SELECT id FROM conversations WHERE project_id = ? AND updated_at < datetime(?)`
  ).all(project_id, cutoff);
}
```

`services/retention.service.js` — add at top: `const fs = require('fs');` and `const path = require('path');`. In `runRetentionCleanup`, before the `convs.deleteOlderThan` call:

```js
    // Remove per-conversation Discord upload dirs before their rows disappear.
    const workspacesDir = process.env.OTB_WORKSPACES_DIR || 'workspaces';
    for (const row of convs.listOlderThan(project.id, cutoff)) {
      const dir = path.join(workspacesDir, project.slug, '.otb-uploads', String(row.id));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/retention.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add models/conversation.model.js services/retention.service.js tests/retention.test.js
git commit -m "feat: retention deletes discord upload dirs with their conversations"
```

---

### Task 15: Server wiring, env docs, README

**Files:**
- Modify: `server.js`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: `discord.service.startAll()` (Task 11).
- Produces: bots start on boot; documented env knobs.

- [ ] **Step 1: Wire startup** — in `server.js`, inside the `if (require.main === module)` block after `retention.startInactivityJob();`:

```js
  require('./services/discord.service').startAll();
```

- [ ] **Step 2: Document env vars** — append to `.env.example`:

```bash

# --- Discord integration ---
# Bot tokens are stored in the database (admin UI > Discord), not here.
# Max size per inbound Discord attachment, in MB.
# DISCORD_MAX_ATTACHMENT_MB=20
# Max attachments handled per Discord message.
# DISCORD_MAX_ATTACHMENTS=5
# Answers longer than this many characters are attached as answer.md.
# DISCORD_LONG_ANSWER_THRESHOLD=6000
# Typing-indicator refresh interval (ms) while an investigation runs.
# DISCORD_TYPING_REFRESH_MS=8000
```

- [ ] **Step 3: Document the feature** — add a `## Discord` section to `README.md` after the Teams admin-setup content:

```markdown
## Discord

OpenTraceBridge can also host Discord bots (no Power Automate needed — each bot
opens an outbound gateway WebSocket; no new public port).

1. Create an application at <https://discord.com/developers/applications>, add a
   Bot, enable the **Message Content** privileged intent, copy the bot token.
2. Admin UI → **Discord** → add the bot (name + token). Use the invite link
   shown next to the connected bot to add it to your server.
3. On a project's edit page, pick the bot and add the designated channel ids
   (Discord → right-click channel → Copy Channel ID, with developer mode on).
   Mode `mention` answers only @bot messages; `all` answers everything.
4. For private DMs, allowlist Discord user ids on the Discord page. `member`
   users pick from their granted projects (`/projects`, `/project <slug>`);
   `admin` users get every project and full agent tools (edit/bash/webfetch),
   still sandboxed to the per-project OS user.

Slash commands: `/ask`, `/new`, `/stop`, `/status`, `/model`, `/agent`,
`/skills`, `/commands`, `/cmd`, `/stats`, `/sync`, `/guide`, and in DMs
`/projects`, `/project`. Questions are plain messages (or `/ask`); the bot
reacts 👀 while accepted, ✅/❌/⏱️/🛑 when done, keeps the typing indicator
alive while running, splits answers at 2,000 chars without breaking code
fences, and attaches `answer.md` when the answer exceeds
`DISCORD_LONG_ANSWER_THRESHOLD`. Inbound images/text files are downloaded into
`workspaces/<slug>/.otb-uploads/<conversation>/` and passed to the agent.
```

- [ ] **Step 4: Full suite + boot smoke test**

Run: `npm test`
Expected: PASS.
Run: `node -e "require('./server')" ` (loads both apps without listening)
Expected: exits silently — no require-time crashes.

- [ ] **Step 5: Commit**

```bash
git add server.js .env.example README.md
git commit -m "feat: start discord bots on boot and document the integration"
```

---

### Task 16: End-to-end verification (manual, needs a real bot token)

**Files:** none (verification checklist — record results in the final report)

- [ ] **Step 1: Automated evidence** — run `npm test` one final time; all green.
- [ ] **Step 2: Boot** — `npm start`; log shows `OpenTraceBridge public API listening…` and, once a bot is configured, `[discord] bot <name> connected as <tag>`.
- [ ] **Step 3: Manual checklist** (requires a Discord app + token; skip gracefully if unavailable and say so in the report):
  1. Admin → Discord → add bot → status turns `connected`, invite link works.
  2. Project edit → bind bot + channel (`all` mode) → plain message in that channel gets 👀 → typing → answer chunks → ✅.
  3. `mention` mode channel ignores plain messages, answers @bot ones.
  4. Unconfigured channel and unknown-user DM: silence.
  5. Allowlisted DM: `/projects`, `/project <slug>`, then a question runs in that project; `/status` shows role.
  6. `/model` autocomplete lists allowed models; `/stop` during a long run flips the reaction to 🛑.
  7. Attach a PNG with a question — file lands in `workspaces/<slug>/.otb-uploads/<conv>/` and the agent references it.
- [ ] **Step 4: Report** — summarize what was verified automatically vs. manually pending a token.
