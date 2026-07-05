const { test } = require('node:test');
const assert = require('node:assert');
const { redact, splitMarkdown, buildCard } = require('../services/teamsFormat');

test('redact masks sensitive patterns', () => {
  const input = [
    'Authorization: Bearer abc.def.ghi',
    'x-api-key: sk-12345',
    'api_key=verysecret',
    'token=tok_abc',
    'password=hunter2',
    'secret=sssh',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const out = redact(input);
  assert.ok(!out.includes('abc.def.ghi'));
  assert.ok(!out.includes('sk-12345'));
  assert.ok(!out.includes('verysecret'));
  assert.ok(!out.includes('tok_abc'));
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('sssh'));
  assert.ok(!out.includes('MIIE'));
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(out.includes('[REDACTED_PRIVATE_KEY]'));
});

test('splitMarkdown returns single chunk when short', () => {
  const chunks = splitMarkdown('hello world', 100);
  assert.deepStrictEqual(chunks, ['hello world']);
});

test('splitMarkdown splits at paragraph boundaries', () => {
  const md = 'para1 aaaa\n\npara2 bbbb\n\npara3 cccc';
  const chunks = splitMarkdown(md, 15);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].includes('para1'));
  for (const c of chunks) assert.ok(c.length <= 15 + 60, `chunk too long: ${c.length}`);
});

test('splitMarkdown never breaks a code fence: closes and reopens with language', () => {
  const codeLines = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`).join('\n');
  const md = 'Mở đầu\n\n```js\n' + codeLines + '\n```\n\nKết thúc';
  const chunks = splitMarkdown(md, 300);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    const fences = (c.match(/```/g) || []).length;
    assert.strictEqual(fences % 2, 0, `unbalanced fence in chunk: ${c}`);
  }
  const middle = chunks.filter((c) => c.includes('[code tiếp'));
  assert.ok(middle.length >= 1, 'phải có marker cắt code');
  const reopened = chunks.filter((c, i) => i > 0 && c.startsWith('```js'));
  assert.ok(reopened.length >= 1, 'chunk sau phải mở lại fence với đúng language');
});

test('buildCard produces adaptive card with title, monospace code, metadata', () => {
  const card = buildCard({
    status: 'success',
    title: 'Payment investigation',
    markdown: 'Tóm tắt ở đây\n\n```js\nconst x = 1;\n```',
    metadata: { project: 'payment', sessionId: 'ses_x' },
    partInfo: { index: 1, total: 2 },
  });
  assert.strictEqual(card.type, 'message');
  const body = card.attachments[0].content.body;
  assert.ok(body[0].text.includes('Payment investigation'));
  assert.ok(body[0].text.includes('(phần 1/2)'));
  const codeBlock = body.find((b) => b.fontType === 'Monospace');
  assert.ok(codeBlock, 'phải có TextBlock Monospace cho code');
  assert.ok(codeBlock.text.includes('const x = 1;'));
  const meta = body[body.length - 1];
  assert.ok(meta.isSubtle);
  assert.ok(meta.text.includes('payment'));
});

test('buildCard status tones', () => {
  for (const [status, mark] of [['success', '✅'], ['warning', '⚠️'], ['error', '❌'], ['info', 'ℹ️']]) {
    const card = buildCard({ status, title: 'T', markdown: 'x', metadata: {} });
    assert.ok(card.attachments[0].content.body[0].text.includes(mark), `${status} cần ${mark}`);
  }
});
