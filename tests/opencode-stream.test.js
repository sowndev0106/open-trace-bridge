const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const opencode = require('../services/opencode.service');

function fakeChildDeferred() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test('runPromptStream emits session, tool, and text events as chunks arrive, split mid-line', async () => {
  const events = [];
  const orig = opencode.proc.spawn;
  let child;
  opencode.proc.spawn = () => { child = fakeChildDeferred(); return child; };
  try {
    const promise = opencode.runPromptStream({
      dir: '/tmp/ws/payment', text: 'hi',
      onEvent: (ev) => events.push(ev),
    });
    // Feed output split at arbitrary byte boundaries, including mid-JSON.
    child.stdout.emit('data', '{"type":"text","sessionID":"ses_1","part":{"type":"text","te');
    child.stdout.emit('data', 'xt":"Hello "}}\n{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"call_api","state":{"status":"running"}}}\n');
    child.stdout.emit('data', '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"world"}}\n');
    child.stdout.emit('data', '{"type":"step_finish","part":{"tokens":{"input":10,"output":5,"reasoning":1},"cost":0.01}}\n');
    child.emit('close', 0);
    const result = await promise;

    assert.deepStrictEqual(events[0], { type: 'session', sessionId: 'ses_1' });
    assert.deepStrictEqual(events[1], { type: 'text', text: 'Hello ' });
    assert.deepStrictEqual(events[2], { type: 'tool', name: 'call_api', status: 'running' });
    assert.deepStrictEqual(events[3], { type: 'text', text: 'world' });
    assert.strictEqual(result.text, 'Hello world');
    assert.strictEqual(result.sessionId, 'ses_1');
    assert.deepStrictEqual(result.usage, { tokensInput: 10, tokensOutput: 5, tokensReasoning: 1, costUsd: 0.01 });
  } finally {
    opencode.proc.spawn = orig;
  }
});

test('runPromptStream rejects on nonzero exit and does not require onEvent', async () => {
  const orig = opencode.proc.spawn;
  let child;
  opencode.proc.spawn = () => { child = fakeChildDeferred(); return child; };
  try {
    const promise = opencode.runPromptStream({ dir: '/tmp/ws/payment', text: 'hi' });
    child.stderr.emit('data', 'boom');
    child.emit('close', 1);
    await assert.rejects(promise, /opencode exit 1: boom/);
  } finally {
    opencode.proc.spawn = orig;
  }
});
