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

test('createBotClient retries login without MessageContent intent if disallowed', async () => {
  const mockClientInstances = [];
  class MockClient {
    constructor(options) {
      this.options = options;
      this.events = {};
      mockClientInstances.push(this);
      this.user = { tag: 'mockbot#1234' };
      this.application = {
        id: 'mock-app-id',
        commands: {
          set: async () => {}
        }
      };
    }
    on(event, handler) {
      this.events[event] = handler;
    }
    async login(token) {
      if (this.options.intents.includes('MessageContent')) {
        const err = new Error('Used disallowed intents');
        err.code = 'DisallowedIntents';
        throw err;
      }
      // Success on fallback (without MessageContent)
      if (this.events['ready']) {
        await this.events['ready']();
      }
      return token;
    }
    destroy() {
      this.destroyed = true;
    }
  }

  // Inject mock into require cache
  const originalCache = require.cache[require.resolve('discord.js')];
  require.cache[require.resolve('discord.js')] = {
    exports: {
      Client: MockClient,
      GatewayIntentBits: {
        Guilds: 'Guilds',
        GuildMessages: 'GuildMessages',
        DirectMessages: 'DirectMessages',
        MessageContent: 'MessageContent'
      },
      Partials: {
        Channel: 'Channel'
      }
    }
  };

  const { createBotClient } = require('../lib/discordClient');

  let readyCalled = false;
  const bot = createBotClient({
    botId: 1,
    token: 'dummy-token',
    onReady: () => { readyCalled = true; },
    onError: () => {}
  });

  await bot.start();

  assert.strictEqual(readyCalled, true);
  // Should have created two clients (first with MessageContent, second without)
  assert.strictEqual(mockClientInstances.length, 2);
  assert.ok(mockClientInstances[0].options.intents.includes('MessageContent'));
  assert.ok(!mockClientInstances[1].options.intents.includes('MessageContent'));
  assert.strictEqual(mockClientInstances[0].destroyed, true);

  // Cleanup cache
  if (originalCache) {
    require.cache[require.resolve('discord.js')] = originalCache;
  } else {
    delete require.cache[require.resolve('discord.js')];
  }
});

