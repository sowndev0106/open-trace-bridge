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
