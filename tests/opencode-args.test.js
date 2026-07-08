const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

process.env.OTB_DB_PATH = ':memory:';
const opencode = require('../services/opencode.service');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

let spawnCalls;
beforeEach(() => { spawnCalls = []; });

function stubSpawn(child) {
  opencode.proc.spawn = (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return child; };
}

function finish(child, sessionId = 'ses_1') {
  child.stdout.emit('data', JSON.stringify({ sessionID: sessionId, type: 'text', part: { text: 'ok' } }) + '\n');
  child.emit('close', 0);
}

test('passes model, variant, agent, files and command flags to opencode run', async () => {
  const child = fakeChild();
  stubSpawn(child);
  const p = opencode.runPrompt({
    dir: '/tmp/ws', text: 'hello', model: 'anthropic/claude-sonnet-5', variant: 'high',
    agent: 'plan', files: ['/tmp/ws/.otb-uploads/1/a.png'], configPath: '/tmp/ws/opencode.admin.json',
  });
  finish(child);
  await p;
  const { args, opts } = spawnCalls[0];
  assert.deepStrictEqual(args.slice(0, 2), ['run', '--format']);
  assert.ok(args.includes('-m') && args[args.indexOf('-m') + 1] === 'anthropic/claude-sonnet-5');
  assert.ok(args.includes('--variant') && args[args.indexOf('--variant') + 1] === 'high');
  assert.ok(args.includes('--agent') && args[args.indexOf('--agent') + 1] === 'plan');
  assert.ok(args.includes('-f') && args[args.indexOf('-f') + 1] === '/tmp/ws/.otb-uploads/1/a.png');
  assert.strictEqual(args[args.length - 1], 'hello');
  assert.strictEqual(opts.env.OPENCODE_CONFIG, '/tmp/ws/opencode.admin.json');
});

test('command flag runs a custom command and omits empty text', async () => {
  const child = fakeChild();
  stubSpawn(child);
  const p = opencode.runPrompt({ dir: '/tmp/ws', text: '', command: 'deploy-check' });
  finish(child);
  await p;
  const { args } = spawnCalls[0];
  assert.ok(args.includes('--command') && args[args.indexOf('--command') + 1] === 'deploy-check');
  assert.notStrictEqual(args[args.length - 1], '');
});

test('cancel kills the child and rejects with stopped error', async () => {
  const child = fakeChild();
  stubSpawn(child);
  const p = opencode.runPrompt({ dir: '/tmp/ws', text: 'long question', cancelKey: 77 });
  assert.strictEqual(opencode.isRunning(77), true);
  assert.strictEqual(opencode.cancel(77), true);
  assert.strictEqual(child.killed, true);
  child.emit('close', 137);
  await assert.rejects(p, (err) => err.stopped === true && /stopped by user/.test(err.message));
  assert.strictEqual(opencode.isRunning(77), false);
  assert.strictEqual(opencode.cancel(77), false);
});

test('a finishing run does not delete a newer run registered under the same cancelKey', async () => {
  const childA = fakeChild();
  const childB = fakeChild();
  let call = 0;
  opencode.proc.spawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    call += 1;
    return call === 1 ? childA : childB;
  };
  const pA = opencode.runPrompt({ dir: '/tmp/ws', text: 'first', cancelKey: 5 });
  const pB = opencode.runPrompt({ dir: '/tmp/ws', text: 'second', cancelKey: 5 });
  // Run A finishes (closes normally) while run B is still registered under
  // the same cancelKey; A's cleanup must not clobber B's registry entry.
  finish(childA, 'ses_a');
  await pA;
  assert.strictEqual(opencode.isRunning(5), true);
  assert.strictEqual(opencode.cancel(5), true);
  assert.strictEqual(childB.killed, true);
  assert.strictEqual(childA.killed, false);
  childB.emit('close', 137);
  await assert.rejects(pB, (err) => err.stopped === true);
});
