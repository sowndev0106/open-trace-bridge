// Manages one gateway client per enabled bot. Started from server.js; the
// admin controller calls restartBot/stopBot after saves so token rotation
// needs no server restart.
const botsModel = require('../models/discordBot.model');
const router = require('./discordRouter');
const { createBotClient } = require('../lib/discordClient');

const registry = new Map(); // botId -> { handle, status, botUserTag, applicationId, lastError }

function startBot(row) {
  stopBot(row.id);
  const entry = { handle: null, status: 'connecting', botUserTag: null, applicationId: null, lastError: null };
  registry.set(row.id, entry);
  try {
    entry.handle = createBotClient({
      botId: row.id,
      token: row.token,
      onMessage: (msg, io) => router.handleMessage(msg, io),
      onInteraction: (cmd, io) => router.handleInteraction(cmd, io),
      onAutocomplete: (cmd) => router.autocompleteOptions(cmd),
      onReady: ({ botUserTag, applicationId }) => {
        entry.status = 'connected';
        entry.botUserTag = botUserTag;
        entry.applicationId = applicationId;
        entry.lastError = null;
        botsModel.update(row.id, { last_error: null });
        console.log(`[discord] bot ${row.name} connected as ${botUserTag}`);
      },
      onError: (err) => {
        entry.lastError = err.message;
        botsModel.update(row.id, { last_error: err.message.slice(0, 500) });
        console.error(`[discord] bot ${row.name}:`, err.message);
      },
    });
    entry.handle.start().catch((err) => {
      entry.status = 'error';
      entry.lastError = err.message;
      botsModel.update(row.id, { last_error: err.message.slice(0, 500) });
      console.error(`[discord] bot ${row.name} login failed:`, err.message);
    });
  } catch (err) {
    entry.status = 'error';
    entry.lastError = err.message;
  }
}

function stopBot(id) {
  const entry = registry.get(id);
  if (entry && entry.handle) { try { entry.handle.stop(); } catch { /* already down */ } }
  registry.delete(id);
}

function restartBot(id) {
  const row = botsModel.findById(id);
  if (row && row.enabled) startBot(row);
  else stopBot(id);
}

function startAll() {
  for (const row of botsModel.listEnabled()) startBot(row);
}

function statusAll() {
  return botsModel.list().map((row) => {
    const entry = registry.get(row.id);
    return {
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      status: !row.enabled ? 'disabled' : (entry ? entry.status : 'error'),
      botUserTag: entry ? entry.botUserTag : null,
      inviteUrl: entry && entry.applicationId
        ? `https://discord.com/oauth2/authorize?client_id=${entry.applicationId}&scope=bot`
        : null,
      lastError: (entry && entry.lastError) || row.last_error || null,
    };
  });
}

module.exports = { startAll, startBot, stopBot, restartBot, statusAll };
