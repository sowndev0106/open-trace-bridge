// Thin adapter over discord.js: maps gateway objects to the plain shapes the
// router understands and implements the io side effects (reply, react,
// typing). Everything above this file is testable without a network.
const { COMMAND_DEFS } = require('./discordCommands');

const TYPING_REFRESH_MS = () => Number(process.env.DISCORD_TYPING_REFRESH_MS || 8000);

function mapMessage(message, botUser, botId) {
  const mentionsBot = Boolean(message.mentions && message.mentions.users && message.mentions.users.has(botUser.id));
  const content = String(message.content || '')
    .replace(new RegExp(`<@!?${botUser.id}>`, 'g'), '')
    .trim();
  return {
    botId,
    channelId: message.channelId,
    isDM: !message.guildId,
    authorId: message.author.id,
    authorName: message.author.username,
    authorIsBot: Boolean(message.author.bot),
    mentionsBot,
    content,
    attachments: [...(message.attachments ? message.attachments.values() : [])].map((a) => ({
      name: a.name, url: a.url, size: a.size, contentType: a.contentType,
    })),
    messageId: message.id,
  };
}

function mapInteraction(interaction, botId) {
  const options = {};
  for (const o of (interaction.options && interaction.options.data) || []) options[o.name] = o.value;
  return {
    name: interaction.commandName,
    options,
    botId,
    channelId: interaction.channelId,
    isDM: !interaction.guildId,
    userId: interaction.user.id,
    userName: interaction.user.username,
  };
}

function messageIo(message) {
  let typingTimer = null;
  let lastReaction = null;
  return {
    reply: (text) => message.reply({ content: text, allowedMentions: { repliedUser: false } }),
    replyEmbed: (embed) => message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }),
    sendFile: (name, content) => message.channel.send({ files: [{ attachment: Buffer.from(content, 'utf8'), name }] }),
    react: async (emoji) => { lastReaction = await message.react(emoji); },
    setReaction: async (emoji) => {
      try { if (lastReaction) await lastReaction.remove(); } catch { /* missing perms — leave it */ }
      lastReaction = await message.react(emoji);
    },
    startTyping: async () => {
      await message.channel.sendTyping().catch(() => {});
      typingTimer = setInterval(() => message.channel.sendTyping().catch(() => {}), TYPING_REFRESH_MS());
    },
    stopTyping: async () => { if (typingTimer) clearInterval(typingTimer); typingTimer = null; },
  };
}

function interactionIo(interaction) {
  return {
    respond: (text) => interaction.editReply({ content: text }).catch(() => interaction.channel.send({ content: text })),
    respondEmbed: (embed) => interaction.editReply({ embeds: [embed] }).catch(() => interaction.channel.send({ embeds: [embed] })),
    followUp: (text) => interaction.followUp({ content: text }).catch(() => interaction.channel.send({ content: text })),
    sendFile: (name, content) => interaction.followUp({ files: [{ attachment: Buffer.from(content, 'utf8'), name }] })
      .catch(() => interaction.channel.send({ files: [{ attachment: Buffer.from(content, 'utf8'), name }] })),
  };
}

function createBotClient({ botId, token, onMessage, onInteraction, onAutocomplete, onReady, onError }) {
  // Lazy-require so unit tests never load the gateway stack.
  const { Client, GatewayIntentBits, Partials } = require('discord.js');

  let client = null;
  let readyFired = false;

  function buildClient(intents) {
    const c = new Client({
      intents,
      partials: [Partials.Channel], // required to receive DMs
    });

    const onGatewayReady = async () => {
      if (readyFired) return;
      readyFired = true;
      try { await c.application.commands.set(COMMAND_DEFS); } catch (err) { onError(err); }
      onReady({ botUserTag: c.user.tag, applicationId: c.application.id });
    };
    c.on('ready', onGatewayReady);
    c.on('clientReady', onGatewayReady);

    c.on('messageCreate', async (message) => {
      try {
        if (message.partial) await message.fetch();
        await onMessage(mapMessage(message, c.user, botId), messageIo(message));
      } catch (err) { onError(err); }
    });

    c.on('interactionCreate', async (interaction) => {
      try {
        if (interaction.isAutocomplete && interaction.isAutocomplete()) {
          const focused = interaction.options.getFocused(true);
          const choices = await onAutocomplete({
            ...mapInteraction(interaction, botId), focused: focused.name, partial: focused.value,
          });
          return interaction.respond(choices);
        }
        if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
          await interaction.deferReply();
          return onInteraction(mapInteraction(interaction, botId), interactionIo(interaction));
        }
      } catch (err) { onError(err); }
      return undefined;
    });

    c.on('error', (err) => {
      const isDisallowed = err.code === 'DisallowedIntents' ||
        (err.message && err.message.toLowerCase().includes('disallowed intent')) ||
        (err.message && err.message.toLowerCase().includes('disallowed intents'));
      if (isDisallowed && intents.includes(GatewayIntentBits.MessageContent)) {
        // Ignore, handled by the login catch block
        return;
      }
      onError(err);
    });

    return c;
  }

  const intentsWithContent = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ];

  const intentsWithoutContent = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ];

  client = buildClient(intentsWithContent);

  return {
    start: async () => {
      try {
        await client.login(token);
      } catch (err) {
        const isDisallowed = err.code === 'DisallowedIntents' ||
          (err.message && err.message.toLowerCase().includes('disallowed intent')) ||
          (err.message && err.message.toLowerCase().includes('disallowed intents'));
        if (isDisallowed) {
          console.warn(`[discord] bot ${botId} login failed due to disallowed intents. Retrying without MessageContent intent...`);
          try {
            client.destroy();
          } catch {
            // ignore
          }
          client = buildClient(intentsWithoutContent);
          await client.login(token);
        } else {
          throw err;
        }
      }
    },
    stop: () => {
      if (client) {
        client.destroy();
      }
    },
    getClient: () => client,
  };
}

module.exports = { mapMessage, mapInteraction, messageIo, interactionIo, createBotClient };
