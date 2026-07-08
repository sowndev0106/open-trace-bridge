const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const att = require('../services/discordAttachment.service');

const png = { name: 'shot.png', url: 'https://cdn/x.png', size: 1024, contentType: 'image/png' };

test('validate rejects too many, too large, and disallowed types', () => {
  assert.deepStrictEqual(att.validate([png]), { ok: true });
  const six = Array(6).fill(png);
  assert.match(att.validate(six).reason, /at most 5/i);
  const big = { ...png, size: 21 * 1024 * 1024 };
  assert.match(att.validate([big]).reason, /20 MB/i);
  const exe = { name: 'evil.exe', url: 'u', size: 10, contentType: 'application/octet-stream' };
  assert.match(att.validate([exe]).reason, /not supported/i);
  const log = { name: 'app.log', url: 'u', size: 10, contentType: 'application/octet-stream' };
  assert.deepStrictEqual(att.validate([log]), { ok: true }); // extension allowlist wins
});

test('downloadAll writes each attachment under prefix and sanitizes names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-att-'));
  att.net.fetch = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('data').buffer });
  const paths = await att.downloadAll(
    [{ name: 'a b/../c.png', url: 'https://cdn/a.png', size: 4, contentType: 'image/png' }],
    dir, 'msg1'
  );
  assert.strictEqual(paths.length, 1);
  assert.ok(paths[0].startsWith(path.join(dir, 'msg1-')));
  assert.ok(!paths[0].includes('..'));
  assert.strictEqual(fs.readFileSync(paths[0], 'utf8'), 'data');
});

test('downloadAll throws on http failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-att-'));
  att.net.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(att.downloadAll([png], dir, 'm'), /403/);
});

test('uploadDirFor builds the per-conversation path', () => {
  assert.strictEqual(att.uploadDirFor('/ws/proj', 12), path.join('/ws/proj', '.otb-uploads', '12'));
});
