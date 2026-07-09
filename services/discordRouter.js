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

const runsModel = require('../models/run.model');
const repos = require('../models/repo.model');

const GUIDE_TEXT = [
  '**Ask a question**: mention the bot (or just type, in `all` channels / DMs) — or use `/ask`.',
  '',
  '**Commands**',
  '- `/ask <question>` — run an investigation',
  '- `/new` — start a fresh conversation and OpenCode session',
  '- `/stop` — cancel the running investigation',
  '- `/status` — project, session, model, run state',
  '- `/model [name] [variant]` — show or set the model for this conversation',
  '- `/agent [name]` — show or set the agent',
  '- `/skills` — list workspace skills',
  '- `/commands` — list custom workspace commands',
  '- `/cmd <name> [args]` — run a custom workspace command',
  '- `/stats` — token and cost totals',
  '- `/sync` — re-pull project sources',
  '- `/projects`, `/project <slug>` — (DM) list / select your project',
].join('\n');

// Interactions carry no message to react to; context resolution mirrors
// handleMessage but ignores channel mode (slash commands always answer).
function resolveInteractionContext(cmd) {
  if (cmd.isDM) {
    const user = dmUsers.findByDiscordId(cmd.userId);
    if (!user) return { refuse: 'You are not authorized to use this bot in DMs.' };
    const selectedId = dmUsers.getSelection(user.id, cmd.botId);
    const allowed = allowedProjectsFor(user, cmd.botId);
    const project = allowed.find((p) => p.id === selectedId) || null;
    return { project, dmUser: user, allowed };
  }
  const ch = discordChannels.findByChannelId(cmd.channelId);
  const project = ch ? projects.findById(ch.project_id) : null;
  if (!project || Number(project.discord_bot_id) !== Number(cmd.botId)) {
    return { refuse: 'This channel is not configured for any project.' };
  }
  return { project, dmUser: null };
}

function requireProject(ctx) {
  if (ctx.refuse) return { embed: fmt.statusEmbed({ status: 'warning', title: 'Not available here', description: ctx.refuse }) };
  if (!ctx.project) {
    return { embed: fmt.statusEmbed({
      status: 'info', title: 'Select a project first',
      description: 'Use `/projects` to list projects you can access, then `/project <slug>` to select one.',
    }) };
  }
  return null;
}

function interactionExternalId(cmd) {
  return cmd.isDM ? `discord:dm:${cmd.botId}:${cmd.userId}` : `discord:${cmd.channelId}`;
}

