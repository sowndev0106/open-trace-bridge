const { getDb } = require('../lib/db');

function create({ slug, name, keyword, system_prompt, teams_webhook_url }) {
  const info = getDb().prepare(
    `INSERT INTO projects (slug, name, keyword, system_prompt, teams_webhook_url)
     VALUES (?, ?, ?, ?, ?)`
  ).run(slug, name, keyword || '', system_prompt || '', teams_webhook_url || '');
  return findById(info.lastInsertRowid);
}
function findById(id) { return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id); }
function findBySlug(slug) { return getDb().prepare('SELECT * FROM projects WHERE slug = ?').get(slug); }
function list() { return getDb().prepare('SELECT * FROM projects ORDER BY id').all(); }
function update(id, fields) {
  const allowed = ['slug', 'name', 'keyword', 'system_prompt', 'teams_webhook_url'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return findById(id);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE projects SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return findById(id);
}
function remove(id) { getDb().prepare('DELETE FROM projects WHERE id = ?').run(id); }

module.exports = { create, findById, findBySlug, list, update, remove };
