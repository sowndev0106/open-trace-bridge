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
