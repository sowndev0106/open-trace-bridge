const { spawn } = require('child_process');

const TIMEOUT_MS = 300000;

// Indirection over spawn so tests can stub opencode invocations.
const proc = { spawn };

// Running children keyed by cancelKey (conversation id) so /stop can kill them.
const running = new Map();

function cancel(cancelKey) {
  const entry = running.get(cancelKey);
  if (!entry) return false;
  entry.stopped = true;
  entry.child.kill('SIGKILL');
  return true;
}
function isRunning(cancelKey) { return running.has(cancelKey); }

function emptyUsage() {
  return { tokensInput: null, tokensOutput: null, tokensReasoning: null, costUsd: null };
}

// Incremental parser over opencode's JSON-lines output. push() consumes raw
// chunks (which may split lines arbitrarily); finish() flushes and returns
// the aggregate result. parseRunOutput and runPromptStream share this.
function createStreamParser(onEvent = () => {}) {
  let buffer = '';
  let sessionId = null;
  const chunks = [];
  let sawUsage = false;
  const usage = { tokensInput: 0, tokensOutput: 0, tokensReasoning: 0, costUsd: 0 };

  function handleLine(line) {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!sessionId && ev.sessionID) {
      sessionId = ev.sessionID;
      onEvent({ type: 'session', sessionId });
    }
    if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
      chunks.push(ev.part.text);
      onEvent({ type: 'text', text: ev.part.text });
    }
    if (ev.part && ev.part.type === 'tool' && ev.part.tool) {
      onEvent({ type: 'tool', name: ev.part.tool, status: (ev.part.state && ev.part.state.status) || '' });
    }
    if (ev.type === 'step_finish' && ev.part && ev.part.tokens) {
      sawUsage = true;
      usage.tokensInput += ev.part.tokens.input || 0;
      usage.tokensOutput += ev.part.tokens.output || 0;
      usage.tokensReasoning += ev.part.tokens.reasoning || 0;
      usage.costUsd += ev.part.cost || 0;
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    },
    finish() {
      if (buffer) handleLine(buffer);
      buffer = '';
      return { sessionId, text: chunks.join(''), usage: sawUsage ? usage : emptyUsage() };
    },
  };
}

function parseRunOutput(stdout) {
  const parser = createStreamParser();
  parser.push(String(stdout));
  return parser.finish();
}

function runPromptStream({ dir, sessionId, text, conversationId, onEvent, runAs, model, variant, agent, command, files, configPath, cancelKey }) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--format', 'json'];
    if (sessionId) args.push('-s', sessionId);
    if (model) args.push('-m', model);
    if (variant) args.push('--variant', variant);
    if (agent) args.push('--agent', agent);
    if (command) args.push('--command', command);
    for (const f of files || []) args.push('-f', f);
    if (text) args.push(text);
    // stdin must be ignored; an open pipe makes opencode wait for EOF until timeout.
    // PWD must match cwd: opencode prefers $PWD over process.cwd() when binding
    // the session directory, and spawn() does not update PWD to follow cwd.
    // OTB_CONVERSATION_ID reaches the MCP server through opencode's inherited
    // env so api_calls audit rows can be tied back to the conversation.
    const env = { ...process.env, PWD: dir };
    if (conversationId != null) env.OTB_CONVERSATION_ID = String(conversationId);
    else delete env.OTB_CONVERSATION_ID;
    if (configPath) env.OPENCODE_CONFIG = configPath;
    const spawnOpts = { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] };
    // Drop privileges to the per-project OS user so the kernel blocks reads
    // outside this project's workspace (see projectUser.service).
    if (runAs) {
      spawnOpts.uid = runAs.uid;
      spawnOpts.gid = runAs.gid;
      env.HOME = runAs.home;
      env.USER = runAs.name;
      delete env.XDG_DATA_HOME;
      delete env.XDG_CONFIG_HOME;
    }
    const child = proc.spawn('opencode', args, spawnOpts);

    const entry = { child, stopped: false };
    if (cancelKey != null) running.set(cancelKey, entry);
    const done = () => { if (cancelKey != null) running.delete(cancelKey); };

    const parser = createStreamParser(onEvent);
    let stderr = '';
    const timer = setTimeout(() => {
      done();
      child.kill('SIGKILL');
      reject(new Error(`opencode timed out after ${TIMEOUT_MS / 60000} minutes`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => parser.push(String(d)));
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { done(); clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      done();
      clearTimeout(timer);
      if (entry.stopped) {
        const err = new Error('stopped by user');
        err.stopped = true;
        return reject(err);
      }
      if (code !== 0) return reject(new Error(`opencode exit ${code}: ${stderr.slice(0, 500)}`));
      const parsed = parser.finish();
      if (!parsed.sessionId) return reject(new Error(`Could not parse sessionID from opencode output`));
      resolve(parsed);
    });
  });
}

function runPrompt(opts) {
  return runPromptStream(opts);
}

module.exports = { parseRunOutput, runPrompt, runPromptStream, proc, cancel, isRunning };
