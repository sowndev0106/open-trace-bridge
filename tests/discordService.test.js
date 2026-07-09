const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const discordBot = require('../models/discordBot.model');
const service = require('../services/discord.service');

beforeEach(() => {
  resetDbForTest();
  // The bot registry is module-level state that outlives resetDbForTest();
  // since bot ids restart at 1 for each fresh in-memory db, defensively tear
  // down any small leftover ids from the previous test before seeding new ones.
  for (let i = 1; i <= 6; i++) service.stopBot(i);
});

// Stubs deps.createBotClient with a fake gateway handle and records every
// call so tests can inspect which bots were started and drive onReady/onError.
function stubClient() {
  const calls = [];
  service.deps.createBotClient = (opts) => {
    const handle = {
      stopped: false,
      start: async () => {},
      stop() { this.stopped = true; },
      getClient: () => ({}),
    };
    calls.push({ botId: opts.botId, onReady: opts.onReady, onError: opts.onError, handle });
    return handle;
  };
  return calls;
}

test('startAll only starts bots where enabled = 1', () => {
  const enabledBot = discordBot.create({ name: 'e', token: 't1', enabled: 1 });
  const disabledBot = discordBot.create({ name: 'd', token: 't2', enabled: 0 });
  const calls = stubClient();

  service.startAll();

  const startedIds = calls.map((c) => c.botId);
  assert.deepStrictEqual(startedIds, [enabledBot.id]);
  assert.ok(!startedIds.includes(disabledBot.id));
});

test('statusAll reports disabled without ever calling createBotClient, then connecting -> connected for an enabled bot', () => {
  const disabledBot = discordBot.create({ name: 'd', token: 't2', enabled: 0 });
  const enabledBot = discordBot.create({ name: 'e', token: 't1', enabled: 1 });
  const calls = stubClient();

  service.startBot(enabledBot);

  const beforeReady = service.statusAll();
  const disabledStatus = beforeReady.find((s) => s.id === disabledBot.id);
  assert.strictEqual(disabledStatus.status, 'disabled');
  assert.ok(!calls.some((c) => c.botId === disabledBot.id));

  const connectingStatus = beforeReady.find((s) => s.id === enabledBot.id);
  assert.strictEqual(connectingStatus.status, 'connecting');

  const call = calls.find((c) => c.botId === enabledBot.id);
  call.onReady({ botUserTag: 'bot#1234', applicationId: 'app-1' });

  const afterReady = service.statusAll();
  const connectedStatus = afterReady.find((s) => s.id === enabledBot.id);
  assert.strictEqual(connectedStatus.status, 'connected');
  assert.strictEqual(connectedStatus.botUserTag, 'bot#1234');
  assert.match(connectedStatus.inviteUrl, /app-1/);
});

test('stopBot calls the handle stop() and removes the registry entry, leaving statusAll reporting error', () => {
  const bot = discordBot.create({ name: 'e', token: 't1', enabled: 1 });
  const calls = stubClient();
  service.startBot(bot);
  const call = calls.find((c) => c.botId === bot.id);

  service.stopBot(bot.id);

  assert.strictEqual(call.handle.stopped, true);
  // Bot row is still enabled = 1 but no registry entry exists anymore, so
  // per statusAll's current logic (`entry ? entry.status : 'error'`) this
  // reports 'error', not 'disabled'.
  const status = service.statusAll().find((s) => s.id === bot.id);
  assert.strictEqual(status.status, 'error');
});

test('restartBot tears down the gateway client when a bot has just been disabled, without starting a new one', () => {
  const bot = discordBot.create({ name: 'e', token: 't1', enabled: 1 });
  const calls = stubClient();
  service.startBot(bot);
  const call = calls.find((c) => c.botId === bot.id);
  assert.strictEqual(calls.length, 1);

  discordBot.update(bot.id, { enabled: 0 });
  service.restartBot(bot.id);

  assert.strictEqual(call.handle.stopped, true, 'the old handle must be stopped');
  assert.strictEqual(calls.length, 1, 'no new client should have been created for a disabled bot');
  const status = service.statusAll().find((s) => s.id === bot.id);
  assert.strictEqual(status.status, 'disabled');
});

test('onError callback persists last_error on the bot row', () => {
  const bot = discordBot.create({ name: 'e', token: 't1', enabled: 1 });
  const calls = stubClient();
  service.startBot(bot);
  const call = calls.find((c) => c.botId === bot.id);

  call.onError(new Error('boom'));

  assert.strictEqual(discordBot.findById(bot.id).last_error, 'boom');
});
