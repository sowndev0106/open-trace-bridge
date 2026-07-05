const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const opencode = require('../services/opencode.service');

// opencode resolves the session directory from $PWD before process.cwd(), so
// the spawn env must carry PWD matching cwd or sessions bind to the server's
// own directory (/app in Docker) instead of the project workspace.
function fakeChild(stdoutLine) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    child.stdout.emit('data', stdoutLine);
    child.emit('close', 0);
  });
  return child;
}

test('runPrompt spawns opencode with cwd and PWD both set to the workspace dir', async () => {
  const calls = [];
  const orig = opencode.proc.spawn;
  opencode.proc.spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild('{"type":"text","sessionID":"ses_x","part":{"type":"text","text":"ok"}}\n');
  };
  try {
    const r = await opencode.runPrompt({ dir: '/tmp/ws/payment', text: 'hi' });
    assert.strictEqual(r.sessionId, 'ses_x');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.cwd, '/tmp/ws/payment');
    assert.strictEqual(calls[0].opts.env.PWD, '/tmp/ws/payment');
  } finally {
    opencode.proc.spawn = orig;
  }
});
