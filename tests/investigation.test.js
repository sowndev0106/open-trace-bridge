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

test('investigate passes the conversation variant override to runPrompt', async () => {
  const { p, c } = seed();
  convs.setOverrides(c.id, { model: 'anthropic/claude-sonnet-5', agent: null, variant: 'thinking' });
  const seen = {};
  investigation.deps.ensureReady = async () => '/tmp/ws-inv';
  investigation.deps.ensureProjectUser = () => null;
  investigation.deps.ownWorkspace = () => {};
  investigation.deps.runPrompt = async (opts) => { Object.assign(seen, opts); return { sessionId: 'ses_10', text: 'answer', usage: {} }; };
  await investigation.investigate(p, convs.findById(c.id), 'why is it down?', {});
  assert.strictEqual(seen.variant, 'thinking');
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
