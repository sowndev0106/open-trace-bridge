const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const discordChannels = require('../models/discordChannel.model');
const dmUsers = require('../models/discordUser.model');
const fmt = require('../lib/discordFormat');
const investigation = require('./investigation.service');
const sync = require('./sync.service');
const opencode = require('./opencode.service');
const info = require('./opencodeInfo.service');
const attachmentsSvc = require('./discordAttachment.service');

// Stubbable seams for tests; everything else in this file is pure DB logic.
const deps = {
  investigate: (p, c, prompt, opts) => investigation.investigate(p, c, prompt, opts),
  ensureReady: (p) => sync.ensureReady(p),
  syncProject: (id) => sync.syncProject(id),
  opencode,
  info,
  attachments: attachmentsSvc,
};

function externalIdFor(msg) {
  return msg.isDM ? `discord:dm:${msg.botId}:${msg.authorId}` : `discord:${msg.channelId}`;
}

function allowedProjectsFor(user, botId) {
  const bound = projects.list().filter((p) => Number(p.discord_bot_id) === Number(botId));
  if (user.role === 'admin' || user.all_projects) return bound;
  const ids = new Set(dmUsers.listProjectIds(user.id));
  return bound.filter((p) => ids.has(p.id));
}

// null => stay silent. { needsSelection } => allowlisted DM without a project.
function resolveContext(msg) {
  if (msg.isDM) {
    const user = dmUsers.findByDiscordId(msg.authorId);
    if (!user) return null;
    const selectedId = dmUsers.getSelection(user.id, msg.botId);
    const allowed = allowedProjectsFor(user, msg.botId);
    const project = allowed.find((p) => p.id === selectedId) || null;
    if (!project) return { project: null, dmUser: user, needsSelection: true };
    return { project, dmUser: user };
  }
  const ch = discordChannels.findByChannelId(msg.channelId);
  if (!ch) return null;
  const project = projects.findById(ch.project_id);
  if (!project || Number(project.discord_bot_id) !== Number(msg.botId)) return null;
  if (ch.mode === 'mention' && !msg.mentionsBot) return null;
  return { project, dmUser: null };
}

function ensureConversation(project, externalId) {
  return convs.findActive(project.id, externalId) || convs.create(project.id, externalId);
}

async function runAndReply({ project, conv, prompt, files, admin, io }) {
  await io.react(fmt.EMOJI.accepted);
  await io.startTyping();
  try {
    const answer = await deps.investigate(project, convs.findById(conv.id), prompt, { files, admin });
    messages.add({ conversation_id: conv.id, direction: 'out', content: answer });
    const { chunks, file } = fmt.renderAnswer(answer, { maxLength: project.max_msg_length });
    for (const chunk of chunks) await io.reply(chunk);
    if (file) await io.sendFile(file.name, file.content);
    await io.setReaction(fmt.EMOJI.success);
  } catch (err) {
    messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
    const isTimeout = /timeout|timed out/i.test(err.message);
    if (err.stopped) {
      await io.replyEmbed(fmt.statusEmbed({
        status: 'warning', title: 'Investigation stopped',
        description: 'The running investigation was stopped with /stop.', footer: project.slug,
      }));
      await io.setReaction(fmt.EMOJI.stopped);
    } else if (isTimeout) {
      await io.replyEmbed(fmt.statusEmbed({
        status: 'warning', title: 'Investigation did not finish',
        description: 'OpenCode ran too long, so the server stopped the job.\n\nAsk again with a narrower scope.',
        footer: project.slug,
      }));
      await io.setReaction(fmt.EMOJI.timeout);
    } else {
      await io.replyEmbed(fmt.statusEmbed({
        status: 'error', title: 'Investigation failed',
        description: `**Reason**\n${err.message}\n\nCheck the project configuration in the admin UI, then try again.`,
        footer: project.slug,
      }));
      await io.setReaction(fmt.EMOJI.error);
    }
  } finally {
    await io.stopTyping();
  }
}

async function handleMessage(msg, io) {
  if (msg.authorIsBot) return;
  const ctx = resolveContext(msg);
  if (!ctx) return;
  if (ctx.needsSelection) {
    await io.replyEmbed(fmt.statusEmbed({
      status: 'info', title: 'Select a project first',
      description: 'Use `/projects` to list projects you can access, then `/project <slug>` to select one.',
    }));
    return;
  }
  const { project, dmUser } = ctx;
  const prompt = String(msg.content || '').trim();
  const atts = msg.attachments || [];
  if (!prompt && !atts.length) return;

  const conv = ensureConversation(project, externalIdFor(msg));
  let content = prompt;
  if (atts.length) content = [prompt, fmt.attachmentMarkers(atts)].filter(Boolean).join('\n');
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: msg.authorId, user_name: msg.authorName, content });
  convs.touch(conv.id);

  let files;
  if (atts.length) {
    const verdict = deps.attachments.validate(atts);
    if (!verdict.ok) {
      await io.replyEmbed(fmt.statusEmbed({ status: 'warning', title: 'Attachment rejected', description: verdict.reason }));
      return;
    }
    const ws = await deps.ensureReady(project);
    files = await deps.attachments.downloadAll(atts, deps.attachments.uploadDirFor(ws, conv.id), msg.messageId);
  }

  await runAndReply({
    project, conv,
    prompt: prompt || deps.attachments.DEFAULT_ATTACHMENT_PROMPT,
    files,
    admin: Boolean(dmUser && dmUser.role === 'admin'),
    io,
  });
}

module.exports = { deps, externalIdFor, allowedProjectsFor, resolveContext, ensureConversation, runAndReply, handleMessage };
