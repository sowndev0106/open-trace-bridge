const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';

const { getDb, resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const apicalls = require('../models/apicall.model');
const runs = require('../models/run.model');
const retention = require('../services/retention.service');

beforeEach(() => resetDbForTest());

test('retention cleanup deletes old conversations, messages, and API calls', () => {
  const project = projects.create({
    slug: 'payment',
    name: 'Payment',
    keyword: 'payment-bot',
    system_prompt: '',
    teams_webhook_url: '',
    max_msg_length: 20000,
    chat_retention_days: 7,
  });
  const oldConv = convs.create(project.id, 'old-chat');
  const newConv = convs.create(project.id, 'new-chat');
  messages.add({ conversation_id: oldConv.id, direction: 'in', content: 'old' });
  messages.add({ conversation_id: newConv.id, direction: 'in', content: 'new' });
  apicalls.add({ project_id: project.id, group_name: 'txn', method: 'GET', url: 'https://api.example/old', status: 200 });
  apicalls.add({ project_id: project.id, group_name: 'txn', method: 'GET', url: 'https://api.example/new', status: 200 });
  runs.add({ project_id: project.id, status: 'success', duration_ms: 100 });
  runs.add({ project_id: project.id, status: 'success', duration_ms: 200 });

  getDb().prepare(`UPDATE conversations SET updated_at = datetime('2026-06-20 00:00:00') WHERE id = ?`).run(oldConv.id);
  getDb().prepare(`UPDATE conversations SET updated_at = datetime('2026-07-04 00:00:00') WHERE id = ?`).run(newConv.id);
  getDb().prepare(`UPDATE api_calls SET created_at = datetime('2026-06-20 00:00:00') WHERE url LIKE '%/old'`).run();
  getDb().prepare(`UPDATE api_calls SET created_at = datetime('2026-07-04 00:00:00') WHERE url LIKE '%/new'`).run();
  getDb().prepare(`UPDATE runs SET created_at = datetime('2026-06-20 00:00:00') WHERE duration_ms = 100`).run();
  getDb().prepare(`UPDATE runs SET created_at = datetime('2026-07-04 00:00:00') WHERE duration_ms = 200`).run();

  const result = retention.runRetentionCleanup(new Date('2026-07-05T00:00:00Z'));

  assert.strictEqual(result.projectsChecked, 1);
  assert.strictEqual(result.conversationsDeleted, 1);
  assert.strictEqual(result.apiCallsDeleted, 1);
  assert.strictEqual(result.runsDeleted, 1);
  assert.strictEqual(convs.findActive(project.id, 'old-chat'), undefined);
  assert.ok(convs.findActive(project.id, 'new-chat'));
  assert.strictEqual(messages.listByConversation(oldConv.id).length, 0);
  assert.strictEqual(apicalls.listByProject(project.id).length, 1);
  assert.strictEqual(runs.listByProject(project.id).length, 1);
});

test('retention cleanup skips projects with retention set to zero', () => {
  const project = projects.create({
    slug: 'payment',
    name: 'Payment',
    keyword: 'payment-bot',
    system_prompt: '',
    teams_webhook_url: '',
    max_msg_length: 20000,
    chat_retention_days: 0,
  });
  const oldConv = convs.create(project.id, 'old-chat');
  messages.add({ conversation_id: oldConv.id, direction: 'in', content: 'old' });
  apicalls.add({ project_id: project.id, group_name: 'txn', method: 'GET', url: 'https://api.example/old', status: 200 });
  runs.add({ project_id: project.id, status: 'success', duration_ms: 100 });
  getDb().prepare(`UPDATE conversations SET updated_at = datetime('2026-01-01 00:00:00') WHERE id = ?`).run(oldConv.id);
  getDb().prepare(`UPDATE api_calls SET created_at = datetime('2026-01-01 00:00:00')`).run();
  getDb().prepare(`UPDATE runs SET created_at = datetime('2026-01-01 00:00:00')`).run();

  const result = retention.runRetentionCleanup(new Date('2026-07-05T00:00:00Z'));

  assert.strictEqual(result.conversationsDeleted, 0);
  assert.strictEqual(result.apiCallsDeleted, 0);
  assert.strictEqual(result.runsDeleted, 0);
  assert.ok(convs.findActive(project.id, 'old-chat'));
  assert.strictEqual(apicalls.listByProject(project.id).length, 1);
  assert.strictEqual(runs.listByProject(project.id).length, 1);
});

const sessionModel = require('../models/session.model');

test('retention cleanup deletes expired sessions regardless of projects', () => {
  sessionModel.create();
  sessionModel.create();
  getDb().prepare(`UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id = (SELECT MIN(id) FROM sessions)`).run();

  const result = retention.runRetentionCleanup();
  assert.strictEqual(result.sessionsDeleted, 1);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);
});
