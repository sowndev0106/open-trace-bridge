const { test } = require('node:test');
const assert = require('node:assert');
const { COMMAND_DEFS } = require('../lib/discordCommands');
const { mapMessage, mapInteraction } = require('../lib/discordClient');

test('COMMAND_DEFS contains all 14 commands with autocomplete where needed', () => {
  const names = COMMAND_DEFS.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['agent', 'ask', 'cmd', 'commands', 'guide', 'model', 'new',
    'project', 'projects', 'skills', 'stats', 'status', 'stop', 'sync']);
  const model = COMMAND_DEFS.find((c) => c.name === 'model');
  assert.strictEqual(model.options[0].autocomplete, true);
  const project = COMMAND_DEFS.find((c) => c.name === 'project');
  assert.strictEqual(project.options[0].required, true);
  const ask = COMMAND_DEFS.find((c) => c.name === 'ask');
  assert.strictEqual(ask.options[0].required, true);
});

test('mapMessage strips the bot mention and detects DM vs guild', () => {
  const botUser = { id: '999' };
  const message = {
    id: 'm1',
    content: '<@999> why is checkout down?',
    channelId: '111',
    guildId: 'g1',
    author: { id: 'u1', username: 'alice', bot: false },
    mentions: { users: new Map([['999', botUser]]) },
    attachments: new Map([['a1', { name: 'x.png', url: 'https://cdn/x.png', size: 5, contentType: 'image/png' }]]),
  };
  const msg = mapMessage(message, botUser, 7);
  assert.strictEqual(msg.botId, 7);
  assert.strictEqual(msg.isDM, false);
  assert.strictEqual(msg.mentionsBot, true);
  assert.strictEqual(msg.content, 'why is checkout down?');
  assert.deepStrictEqual(msg.attachments, [{ name: 'x.png', url: 'https://cdn/x.png', size: 5, contentType: 'image/png' }]);
  const dm = mapMessage({ ...message, guildId: null, content: 'hello', mentions: { users: new Map() } }, botUser, 7);
  assert.strictEqual(dm.isDM, true);
  assert.strictEqual(dm.mentionsBot, false);
});

test('mapInteraction extracts name, options, and DM flag', () => {
  const interaction = {
    commandName: 'model',
    channelId: '111',
    guildId: null,
    user: { id: 'u1', username: 'alice' },
    options: { data: [{ name: 'name', value: 'a/m1' }, { name: 'variant', value: 'high' }] },
  };
  const cmd = mapInteraction(interaction, 7);
  assert.deepStrictEqual(cmd, {
    name: 'model', options: { name: 'a/m1', variant: 'high' },
    botId: 7, channelId: '111', isDM: true, userId: 'u1', userName: 'alice',
  });
});
