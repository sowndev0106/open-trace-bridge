const { test } = require('node:test');
const assert = require('node:assert');
const { extractPrompt, stripHtml, validateEvent } = require('../lib/eventGateway');

test('stripHtml removes tags', () => {
  assert.strictEqual(stripHtml('<p>payment-bot hi</p>'), 'payment-bot hi');
});

test('extractPrompt strips keyword prefix case-insensitively', () => {
  const r = extractPrompt('<p>Payment-Bot hi tìm hiểu lỗi txn_123</p>', 'payment-bot');
  assert.strictEqual(r.isNew, false);
  assert.strictEqual(r.prompt, 'hi tìm hiểu lỗi txn_123');
});

test('extractPrompt keeps text when keyword absent or mid-sentence', () => {
  assert.strictEqual(extractPrompt('hi payment-bot oi', 'payment-bot').prompt, 'hi payment-bot oi');
});

test('extractPrompt detects /new after keyword', () => {
  const r = extractPrompt('payment-bot /new', 'payment-bot');
  assert.strictEqual(r.isNew, true);
});

test('extractPrompt with empty keyword just strips html', () => {
  assert.strictEqual(extractPrompt('<p>hello</p>', '').prompt, 'hello');
});

test('validateEvent still works', () => {
  assert.strictEqual(validateEvent({ raw: { text: 'x' }, user: {}, channel: {} }), null);
  assert.ok(validateEvent({}));
});
