const { test } = require('node:test');
const assert = require('node:assert');
const { parseRunOutput } = require('../services/opencode.service');

// Real shape verified with opencode v1.2.10. See the plan global constraints.
const sample = [
  '{"type":"step_start","timestamp":1,"sessionID":"ses_abc","part":{"type":"step-start"}}',
  '{"type":"text","timestamp":2,"sessionID":"ses_abc","part":{"type":"text","text":"Hello "}}',
  '{"type":"text","timestamp":3,"sessionID":"ses_abc","part":{"type":"text","text":"world"}}',
  '{"type":"step_finish","timestamp":4,"sessionID":"ses_abc","part":{"type":"step-finish","reason":"stop"}}',
  'not-json-line-should-be-ignored',
].join('\n');

test('parseRunOutput extracts sessionId and concatenated text', () => {
  const r = parseRunOutput(sample);
  assert.strictEqual(r.sessionId, 'ses_abc');
  assert.strictEqual(r.text, 'Hello world');
});

test('parseRunOutput returns null usage when step-finish carries no token/cost data', () => {
  const r = parseRunOutput(sample);
  assert.deepStrictEqual(r.usage, { tokensInput: null, tokensOutput: null, tokensReasoning: null, costUsd: null });
});

test('parseRunOutput empty output', () => {
  const r = parseRunOutput('');
  assert.strictEqual(r.sessionId, null);
  assert.strictEqual(r.text, '');
  assert.deepStrictEqual(r.usage, { tokensInput: null, tokensOutput: null, tokensReasoning: null, costUsd: null });
});

// Real 2-step run captured live from `opencode run --format json` (tool call + final answer).
const multiStepSample = [
  '{"type":"step_start","timestamp":1783349878844,"sessionID":"ses_a","part":{"id":"prt_1","sessionID":"ses_a","messageID":"msg_1","type":"step-start"}}',
  '{"type":"tool_use","timestamp":1783349879034,"sessionID":"ses_a","part":{"id":"prt_2","sessionID":"ses_a","messageID":"msg_1","type":"tool","callID":"call_1","tool":"read","state":{"status":"completed","input":{"filePath":"/tmp/note.txt"},"output":"42","title":"note.txt"}}}',
  '{"type":"step_finish","timestamp":1783349879037,"sessionID":"ses_a","part":{"id":"prt_3","sessionID":"ses_a","messageID":"msg_1","type":"step-finish","reason":"tool-calls","cost":0.00367638,"tokens":{"total":12249,"input":12085,"output":36,"reasoning":0,"cache":{"read":128,"write":0}}}}',
  '{"type":"step_start","timestamp":1783349880665,"sessionID":"ses_a","part":{"id":"prt_4","sessionID":"ses_a","messageID":"msg_2","type":"step-start"}}',
  '{"type":"text","timestamp":1783349880666,"sessionID":"ses_a","part":{"id":"prt_5","sessionID":"ses_a","messageID":"msg_2","type":"text","text":"42","time":{"start":1783349880665,"end":1783349880665}}}',
  '{"type":"step_finish","timestamp":1783349880668,"sessionID":"ses_a","part":{"id":"prt_6","sessionID":"ses_a","messageID":"msg_2","type":"step-finish","reason":"stop","cost":0.000777,"tokens":{"total":12312,"input":150,"output":2,"reasoning":0,"cache":{"read":12160,"write":0}}}}',
].join('\n');

test('parseRunOutput sums tokens/cost across multiple step-finish events', () => {
  const r = parseRunOutput(multiStepSample);
  assert.strictEqual(r.sessionId, 'ses_a');
  assert.strictEqual(r.text, '42');
  assert.strictEqual(r.usage.tokensInput, 12085 + 150);
  assert.strictEqual(r.usage.tokensOutput, 36 + 2);
  assert.strictEqual(r.usage.tokensReasoning, 0);
  assert.ok(Math.abs(r.usage.costUsd - (0.00367638 + 0.000777)) < 1e-9);
});
