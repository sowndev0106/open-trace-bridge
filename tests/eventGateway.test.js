const { test } = require('node:test');
const assert = require('node:assert');
const { extractPrompt, stripHtml, validateEvent, COMMANDS } = require('../lib/eventGateway');

test('stripHtml removes tags', () => {
  assert.strictEqual(stripHtml('<p>payment-bot hi</p>'), 'payment-bot hi');
});

test('extractPrompt strips keyword prefix case-insensitively', () => {
  const r = extractPrompt('<p>Payment-Bot investigate failure txn_123</p>', 'payment-bot');
  assert.strictEqual(r.command, null);
  assert.strictEqual(r.prompt, 'investigate failure txn_123');
});

test('extractPrompt keeps text when keyword absent or mid-sentence', () => {
  assert.strictEqual(extractPrompt('hi payment-bot oi', 'payment-bot').prompt, 'hi payment-bot oi');
  assert.strictEqual(extractPrompt('hi payment-bot oi', 'payment-bot').command, null);
});

test('extractPrompt detects /new after keyword', () => {
  const r = extractPrompt('payment-bot /new', 'payment-bot');
  assert.strictEqual(r.command, 'new');
});

test('extractPrompt with empty keyword just strips html', () => {
  const r = extractPrompt('<p>hello</p>', '');
  assert.strictEqual(r.prompt, 'hello');
  assert.strictEqual(r.command, null);
});

test('validateEvent still works', () => {
  assert.strictEqual(validateEvent({ raw: { text: 'x' }, user: {}, channel: {} }), null);
  assert.ok(validateEvent({}));
});

test('extractPrompt detects /pull-source after keyword', () => {
  const r = extractPrompt('payment-bot /pull-source', 'payment-bot');
  assert.strictEqual(r.command, 'pull-source');
});

test('extractPrompt does not flag /pull-source mid-sentence or as prefix of another word', () => {
  assert.strictEqual(extractPrompt('please run /pull-source', '').command, null);
  assert.strictEqual(extractPrompt('/pull-sourcex', '').command, 'unknown');
  assert.strictEqual(extractPrompt('/pull-source now', '').command, 'pull-source');
});

test('extractPrompt detects /guide', () => {
  const r = extractPrompt('payment-bot /guide', 'payment-bot');
  assert.strictEqual(r.command, 'guide');
});

test('extractPrompt returns unknown for an unrecognized slash command', () => {
  const r = extractPrompt('payment-bot /doesnotexist please', 'payment-bot');
  assert.strictEqual(r.command, 'unknown');
  assert.strictEqual(r.prompt, '/doesnotexist please');
});

test('extractPrompt returns null command for a plain question', () => {
  const r = extractPrompt('payment-bot why did it fail?', 'payment-bot');
  assert.strictEqual(r.command, null);
  assert.strictEqual(r.prompt, 'why did it fail?');
});

test('COMMANDS lists every known command with a name and description', () => {
  const names = COMMANDS.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['guide', 'new', 'pull-source'].sort());
  for (const c of COMMANDS) {
    assert.strictEqual(typeof c.name, 'string');
    assert.ok(c.description.length > 0);
  }
});
