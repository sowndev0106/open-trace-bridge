const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const runs = require('../models/run.model');
const { extractPrompt, COMMANDS } = require('../lib/eventGateway');
const sync = require('../services/sync.service');
const opencode = require('../services/opencode.service');
const webhook = require('../services/webhook.service');
const projectUser = require('../services/projectUser.service');

function eventFromRequest(req) {
  if (req.method === 'GET') {
    const q = req.query;
    return {
      text: q.text || '', userId: q.userId || '', userName: q.userName || '',
      conversationId: q.conversationId || '',
    };
  }
  const b = req.body || {};
  return {
    text: (b.raw && b.raw.text) || '', userId: (b.user && b.user.id) || '',
    userName: (b.user && b.user.name) || '',
    conversationId: (b.channel && b.channel.conversationId) || '',
  };
}

async function investigate(project, conv, prompt) {
  const startedAt = Date.now();
  try {
    const ws = await sync.ensureReady(project);
    const runAs = projectUser.ensureProjectUser(project.slug);
    projectUser.ownWorkspace(ws, runAs);
    const result = await opencode.runPrompt({ dir: ws, sessionId: conv.opencode_session_id, text: prompt, conversationId: conv.id, runAs });
    if (!conv.opencode_session_id) convs.setSession(conv.id, result.sessionId);
    const usage = result.usage || {};
    runs.add({
      project_id: project.id, conversation_id: conv.id, status: 'success',
      duration_ms: Date.now() - startedAt,
      tokens_input: usage.tokensInput ?? null, tokens_output: usage.tokensOutput ?? null,
      tokens_reasoning: usage.tokensReasoning ?? null, cost_usd: usage.costUsd ?? null,
    });
    return result.text || '(agent returned no text)';
  } catch (err) {
    const isTimeout = /timeout|timed out/i.test(err.message);
    runs.add({
      project_id: project.id, conversation_id: conv.id,
      status: isTimeout ? 'timeout' : 'error',
      duration_ms: Date.now() - startedAt,
      error: err.message.slice(0, 1000),
    });
    throw err;
  }
}

function guideMarkdown(project) {
  const lines = COMMANDS.map((c) => `- \`${project.keyword} /${c.name}\` — ${c.description}`);
  return [
    `Ask a question with \`${project.keyword} <your question>\` and the agent will investigate.`,
    '',
    '**Commands**',
    ...lines,
  ].join('\n');
}

function ensureConversation(project, ev) {
  let conv = convs.findActive(project.id, ev.conversationId);
  if (!conv) conv = convs.create(project.id, ev.conversationId);
  return conv;
}

function recordInboundAndReply(conv, ev, res, action) {
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: ev.userId, user_name: ev.userName, content: ev.text });
  res.json({ handled: true, action, conversationId: conv.id });
}

