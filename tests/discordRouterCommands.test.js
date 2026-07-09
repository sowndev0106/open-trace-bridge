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
