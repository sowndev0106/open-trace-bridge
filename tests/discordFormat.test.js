const { test } = require('node:test');
const assert = require('node:assert');
const fmt = require('../lib/discordFormat');

test('renderAnswer chunks at 2000 chars without breaking code fences', () => {
  const code = '```js\n' + 'x = 1;\n'.repeat(500) + '```';
  const { chunks, file } = fmt.renderAnswer(code, { maxLength: 20000, fileThreshold: 100000 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 2000, `chunk too long: ${c.length}`);
    const fences = (c.match(/```/g) || []).length;
    assert.strictEqual(fences % 2, 0, 'unbalanced code fence in chunk');
  }
  assert.strictEqual(file, null);
});

test('renderAnswer attaches answer.md above the file threshold', () => {
  const long = 'word '.repeat(2000); // 10,000 chars
  const { chunks, file } = fmt.renderAnswer(long, { maxLength: 20000, fileThreshold: 6000 });
  assert.strictEqual(chunks.length, 1);
  assert.match(chunks[0], /full answer attached/);
  assert.strictEqual(file.name, 'answer.md');
  assert.ok(file.content.length >= 9000);
});

test('renderAnswer respects project maxLength before chunking', () => {
  const long = 'a'.repeat(5000);
  const { chunks } = fmt.renderAnswer(long, { maxLength: 100, fileThreshold: 6000 });
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].length <= 110);
});

test('statusEmbed maps status to color and slices limits', () => {
  const e = fmt.statusEmbed({ status: 'error', title: 't'.repeat(300), description: 'd'.repeat(5000), footer: 'f' });
  assert.strictEqual(e.color, fmt.COLORS.error);
  assert.strictEqual(e.title.length, 256);
  assert.strictEqual(e.description.length, 4096);
  assert.deepStrictEqual(e.footer, { text: 'f' });
  const i = fmt.statusEmbed({ status: 'nope', title: 'x', description: 'y' });
  assert.strictEqual(i.color, fmt.COLORS.info);
  assert.strictEqual(i.footer, undefined);
});

test('attachmentMarkers renders one marker per file', () => {
  assert.strictEqual(
    fmt.attachmentMarkers([{ name: 'a.png' }, { name: 'b.log' }]),
    '[attachment: a.png]\n[attachment: b.log]'
  );
});
