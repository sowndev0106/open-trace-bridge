const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';

const { loginAgent } = require('./helpers/auth'); // sets ADMIN_USERNAME/PASSWORD before server loads
const { adminApp } = require('../server');
const { resetDbForTest, getDb } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const sync = require('../services/sync.service');
const opencode = require('../services/opencode.service');
const { ADMIN_CHANNEL } = require('../controllers/chat.controller');

let agent;
let project;
beforeEach(async () => {
  resetDbForTest();
  project = projects.create({ slug: 'payment', name: 'Payment', keyword: 'payment-bot',
    system_prompt: 'x', teams_webhook_url: 'https://hook.example/x', max_msg_length: 20000 });
  agent = await loginAgent(adminApp);
  sync.ensureReady = async () => '/tmp/ws-payment';
});

test('chat page renders empty state, requires auth', async () => {
  const res = await agent.get(`/admin/projects/${project.id}/chat`).expect(200);
  assert.match(res.text, /Payment/);
  assert.match(res.text, /chat-history/);

  const request = require('supertest');
  await request(adminApp).get(`/admin/projects/${project.id}/chat`).expect(302);
});

test('posting a message streams SSE events and persists messages + run', async () => {
  opencode.runPromptStream = async ({ dir, text, conversationId, onEvent }) => {
    assert.strictEqual(dir, '/tmp/ws-payment');
    assert.strictEqual(text, 'why did txn_9 fail?');
    assert.ok(conversationId);
    onEvent({ type: 'tool', name: 'call_api', status: 'running' });
    onEvent({ type: 'text', text: 'because ' });
    onEvent({ type: 'text', text: 'of X' });
    return { sessionId: 'ses_1', text: 'because of X',
      usage: { tokensInput: 10, tokensOutput: 5, tokensReasoning: 0, costUsd: 0.02 } };
  };

  const res = await agent.post(`/admin/projects/${project.id}/chat/messages`)
    .send({ text: 'why did txn_9 fail?' })
    .expect(200)
    .expect('Content-Type', /text\/event-stream/);

  assert.match(res.text, /event: tool\ndata: {"name":"call_api","status":"running"}/);
  assert.match(res.text, /event: text\ndata: {"text":"because "}/);
  assert.match(res.text, /event: done\n/);
  assert.match(res.text, /"costUsd":0.02/);

  const conv = convs.findActive(project.id, ADMIN_CHANNEL);
  assert.ok(conv);
  assert.strictEqual(conv.opencode_session_id, 'ses_1');
  const rows = messages.listByConversation(conv.id);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].direction, 'in');
  assert.strictEqual(rows[1].content, 'because of X');
  const run = getDb().prepare('SELECT * FROM runs WHERE project_id = ?').get(project.id);
  assert.strictEqual(run.status, 'success');
  assert.strictEqual(run.cost_usd, 0.02);
});

test('agent errors produce an error event and an error run row', async () => {
  opencode.runPromptStream = async () => { throw new Error('opencode exit 1: boom'); };
  const res = await agent.post(`/admin/projects/${project.id}/chat/messages`)
    .send({ text: 'hello' }).expect(200);
  assert.match(res.text, /event: error\n/);
  const run = getDb().prepare('SELECT * FROM runs WHERE project_id = ?').get(project.id);
  assert.strictEqual(run.status, 'error');
});

test('concurrent message for the same project is rejected with 409', async () => {
  let release;
  opencode.runPromptStream = async () => {
    await new Promise((r) => { release = r; });
    return { sessionId: 'ses_1', text: 'ok', usage: { tokensInput: 0, tokensOutput: 0, tokensReasoning: 0, costUsd: 0 } };
  };
  const firstPromise = agent.post(`/admin/projects/${project.id}/chat/messages`)
    .send({ text: 'one' }).then((r) => r);
  await new Promise((r) => setTimeout(r, 50)); // let the lock engage
  await agent.post(`/admin/projects/${project.id}/chat/messages`).send({ text: 'two' }).expect(409);
  release();
  await firstPromise;
});

test('empty text is a 400; new conversation closes the active one', async () => {
  await agent.post(`/admin/projects/${project.id}/chat/messages`).send({ text: '   ' }).expect(400);

  const conv = convs.create(project.id, ADMIN_CHANNEL);
  await agent.post(`/admin/projects/${project.id}/chat/new`).expect(302);
  assert.strictEqual(convs.findActive(project.id, ADMIN_CHANNEL), undefined);
  assert.strictEqual(getDb().prepare('SELECT status FROM conversations WHERE id = ?').get(conv.id).status, 'closed');
});

test('chat page renders history JSON, composer, and new-conversation button', async () => {
  const conv = convs.create(project.id, ADMIN_CHANNEL);
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: 'admin', user_name: 'Admin', content: 'q1' });
  messages.add({ conversation_id: conv.id, direction: 'out', content: '**bold answer**' });

  const res = await agent.get(`/admin/projects/${project.id}/chat`).expect(200);
  assert.match(res.text, /id="chat-history"/);
  assert.match(res.text, /bold answer/);
  assert.match(res.text, /id="chat-input"/);
  assert.match(res.text, /chat\/new/);
  assert.match(res.text, /marked/); // markdown renderer CDN
  assert.match(res.text, /purify/i); // DOMPurify CDN
});

test('opencode embed page renders iframe behind auth', async () => {
  const res = await agent.get(`/admin/projects/${project.id}/opencode`).expect(200);
  assert.match(res.text, /opencode-frame/);
  assert.match(res.text, /8668/);

  const request = require('supertest');
  await request(adminApp).get(`/admin/projects/${project.id}/opencode`).expect(302);
});