async function handleInteraction(cmd, io) {
  const ctx = resolveInteractionContext(cmd);

  if (cmd.name === 'guide') {
    return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'How to use this bot', description: GUIDE_TEXT }));
  }

  if (cmd.name === 'projects') {
    if (!cmd.isDM) {
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'DM only', description: 'Use `/projects` in a DM with the bot.' }));
    }
    if (ctx.refuse) return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Not authorized', description: ctx.refuse }));
    const lines = ctx.allowed.map((p) => `- \`${p.slug}\` — ${p.name}`).join('\n') || '(none)';
    return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'Your projects', description: lines }));
  }

  if (cmd.name === 'project') {
    if (!cmd.isDM) {
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'DM only', description: 'Use `/project` in a DM with the bot.' }));
    }
    if (ctx.refuse) return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Not authorized', description: ctx.refuse }));
    const slug = String(cmd.options.slug || '').trim();
    const target = ctx.allowed.find((p) => p.slug === slug);
    if (!target) {
      return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Unknown project', description: `Project \`${slug}\` was not found or is not allowed for you.` }));
    }
    dmUsers.setSelection(ctx.dmUser.id, cmd.botId, target.id);
    return io.respondEmbed(fmt.statusEmbed({ status: 'success', title: 'Project selected', description: `Now chatting with **${target.name}** (\`${target.slug}\`).` }));
  }

  const missing = requireProject(ctx);
  if (missing) return io.respondEmbed(missing.embed);
  const { project, dmUser } = ctx;
  const externalId = interactionExternalId(cmd);

  switch (cmd.name) {
    case 'new': {
      const active = convs.findActive(project.id, externalId);
      if (active) convs.close(active.id);
      convs.create(project.id, externalId);
      return io.respondEmbed(fmt.statusEmbed({
        status: 'info', title: 'New conversation created',
        description: `Project: ${project.name}\n\nThe next questions here will use a new OpenCode session.`,
        footer: project.slug,
      }));
    }
    case 'stop': {
      const active = convs.findActive(project.id, externalId);
      const cancelled = active ? deps.opencode.cancel(active.id) : false;
      return io.respondEmbed(fmt.statusEmbed({
        status: cancelled ? 'success' : 'info',
        title: cancelled ? 'Investigation stopped' : 'Nothing to stop',
        description: cancelled ? 'The running investigation was cancelled.' : 'There is no running investigation for this conversation.',
      }));
    }
    case 'status': {
      const active = convs.findActive(project.id, externalId);
      const model = (active && active.model) || deps.info.defaultModel() || '(opencode default)';
      const agent = (active && active.agent) || '(default)';
      const running = deps.opencode.isRunning(active && active.id);
      const repoRows = repos.listByProject(project.id);
      const lastSync = repoRows.map((r) => r.synced_at).filter(Boolean).sort().pop() || 'never';
      const lines = [
        `**Project**: ${project.name} (\`${project.slug}\`)`,
        `**Conversation**: ${active ? `#${active.id}` : 'none yet'}`,
        `**Session**: ${active && active.opencode_session_id ? active.opencode_session_id : 'not started'}`,
        `**Model**: ${model}`,
        `**Agent**: ${agent}`,
        `**State**: ${running ? 'running an investigation' : 'idle'}`,
        `**Last source sync**: ${lastSync}`,
      ];
      if (dmUser) lines.push(`**Your role**: ${dmUser.role}`);
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'Status', description: lines.join('\n'), footer: project.slug }));
    }
    case 'model': {
      const name = String(cmd.options.name || '').trim();
      const conv = ensureConversation(project, externalId);
      if (!name) {
        const models = await deps.info.allowedModels(await deps.ensureReady(project));
        const current = conv.model || deps.info.defaultModel() || '(opencode default)';
        return io.respondEmbed(fmt.statusEmbed({
          status: 'info', title: 'Model',
          description: `**Current**: ${current}\n\n**Allowed**\n${models.map((m) => `- \`${m}\``).join('\n') || '(none)'}`,
        }));
      }
      const models = await deps.info.allowedModels(await deps.ensureReady(project));
      if (!models.includes(name)) {
        return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Model not allowed', description: `\`${name}\` is not in the allowed list. Use \`/model\` to see it.` }));
      }
      convs.setOverrides(conv.id, { model: name, agent: conv.agent });
      const variant = String(cmd.options.variant || '').trim();
      return io.respondEmbed(fmt.statusEmbed({
        status: 'success', title: 'Model set',
        description: `This conversation now uses \`${name}\`${variant ? ` (variant: ${variant})` : ''}. \`/new\` resets it.`,
      }));
    }
    case 'agent': {
      const name = String(cmd.options.name || '').trim();
      const conv = ensureConversation(project, externalId);
      if (!name) {
        const agents = await deps.info.listAgents(await deps.ensureReady(project));
        return io.respondEmbed(fmt.statusEmbed({
          status: 'info', title: 'Agents',
          description: agents.map((a) => `- \`${a}\``).join('\n') || '(none found)',
        }));
      }
      convs.setOverrides(conv.id, { model: conv.model, agent: name });
      return io.respondEmbed(fmt.statusEmbed({ status: 'success', title: 'Agent set', description: `This conversation now uses agent \`${name}\`. \`/new\` resets it.` }));
    }
    case 'skills': {
      const ws = await deps.ensureReady(project);
      const skills = deps.info.listSkills(ws);
      const lines = skills.map((s) => `- **${s.name}** — ${s.description || '(no description)'}`).join('\n');
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'Workspace skills', description: lines || '(no skills found)' }));
    }
    case 'commands': {
      const ws = await deps.ensureReady(project);
      const cmds = deps.info.listCommands(ws);
      const lines = cmds.map((c) => `- **${c.name}** — ${c.description || '(no description)'}`).join('\n');
      return io.respondEmbed(fmt.statusEmbed({ status: 'info', title: 'Workspace commands', description: lines || '(no custom commands found)' }));
    }
    case 'stats': {
      const active = convs.findActive(project.id, externalId);
      const conv = active ? runsModel.statsForConversation(active.id) : { runs: 0, tokens_input: 0, tokens_output: 0, cost_usd: 0 };
      const proj = runsModel.totalsForProject(project.id);
      const fmtRow = (s) => `${s.runs} runs · in ${s.tokens_input} / out ${s.tokens_output} tokens · $${Number(s.cost_usd).toFixed(4)}`;
      return io.respondEmbed(fmt.statusEmbed({
        status: 'info', title: 'Usage stats',
        description: `**This conversation**: ${fmtRow(conv)}\n**Project total**: ${fmtRow(proj)}`,
        footer: project.slug,
      }));
    }
    case 'sync': {
      const { ok, results } = await deps.syncProject(project.id);
      const lines = results.map((r) => `- ${r.git_url}: ${r.status}${r.error ? ` - ${r.error}` : ''}`).join('\n');
      return io.respondEmbed(fmt.statusEmbed({
        status: ok ? 'success' : 'error',
        title: ok ? 'Sources updated to latest' : 'Source sync failed',
        description: lines || 'No repositories configured.',
        footer: project.slug,
      }));
    }
    case 'ask':
    case 'cmd': {
      const conv = ensureConversation(project, externalId);
      const prompt = String(cmd.name === 'ask' ? cmd.options.question : (cmd.options.args || '')).trim();
      const opts = { admin: Boolean(dmUser && dmUser.role === 'admin') };
      if (cmd.name === 'cmd') opts.command = String(cmd.options.name || '').trim();
      messages.add({ conversation_id: conv.id, direction: 'in', user_id: cmd.userId, user_name: cmd.userName, content: cmd.name === 'cmd' ? `/cmd ${opts.command} ${prompt}` : prompt });
      convs.touch(conv.id);
      try {
        const answer = await deps.investigate(project, convs.findById(conv.id), prompt, opts);
        messages.add({ conversation_id: conv.id, direction: 'out', content: answer });
        const { chunks, file } = fmt.renderAnswer(answer, { maxLength: project.max_msg_length });
        await io.respond(chunks[0]);
        for (const extra of chunks.slice(1)) await io.followUp(extra);
        if (file) await io.sendFile(file.name, file.content);
      } catch (err) {
        messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
        await io.respondEmbed(fmt.statusEmbed({ status: 'error', title: 'Investigation failed', description: err.message, footer: project.slug }));
      }
      return undefined;
    }
    default:
      return io.respondEmbed(fmt.statusEmbed({ status: 'warning', title: 'Unknown command', description: `Command \`/${cmd.name}\` is not implemented.` }));
  }
}

async function autocompleteOptions(cmd) {
  const prefix = String(cmd.partial || '').toLowerCase();
  const toChoices = (values) => values
    .filter((v) => v.toLowerCase().startsWith(prefix))
    .slice(0, 25)
    .map((v) => ({ name: v, value: v }));

  if (cmd.focused === 'slug') {
    const user = dmUsers.findByDiscordId(cmd.userId);
    if (!user) return [];
    return toChoices(allowedProjectsFor(user, cmd.botId).map((p) => p.slug));
  }
  const ctx = resolveInteractionContext(cmd);
  if (ctx.refuse || !ctx.project) return [];
  const ws = await deps.ensureReady(ctx.project);
  if (cmd.focused === 'model') return toChoices(await deps.info.allowedModels(ws));
  if (cmd.focused === 'agent') return toChoices(await deps.info.listAgents(ws));
  return [];
}

module.exports = {
  deps, externalIdFor, allowedProjectsFor, resolveContext, ensureConversation, runAndReply, handleMessage,
  handleInteraction, autocompleteOptions, GUIDE_TEXT,
};
