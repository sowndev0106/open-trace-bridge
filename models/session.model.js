const crypto = require('crypto');
const { getDb } = require('../lib/db');

const TTL_DAYS = 7;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function create() {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare(
    `INSERT INTO sessions (token_hash, expires_at) VALUES (?, datetime('now', '+${TTL_DAYS} days'))`
  ).run(hashToken(token));
  return token;
}
function findValid(token) {
  if (!token) return null;
  return getDb().prepare(
    `SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')`
  ).get(hashToken(token)) || null;
}
function touch(id) {
  getDb().prepare(
    `UPDATE sessions SET expires_at = datetime('now', '+${TTL_DAYS} days') WHERE id = ?`
  ).run(id);
}
function deleteByToken(token) {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}
function deleteExpired() {
  return getDb().prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run().changes;
}

module.exports = { create, findValid, touch, deleteByToken, deleteExpired, TTL_DAYS };