function handleEvent(req, res) {
  const project = projects.findBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: `No project found for slug "${req.params.slug}"` });

  const ev = eventFromRequest(req);
  if (!ev.text || !ev.conversationId) {
    return res.status(400).json({ error: 'Missing text or conversationId' });
  }

  const { command, prompt } = extractPrompt(ev.text, project.keyword);

  if (command === 'guide') {
    const conv = ensureConversation(project, ev);
    recordInboundAndReply(conv, ev, res, 'guide');
    const markdown = guideMarkdown(project);
    webhook.sendTeamsMessage(project.teams_webhook_url, {
      status: 'info',
      title: `${project.name} - Available commands`,
      markdown,
      metadata: { project: project.slug },
      maxLength: project.max_msg_length,
    })
      .then(() => messages.add({ conversation_id: conv.id, direction: 'out', content: markdown }))
      .catch((err) => console.error('Webhook fail:', err.message));
    return;
  }

  if (command === 'unknown') {
    const conv = ensureConversation(project, ev);
    recordInboundAndReply(conv, ev, res, 'unknown-command');
    const markdown = `Unrecognized command. Type \`${project.keyword} /guide\` to see available commands.`;
    webhook.sendTeamsMessage(project.teams_webhook_url, {
      status: 'warning',
      title: `${project.name} - Unknown command`,
      markdown,
      metadata: { project: project.slug },
      maxLength: project.max_msg_length,
    })
      .then(() => messages.add({ conversation_id: conv.id, direction: 'out', content: markdown }))
      .catch((err) => console.error('Webhook fail:', err.message));
    return;
  }

  if (command === 'pull-source') {
    const conv = ensureConversation(project, ev);
    messages.add({ conversation_id: conv.id, direction: 'in', user_id: ev.userId, user_name: ev.userName, content: ev.text });
    res.json({ handled: true, action: 'pull-source' });
    sync.syncProject(project.id)
      .then(({ ok, results }) => {
        const lines = results
          .map((r) => `- ${r.git_url}: ${r.status}${r.error ? ` - ${r.error}` : ''}`)
          .join('\n');
        const title = ok ? 'Sources updated to latest' : 'Source sync failed';
        const markdown = lines || 'No repositories configured.';
        messages.add({ conversation_id: conv.id, direction: 'out', content: `${title}\n\n${markdown}` });
        return webhook.sendTeamsMessage(project.teams_webhook_url, {
          status: ok ? 'success' : 'error',
          title,
          markdown,
          metadata: { project: project.slug },
          maxLength: project.max_msg_length,
        });
      })
      .catch((err) => {
        messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
        console.error(`pull-source fail (project=${project.slug}):`, err.message);
      });
    return;
  }

  let conv = convs.findActive(project.id, ev.conversationId);
  if (command === 'new') {
    if (conv) convs.close(conv.id);
    conv = convs.create(project.id, ev.conversationId);
    messages.add({ conversation_id: conv.id, direction: 'in', user_id: ev.userId, user_name: ev.userName, content: ev.text });
    res.json({ handled: true, action: 'new-session', conversationId: conv.id });
    // §4.5 new_session
    webhook.sendTeamsMessage(project.teams_webhook_url, {
      status: 'info',
      title: 'New conversation created',
      markdown: `Project: ${project.name}\n\nThe next questions in this group chat will use a new OpenCode session.`,
      metadata: { project: project.slug },
      maxLength: project.max_msg_length,
    })
      .then(() => messages.add({ conversation_id: conv.id, direction: 'out', content: 'New conversation created' }))
      .catch((err) => console.error('Webhook fail:', err.message));
    return;
  }

  if (!conv) conv = convs.create(project.id, ev.conversationId);
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: ev.userId, user_name: ev.userName, content: ev.text });

  // Acknowledge only through the HTTP response. Do not send chat acknowledgements.
  res.json({ handled: true, action: 'investigating', conversationId: conv.id });

  investigate(project, conv, prompt)
    .then((answer) => {
      messages.add({ conversation_id: conv.id, direction: 'out', content: answer });
      return webhook.sendTeamsMessage(project.teams_webhook_url, {
        status: 'success',
        title: `${project.name} - Result`,
        markdown: answer,
        metadata: { project: project.slug, sessionId: convs.findActive(project.id, ev.conversationId)?.opencode_session_id },
        maxLength: project.max_msg_length,
      });
    })
    .catch((err) => {
      console.error(`Investigation fail (project=${project.slug}):`, err);
      messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
      const isTimeout = /timeout|timed out/i.test(err.message);
      // §4.6 partial_or_timeout / §4.7 error
      const msg = isTimeout ? {
        status: 'warning',
        title: 'Investigation did not finish',
        markdown: `OpenCode ran too long, so the server stopped the job.\n\n**Next suggestion**\nAsk again with a narrower scope, for example: "${project.keyword} continue checking <specific area>".`,
        metadata: { project: project.slug },
        maxLength: project.max_msg_length,
      } : {
        status: 'error',
        title: 'Investigation failed',
        markdown: `**Reason**\n${err.message}\n\n**Suggestion**\nCheck the repository/API configuration in the Admin UI, then try again.`,
        metadata: { project: project.slug },
        maxLength: project.max_msg_length,
      };
      return webhook.sendTeamsMessage(project.teams_webhook_url, msg)
        .catch((e) => console.error('Webhook fail:', e.message));
    });
}

module.exports = { handleEvent };
