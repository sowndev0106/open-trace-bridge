const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const runs = require('../models/run.model');
const sync = require('../services/sync.service');
const opencode = require('../services/opencode.service');

// Synthetic channel id marking admin-UI chats in the conversations table.
const ADMIN_CHANNEL = 'admin-ui';

// Project ids with a chat run in flight. One run per project at a time.
const activeRuns = new Set();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chatPage(req, res) {
  const project = projects.findById(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const conv = convs.findActive(project.id, ADMIN_CHANNEL);
  res.render('projects/chat', {
    project,
    chatMessages: conv ? messages.listByConversation(conv.id) : [],
    busy: activeRuns.has(project.id),
  });
}

async function postMessage(req, res) {
  const project = projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (activeRuns.has(project.id)) return res.status(409).json({ error: 'busy' });
  activeRuns.add(project.id);

  let conv = convs.findActive(project.id, ADMIN_CHANNEL);
  if (!conv) conv = convs.create(project.id, ADMIN_CHANNEL);
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: 'admin', user_name: 'Admin', content: text });

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (res.flushHeaders) res.flushHeaders();

  const startedAt = Date.now();
  try {
    const ws = await sync.ensureReady(project);
    const result = await opencode.runPromptStream({
      dir: ws, sessionId: conv.opencode_session_id, text, conversationId: conv.id,
      onEvent: (ev) => {
        if (ev.type === 'tool') sseSend(res, 'tool', { name: ev.name, status: ev.status });
        if (ev.type === 'text') sseSend(res, 'text', { text: ev.text });
      },
    });
    if (!conv.opencode_session_id) convs.setSession(conv.id, result.sessionId);
    const replyText = result.text || '(agent returned no text)';
    messages.add({ conversation_id: conv.id, direction: 'out', content: replyText });
    const usage = result.usage || {};
    const durationMs = Date.now() - startedAt;
    runs.add({
      project_id: project.id, conversation_id: conv.id, status: 'success',
      duration_ms: durationMs,
      tokens_input: usage.tokensInput ?? null, tokens_output: usage.tokensOutput ?? null,
      tokens_reasoning: usage.tokensReasoning ?? null, cost_usd: usage.costUsd ?? null,
    });
    sseSend(res, 'done', { text: replyText, durationMs, usage });
  } catch (err) {
    const isTimeout = /timeout|timed out/i.test(err.message);
    runs.add({
      project_id: project.id, conversation_id: conv.id,
      status: isTimeout ? 'timeout' : 'error',
      duration_ms: Date.now() - startedAt,
      error: err.message.slice(0, 1000),
    });
    messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
    sseSend(res, 'error', { message: err.message });
  } finally {
    // The run persists even if the browser disconnected mid-stream; the lock
    // is always released here.
    activeRuns.delete(project.id);
    res.end();
  }
}

function opencodePage(req, res) {
  const project = projects.findById(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  res.render('projects/opencode', {
    project,
    opencodeUiPort: Number(process.env.OPENCODE_UI_PORT || 8668),
  });
}

function newConversation(req, res) {
  const project = projects.findById(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const conv = convs.findActive(project.id, ADMIN_CHANNEL);
  if (conv) convs.close(conv.id);
  res.redirect(`/admin/projects/${project.id}/chat`);
}

module.exports = { chatPage, postMessage, newConversation, opencodePage, ADMIN_CHANNEL };
