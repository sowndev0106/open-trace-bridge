const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { getDb, resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const runs = require('../models/run.model');

beforeEach(() => { resetDbForTest(); });

test('project CRUD + findBySlug', () => {
  const p = projects.create({
    slug: 'payment', name: 'Payment', keyword: 'payment-bot',
    system_prompt: 'You are an investigator', teams_webhook_url: 'https://hook.example/x',
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
  const g = apis.create({ project_id: p.id, name: 'txn-api', base_url: 'https://api.internal', api_key: 'key1', auth_header: 'Authorization', allowed_methods: 'GET', description_md: '# Txn API', curl_command: 'curl https://api.internal' });
  assert.strictEqual(repos.listByProject(p.id).length, 1);
  assert.strictEqual(apis.findByProjectAndName(p.id, 'txn-api').id, g.id);
  assert.strictEqual(apis.findByProjectAndName(p.id, 'txn-api').curl_command, 'curl https://api.internal');
});

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
    auth_header: 'Authorization', allowed_methods: 'GET', description_md: 'd', curl_command: 'curl https://x.example' });
  const row = apis.update(a.id, { name: 'two', base_url: 'https://y.example', api_key: 'k2',
    auth_header: 'X-Key', allowed_methods: 'GET,POST', description_md: 'e', curl_command: 'curl https://y.example' });
  assert.strictEqual(row.name, 'two');
  assert.strictEqual(row.base_url, 'https://y.example');
  assert.strictEqual(row.api_key, 'k2');
  assert.strictEqual(row.auth_header, 'X-Key');
  assert.strictEqual(row.allowed_methods, 'GET,POST');
  assert.strictEqual(row.description_md, 'e');
  assert.strictEqual(row.curl_command, 'curl https://y.example');
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

test('run.model add/listByProject/deleteOlderThan', () => {
  const project = projects.create({ slug: 'payment', name: 'Payment', keyword: 'payment-bot',
    system_prompt: '', teams_webhook_url: '', max_msg_length: 20000, chat_retention_days: 90 });
  runs.add({ project_id: project.id, status: 'success', duration_ms: 1200,
    tokens_input: 100, tokens_output: 20, tokens_reasoning: 0, cost_usd: 0.01 });
  runs.add({ project_id: project.id, status: 'error', duration_ms: 500, error: 'boom' });

  const rows = runs.listByProject(project.id);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].status, 'error');
  assert.strictEqual(rows[1].status, 'success');
  assert.strictEqual(rows[1].tokens_input, 100);
  assert.strictEqual(rows[0].error, 'boom');
  assert.strictEqual(rows[0].tokens_input, null);

  getDb().prepare(`UPDATE runs SET created_at = datetime('2026-01-01 00:00:00') WHERE status = 'error'`).run();
  const deleted = runs.deleteOlderThan(project.id, '2026-06-01 00:00:00');
  assert.strictEqual(deleted, 1);
  assert.strictEqual(runs.listByProject(project.id).length, 1);
});

test('run.model statsForProject aggregates duration, error rate, tokens, cost', () => {
  const project = projects.create({ slug: 'payment2', name: 'Payment2', keyword: 'payment2-bot',
    system_prompt: '', teams_webhook_url: '', max_msg_length: 20000, chat_retention_days: 90 });
  runs.add({ project_id: project.id, status: 'success', duration_ms: 1000, tokens_input: 100, tokens_output: 10, tokens_reasoning: 0, cost_usd: 0.01 });
  runs.add({ project_id: project.id, status: 'success', duration_ms: 2000, tokens_input: 200, tokens_output: 20, tokens_reasoning: 0, cost_usd: 0.02 });
  runs.add({ project_id: project.id, status: 'error', duration_ms: 500 });

  const stats = runs.statsForProject(project.id, '2020-01-01 00:00:00');
  assert.strictEqual(stats.totalRuns, 3);
  assert.strictEqual(stats.avgDurationMs, (1000 + 2000 + 500) / 3);
  assert.ok(Math.abs(stats.errorRate - (1 / 3)) < 1e-9);
  assert.strictEqual(stats.totalTokensInput, 300);
  assert.strictEqual(stats.totalTokensOutput, 30);
  assert.ok(Math.abs(stats.totalCostUsd - 0.03) < 1e-9);
});

test('run.model statsForProject returns nulls when there are no runs', () => {
  const project = projects.create({ slug: 'payment3', name: 'Payment3', keyword: 'payment3-bot',
    system_prompt: '', teams_webhook_url: '', max_msg_length: 20000, chat_retention_days: 90 });
  const stats = runs.statsForProject(project.id, '2020-01-01 00:00:00');
  assert.strictEqual(stats.totalRuns, 0);
  assert.strictEqual(stats.avgDurationMs, null);
  assert.strictEqual(stats.errorRate, null);
  assert.strictEqual(stats.totalTokensInput, null);
  assert.strictEqual(stats.totalCostUsd, null);
});
