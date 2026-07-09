const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { loginAgent } = require('./helpers/auth');
const { adminApp } = require('../server');
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const bots = require('../models/discordBot.model');
const dmUsers = require('../models/discordUser.model');
const settings = require('../models/setting.model');

let agent;
beforeEach(async () => { resetDbForTest(); agent = await loginAgent(adminApp); });

test('discord page lists bots with redacted tokens', async () => {
  bots.create({ name: 'Main', token: 'super-secret-token' });
  const page = await agent.get('/admin/discord').expect(200);
  assert.match(page.text, /Main/);
  assert.ok(!page.text.includes('super-secret-token'), 'token must never render');
});

test('create bot requires name and token; update keeps token when blank', async () => {
  await agent.post('/admin/discord/bots').type('form').send({ name: '', token: '' }).expect(400);
  await agent.post('/admin/discord/bots').type('form').send({ name: 'Main', token: 'tok-1' }).expect(302);
  const b = bots.list()[0];
  assert.strictEqual(b.token, 'tok-1');
  await agent.post(`/admin/discord/bots/${b.id}`).type('form')
    .send({ name: 'Renamed', token: '', enabled: '1' }).expect(302);
  const updated = bots.findById(b.id);
  assert.strictEqual(updated.name, 'Renamed');
  assert.strictEqual(updated.token, 'tok-1'); // blank keeps stored token
  await agent.post(`/admin/discord/bots/${b.id}/delete`).expect(302);
  assert.strictEqual(bots.list().length, 0);
});

test('dm user CRUD with role and project entitlements', async () => {
  const p = projects.create({ slug: 'pay', name: 'Pay', keyword: '', system_prompt: '', teams_webhook_url: '' });
  await agent.post('/admin/discord/users').type('form')
    .send({ discord_user_id: '42', label: 'Alice', role: 'member', project_ids: [String(p.id)] }).expect(302);
  const u = dmUsers.findByDiscordId('42');
  assert.deepStrictEqual(dmUsers.listProjectIds(u.id), [p.id]);
  await agent.post(`/admin/discord/users/${u.id}`).type('form')
    .send({ label: 'Alice A', role: 'admin', all_projects: '1' }).expect(302);
  assert.strictEqual(dmUsers.findById(u.id).role, 'admin');
  await agent.post('/admin/discord/users').type('form')
    .send({ discord_user_id: 'not-digits', label: 'x', role: 'member' }).expect(400);
  await agent.post(`/admin/discord/users/${u.id}/delete`).expect(302);
  assert.strictEqual(dmUsers.list().length, 0);
});

test('models settings save allowlist and default', async () => {
  await agent.post('/admin/discord/models').type('form')
    .send({ allowed_models: 'a/m1\nb/m2', default_model: 'a/m1' }).expect(302);
  assert.strictEqual(settings.get('discord_allowed_models'), 'a/m1\nb/m2');
  assert.strictEqual(settings.get('discord_default_model'), 'a/m1');
});

test('project save binds a bot and reconciles designated channels', async () => {
  const b = bots.create({ name: 'Main', token: 't' });
  const p = projects.create({ slug: 'pay2', name: 'Pay2', keyword: '', system_prompt: '', teams_webhook_url: '' });
  const channels = require('../models/discordChannel.model');
  await agent.post(`/admin/projects/${p.id}`).type('form').send({
    slug: 'pay2', name: 'Pay2', keyword: '', system_prompt: '', teams_webhook_url: '',
    max_msg_length: '20000', chat_retention_days: '90',
    discord_bot_id: String(b.id),
    discord_channel_id: ['111222333'], discord_channel_mode: ['all'],
  }).expect(302);
  assert.strictEqual(projects.findById(p.id).discord_bot_id, b.id);
  assert.strictEqual(channels.findByChannelId('111222333').project_id, p.id);
});
