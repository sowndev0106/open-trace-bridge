const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const cheerio = require('cheerio');

process.env.OTB_DB_PATH = ':memory:';

const { loginAgent } = require('./helpers/auth');
const { adminApp } = require('../server');
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const apicalls = require('../models/apicall.model');
const runs = require('../models/run.model');

let agent;
beforeEach(async () => {
  resetDbForTest();
  agent = await loginAgent(adminApp);
});

function seedProject(overrides = {}) {
  return projects.create({
    slug: 'payment',
    name: 'Payment',
    keyword: 'payment-bot',
    system_prompt: 'Investigate payment incidents.',
    teams_webhook_url: 'https://hook.example/payment',
    max_msg_length: 20000,
    chat_retention_days: 90,
    ...overrides,
  });
}

test('dashboard renders stat cards and respects the days filter', async () => {
  const project = seedProject();
  const conv = convs.create(project.id, 'c1');
  messages.add({ conversation_id: conv.id, direction: 'in', content: 'hi' });
  messages.add({ conversation_id: conv.id, direction: 'out', content: 'hello' });
  runs.add({ project_id: project.id, conversation_id: conv.id, status: 'success', duration_ms: 1000,
    tokens_input: 100, tokens_output: 20, tokens_reasoning: 0, cost_usd: 0.01 });
  runs.add({ project_id: project.id, conversation_id: conv.id, status: 'error', duration_ms: 500, error: 'boom' });
  apicalls.add({ project_id: project.id, group_name: 'txn', method: 'GET', url: 'https://api.example/x', status: 200 });

  const page = await agent.get('/admin/dashboard').expect(200);
  cheerio.load(page.text);
  assert.match(page.text, /Payment/);
  assert.match(page.text, /Total questions/);
  assert.match(page.text, /Error rate/);
  assert.match(page.text, /call_api/);

  const filtered = await agent.get('/admin/dashboard?days=7').expect(200);
  assert.match(filtered.text, /Payment/);
});

test('dashboard shows n/a for projects with no runs yet', async () => {
  seedProject({ slug: 'empty-proj', keyword: 'empty-bot' });
  const page = await agent.get('/admin/dashboard').expect(200);
  assert.match(page.text, /n\/a/);
});
