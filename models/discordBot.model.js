const { getDb } = require('../lib/db');

function create({ name, token, enabled = 1 }) {
  const info = getDb().prepare('INSERT INTO discord_bots (name, token, enabled) VALUES (?, ?, ?)')
    .run(name, token, enabled ? 1 : 0);
  return findById(info.lastInsertRowid);
}
function findById(id) { return getDb().prepare('SELECT * FROM discord_bots WHERE id = ?').get(id); }
function list() { return getDb().prepare('SELECT * FROM discord_bots ORDER BY id').all(); }
function listEnabled() { return getDb().prepare('SELECT * FROM discord_bots WHERE enabled = 1 ORDER BY id').all(); }
function update(id, fields) {
  const allowed = ['name', 'token', 'enabled', 'last_error'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return findById(id);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE discord_bots SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return findById(id);
}
function remove(id) { getDb().prepare('DELETE FROM discord_bots WHERE id = ?').run(id); }

module.exports = { create, findById, list, listEnabled, update, remove };
