const { spawn } = require('child_process');

const TIMEOUT_MS = 300000;

function parseRunOutput(stdout) {
  let sessionId = null;
  const chunks = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!sessionId && ev.sessionID) sessionId = ev.sessionID;
    if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') chunks.push(ev.part.text);
  }
  return { sessionId, text: chunks.join('') };
}

function runPrompt({ dir, sessionId, text }) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--format', 'json'];
    if (sessionId) args.push('-s', sessionId);
    args.push(text);
    // stdin must be ignored; an open pipe makes opencode wait for EOF until timeout.
    const child = spawn('opencode', args, { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

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

module.exports = { parseRunOutput, runPrompt };
