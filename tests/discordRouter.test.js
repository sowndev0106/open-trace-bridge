const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const bots = require('../models/discordBot.model');
const channels = require('../models/discordChannel.model');
const dmUsers = require('../models/discordUser.model');
const router = require('../services/discordRouter');
const { EMOJI } = require('../lib/discordFormat');

let bot, project;
beforeEach(() => {
  resetDbForTest();
  bot = bots.create({ name: 'b', token: 't' });
  project = projects.create({ slug: 'pay', name: 'Pay', keyword: '', system_prompt: '', teams_webhook_url: '' });
  projects.update(project.id, { discord_bot_id: bot.id });
  project = projects.findById(project.id);
  router.deps.investigate = async () => 'the answer';
  router.deps.ensureReady = async () => '/tmp/ws-router';
});

function fakeIo() {
  const calls = { replies: [], embeds: [], reactions: [], files: [], typing: 0 };
  return {
    calls,
    reply: async (t) => calls.replies.push(t),
    replyEmbed: async (e) => calls.embeds.push(e),
    sendFile: async (name, content) => calls.files.push({ name, content }),
    react: async (e) => calls.reactions.push(e),
    setReaction: async (e) => calls.reactions.push(e),
    startTyping: async () => { calls.typing += 1; },
    stopTyping: async () => {},
  };
}

function guildMsg(over = {}) {
  return {
    botId: bot.id, channelId: '111', isDM: false, authorId: 'u1', authorName: 'Alice',
    authorIsBot: false, mentionsBot: false, content: 'why down?', attachments: [], messageId: 'm1', ...over,
  };
}

test('ignores undesignated channels and bot authors', async () => {
  const io = fakeIo();
  await router.handleMessage(guildMsg(), io); // no channel row yet
  await router.handleMessage(guildMsg({ authorIsBot: true }), io);
  assert.strictEqual(io.calls.replies.length, 0);
  assert.strictEqual(io.calls.reactions.length, 0);
});

test('mention mode requires a mention; all mode answers everything', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'mention' }]);
  const io1 = fakeIo();
  await router.handleMessage(guildMsg({ mentionsBot: false }), io1);
  assert.strictEqual(io1.calls.replies.length, 0);
  const io2 = fakeIo();
  await router.handleMessage(guildMsg({ mentionsBot: true }), io2);
  assert.deepStrictEqual(io2.calls.replies, ['the answer']);
  assert.deepStrictEqual(io2.calls.reactions, [EMOJI.accepted, EMOJI.success]);
  const conv = convs.findActive(project.id, 'discord:111');
  assert.ok(conv);
  const msgs = messages.listByConversation ? messages.listByConversation(conv.id) : null;
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  const io3 = fakeIo();
  await router.handleMessage(guildMsg({ mentionsBot: false }), io3);
  assert.strictEqual(io3.calls.replies.length, 1);
});

test('channel bound to another bot stays silent', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  const io = fakeIo();
  await router.handleMessage(guildMsg({ botId: bot.id + 999 }), io);
  assert.strictEqual(io.calls.replies.length, 0);
});

test('investigation error posts an error embed and error reaction', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  router.deps.investigate = async () => { throw new Error('boom'); };
  const io = fakeIo();
  await router.handleMessage(guildMsg(), io);
  assert.strictEqual(io.calls.embeds.length, 1);
  assert.match(io.calls.embeds[0].description, /boom/);
  assert.deepStrictEqual(io.calls.reactions, [EMOJI.accepted, EMOJI.error]);
});

test('DM from unknown user is silent; allowlisted user without selection is prompted', async () => {
  const dm = guildMsg({ isDM: true, channelId: 'dm-1', authorId: '42' });
  const io1 = fakeIo();
  await router.handleMessage(dm, io1);
  assert.strictEqual(io1.calls.replies.length + io1.calls.embeds.length, 0);
  const u = dmUsers.create({ discord_user_id: '42', all_projects: 1 });
  const io2 = fakeIo();
  await router.handleMessage(dm, io2);
  assert.strictEqual(io2.calls.embeds.length, 1);
  assert.match(io2.calls.embeds[0].description, /\/project/);
});

test('DM with a selected project runs and keeps a per-user conversation id', async () => {
  const u = dmUsers.create({ discord_user_id: '42', all_projects: 1 });
  dmUsers.setSelection(u.id, bot.id, project.id);
  const io = fakeIo();
  await router.handleMessage(guildMsg({ isDM: true, channelId: 'dm-1', authorId: '42' }), io);
  assert.deepStrictEqual(io.calls.replies, ['the answer']);
  assert.ok(convs.findActive(project.id, `discord:dm:${bot.id}:42`));
});

test('DM admin runs with admin=true', async () => {
  const u = dmUsers.create({ discord_user_id: '42', role: 'admin' });
  dmUsers.setSelection(u.id, bot.id, project.id);
  let seenOpts = null;
  router.deps.investigate = async (p, c, prompt, opts) => { seenOpts = opts; return 'ok'; };
  const io = fakeIo();
  await router.handleMessage(guildMsg({ isDM: true, channelId: 'dm-1', authorId: '42' }), io);
  assert.strictEqual(seenOpts.admin, true);
});

test('attachments are validated, downloaded, and passed as files', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  let seenOpts = null;
  router.deps.investigate = async (p, c, prompt, opts) => { seenOpts = opts; return 'ok'; };
  router.deps.attachments = {
    ...require('../services/discordAttachment.service'),
    validate: () => ({ ok: true }),
    downloadAll: async () => ['/tmp/ws-router/.otb-uploads/1/m1-a.png'],
  };
  const io = fakeIo();
  await router.handleMessage(guildMsg({ content: '', attachments: [{ name: 'a.png', url: 'u', size: 1, contentType: 'image/png' }] }), io);
  assert.deepStrictEqual(seenOpts.files, ['/tmp/ws-router/.otb-uploads/1/m1-a.png']);
});

test('oversize attachment posts a warning embed and does not run', async () => {
  channels.replaceForProject(project.id, [{ channel_id: '111', mode: 'all' }]);
  let ran = false;
  router.deps.investigate = async () => { ran = true; return 'x'; };
  router.deps.attachments = {
    ...require('../services/discordAttachment.service'),
    validate: () => ({ ok: false, reason: 'too big' }),
  };
  const io = fakeIo();
  await router.handleMessage(guildMsg({ attachments: [{ name: 'a.bin', url: 'u', size: 1, contentType: 'x' }] }), io);
  assert.strictEqual(ran, false);
  assert.match(io.calls.embeds[0].description, /too big/);
});
