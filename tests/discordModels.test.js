const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const bots = require('../models/discordBot.model');
const channels = require('../models/discordChannel.model');
const dmUsers = require('../models/discordUser.model');
const settings = require('../models/setting.model');
const runs = require('../models/run.model');

beforeEach(() => { resetDbForTest(); });

function seedProject(slug = 'p1') {
  return projects.create({ slug, name: slug, keyword: '', system_prompt: '', teams_webhook_url: '' });
}

test('discord bot CRUD keeps token and tracks last_error', () => {
  const b = bots.create({ name: 'Main bot', token: 'tok-secret' });
  assert.ok(b.id);
  assert.strictEqual(b.enabled, 1);
  bots.update(b.id, { last_error: 'login failed', enabled: 0 });
  const row = bots.findById(b.id);
  assert.strictEqual(row.last_error, 'login failed');
  assert.strictEqual(bots.listEnabled().length, 0);
  assert.strictEqual(bots.list().length, 1);
  bots.remove(b.id);
  assert.strictEqual(bots.list().length, 0);
});

test('discord channels replaceForProject reconciles rows and enforces unique channel', () => {
  const p = seedProject();
  channels.replaceForProject(p.id, [{ channel_id: '111', mode: 'all' }, { channel_id: '222', mode: 'mention' }]);
  assert.strictEqual(channels.listByProject(p.id).length, 2);
  assert.strictEqual(channels.findByChannelId('111').mode, 'all');
  channels.replaceForProject(p.id, [{ channel_id: '222', mode: 'all' }]);
  assert.strictEqual(channels.listByProject(p.id).length, 1);
  assert.strictEqual(channels.findByChannelId('111'), undefined);
  assert.strictEqual(channels.findByChannelId('222').mode, 'all');
});

test('dm users: allowlist, per-user projects, selections', () => {
  const p1 = seedProject('p1');
  const p2 = seedProject('p2');
  const b = require('../models/discordBot.model').create({ name: 'b', token: 't' });
  const u = dmUsers.create({ discord_user_id: '42', label: 'Alice', role: 'member' });
  assert.strictEqual(dmUsers.findByDiscordId('42').label, 'Alice');
  dmUsers.setProjects(u.id, [p1.id, p2.id]);
  assert.deepStrictEqual(dmUsers.listProjectIds(u.id).sort(), [p1.id, p2.id].sort());
  dmUsers.setProjects(u.id, [p2.id]);
  assert.deepStrictEqual(dmUsers.listProjectIds(u.id), [p2.id]);
  assert.strictEqual(dmUsers.getSelection(u.id, b.id), null);
  dmUsers.setSelection(u.id, b.id, p2.id);
  assert.strictEqual(dmUsers.getSelection(u.id, b.id), p2.id);
  dmUsers.setSelection(u.id, b.id, p1.id);
  assert.strictEqual(dmUsers.getSelection(u.id, b.id), p1.id);
  dmUsers.update(u.id, { role: 'admin', all_projects: 1 });
  assert.strictEqual(dmUsers.findById(u.id).role, 'admin');
});

test('settings KV get/set', () => {
  assert.strictEqual(settings.get('discord_allowed_models'), null);
  settings.set('discord_allowed_models', 'anthropic/claude-sonnet-5');
  assert.strictEqual(settings.get('discord_allowed_models'), 'anthropic/claude-sonnet-5');
  settings.set('discord_allowed_models', 'x');
  assert.strictEqual(settings.get('discord_allowed_models'), 'x');
});

test('run stats aggregate per conversation and project', () => {
  const p = seedProject();
  const convs = require('../models/conversation.model');
  const c = convs.create(p.id, 'discord:1');
  runs.add({ project_id: p.id, conversation_id: c.id, status: 'success', duration_ms: 10, tokens_input: 100, tokens_output: 50, tokens_reasoning: 0, cost_usd: 0.5 });
  runs.add({ project_id: p.id, conversation_id: c.id, status: 'error', duration_ms: 10, error: 'x' });
  const cs = runs.statsForConversation(c.id);
  assert.strictEqual(cs.runs, 2);
  assert.strictEqual(cs.tokens_input, 100);
  assert.strictEqual(cs.cost_usd, 0.5);
  const ps = runs.totalsForProject(p.id);
  assert.strictEqual(ps.runs, 2);
});
