const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.OTB_DB_PATH = ':memory:';

const { publicApp } = require('../server');
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
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
  const conv = convs.findActive(project.id, 'c1');
  assert.ok(conv);
  await waitFor(() => messages.listByConversation(conv.id).length === 2);
  const rows = messages.listByConversation(conv.id);
  assert.strictEqual(rows[0].direction, 'in');
  assert.strictEqual(rows[0].content, 'payment-bot /pull-source');
  assert.strictEqual(rows[1].direction, 'out');
  assert.match(rows[1].content, /Sources updated to latest/);
});

test('message path uses ensureReady and replies with the agent answer', async () => {
  sync.ensureReady = async () => '/tmp/ws-payment';
  opencode.runPrompt = async ({ dir, text, conversationId }) => {
    assert.strictEqual(dir, '/tmp/ws-payment');
    assert.strictEqual(text, 'why did txn_9 fail?');
    assert.strictEqual(conversationId, convs.findActive(project.id, 'c1').id);
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

test('/guide responds without starting an OpenCode session and lists commands', async () => {
  const res = await request(publicApp)
    .post('/api/events/payment')
    .send({ raw: { text: 'payment-bot /guide' }, user: { id: 'u1', name: 'An' },
      channel: { conversationId: 'c3' } })
    .expect(200);
  assert.strictEqual(res.body.action, 'guide');
  await waitFor(() => sent.length === 1);
  assert.strictEqual(sent[0].status, 'info');
  assert.match(sent[0].markdown, /\/new/);
  assert.match(sent[0].markdown, /\/pull-source/);
  assert.match(sent[0].markdown, /\/guide/);
  assert.match(sent[0].markdown, /payment-bot/);
  const conv = convs.findActive(project.id, 'c3');
  assert.ok(conv);
  await waitFor(() => messages.listByConversation(conv.id).length === 2);
});

test('unknown slash command sends a hint card and never calls the agent', async () => {
  let called = false;
  opencode.runPrompt = async () => { called = true; return { sessionId: 'ses_x', text: 'should not run' }; };
  const res = await request(publicApp)
    .post('/api/events/payment')
    .send({ raw: { text: 'payment-bot /doesnotexist' }, user: { id: 'u1', name: 'An' },
      channel: { conversationId: 'c4' } })
    .expect(200);
  assert.strictEqual(res.body.action, 'unknown-command');
  await waitFor(() => sent.length === 1);
  assert.match(sent[0].markdown, /\/guide/);
  assert.strictEqual(called, false);
});
