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
