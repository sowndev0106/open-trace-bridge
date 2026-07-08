const path = require('path');
const convs = require('../models/conversation.model');
const runs = require('../models/run.model');
const sync = require('./sync.service');
const opencode = require('./opencode.service');
const projectUser = require('./projectUser.service');

// Indirection so tests can stub external effects without touching the DB layer.
const deps = {
  ensureReady: (project) => sync.ensureReady(project),
  ensureProjectUser: (slug) => projectUser.ensureProjectUser(slug),
  ownWorkspace: (ws, user) => projectUser.ownWorkspace(ws, user),
  runPrompt: (opts) => opencode.runPrompt(opts),
};

// Shared Teams/Discord investigation pipeline: workspace sync, per-project OS
// user, one OpenCode session per conversation, run accounting.
// opts: { files, admin, onEvent, command }
async function investigate(project, conv, prompt, opts = {}) {
  const startedAt = Date.now();
  try {
    const ws = await deps.ensureReady(project);
    const runAs = deps.ensureProjectUser(project.slug);
    deps.ownWorkspace(ws, runAs);
    const result = await deps.runPrompt({
      dir: ws,
      sessionId: conv.opencode_session_id,
      text: prompt,
      conversationId: conv.id,
      runAs,
      model: conv.model || undefined,
      agent: conv.agent || undefined,
      command: opts.command,
      files: opts.files,
      configPath: opts.admin ? path.join(ws, 'opencode.admin.json') : undefined,
      cancelKey: conv.id,
      onEvent: opts.onEvent,
    });
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
      status: err.stopped ? 'stopped' : (isTimeout ? 'timeout' : 'error'),
      duration_ms: Date.now() - startedAt,
      error: err.message.slice(0, 1000),
    });
    throw err;
  }
}

module.exports = { investigate, deps };
