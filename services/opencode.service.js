const { spawn } = require('child_process');

const TIMEOUT_MS = 300000;

// Indirection over spawn so tests can stub opencode invocations.
const proc = { spawn };

function emptyUsage() {
  return { tokensInput: null, tokensOutput: null, tokensReasoning: null, costUsd: null };
}

function parseRunOutput(stdout) {
  let sessionId = null;
  const chunks = [];
  let sawUsage = false;
  const usage = { tokensInput: 0, tokensOutput: 0, tokensReasoning: 0, costUsd: 0 };

  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!sessionId && ev.sessionID) sessionId = ev.sessionID;
    if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') chunks.push(ev.part.text);
    if (ev.type === 'step_finish' && ev.part && ev.part.tokens) {
      sawUsage = true;
      usage.tokensInput += ev.part.tokens.input || 0;
      usage.tokensOutput += ev.part.tokens.output || 0;
      usage.tokensReasoning += ev.part.tokens.reasoning || 0;
      usage.costUsd += ev.part.cost || 0;
    }
  }
  return { sessionId, text: chunks.join(''), usage: sawUsage ? usage : emptyUsage() };
}

function runPrompt({ dir, sessionId, text, conversationId }) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--format', 'json'];
    if (sessionId) args.push('-s', sessionId);
    args.push(text);
    // stdin must be ignored; an open pipe makes opencode wait for EOF until timeout.
    // PWD must match cwd: opencode prefers $PWD over process.cwd() when binding
    // the session directory, and spawn() does not update PWD to follow cwd.
    // OTB_CONVERSATION_ID reaches the MCP server through opencode's inherited
    // env so api_calls audit rows can be tied back to the conversation.
    const env = { ...process.env, PWD: dir };
    if (conversationId != null) env.OTB_CONVERSATION_ID = String(conversationId);
    else delete env.OTB_CONVERSATION_ID;
    const child = proc.spawn('opencode', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`opencode timed out after ${TIMEOUT_MS / 60000} minutes`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`opencode exit ${code}: ${stderr.slice(0, 500)}`));
      const parsed = parseRunOutput(stdout);
      if (!parsed.sessionId) return reject(new Error(`Could not parse sessionID from opencode output`));
      resolve(parsed);
    });
  });
}

module.exports = { parseRunOutput, runPrompt, proc };
