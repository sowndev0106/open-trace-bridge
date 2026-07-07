const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';

const { resetDbForTest, getDb } = require('../lib/db');
const sessions = require('../models/session.model');

beforeEach(() => {
  resetDbForTest();
});

test('session model: create returns a token that findValid resolves', () => {
  const token = sessions.create();
  assert.match(token, /^[0-9a-f]{64}$/);
  const row = sessions.findValid(token);
  assert.ok(row);
  // Only the hash is stored, never the raw token.
  assert.notStrictEqual(row.token_hash, token);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?').get(token).c, 0);
});

test('session model: findValid rejects unknown, empty, and expired tokens', () => {
  assert.strictEqual(sessions.findValid('nope'), null);
  assert.strictEqual(sessions.findValid(''), null);
  assert.strictEqual(sessions.findValid(undefined), null);

  const token = sessions.create();
  getDb().prepare(`UPDATE sessions SET expires_at = datetime('now', '-1 minute')`).run();
  assert.strictEqual(sessions.findValid(token), null);
});

test('session model: touch extends expiry, deleteByToken removes, deleteExpired purges', () => {
  const token = sessions.create();
  const row = sessions.findValid(token);
  getDb().prepare(`UPDATE sessions SET expires_at = datetime('now', '+1 minute') WHERE id = ?`).run(row.id);
  sessions.touch(row.id);
  const after = sessions.findValid(token);
  assert.ok(after.expires_at > row.created_at);

  sessions.deleteByToken(token);
  assert.strictEqual(sessions.findValid(token), null);

  sessions.create();
  getDb().prepare(`UPDATE sessions SET expires_at = datetime('now', '-1 hour')`).run();
  assert.strictEqual(sessions.deleteExpired(), 1);
});
