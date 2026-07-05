const { test } = require('node:test');
const assert = require('node:assert');
const { parseRunOutput } = require('../services/opencode.service');

// Shape thật đã verify bằng opencode v1.2.10 (xem plan Global Constraints)
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

test('parseRunOutput empty output', () => {
  const r = parseRunOutput('');
  assert.strictEqual(r.sessionId, null);
  assert.strictEqual(r.text, '');
});
