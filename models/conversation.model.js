const { getDb } = require('../lib/db');

function findActive(project_id, external_id) {
  return getDb().prepare(
    `SELECT * FROM conversations WHERE project_id = ? AND external_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT 1`
  ).get(project_id, external_id);
}
function create(project_id, external_id) {
  const info = getDb().prepare(
    `INSERT INTO conversations (project_id, external_id) VALUES (?, ?)`
  ).run(project_id, external_id);
  return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
}
function close(id) {
  getDb().prepare(`UPDATE conversations SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(id);
}
function touch(id) {
  getDb().prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(id);
}
// Close all active conversations not updated within the last `minutes` minutes.
// Returns the number of conversations closed.
function autoCloseInactive(minutes) {
  const info = getDb().prepare(
    `UPDATE conversations SET status = 'closed', updated_at = datetime('now')
     WHERE status = 'active' AND updated_at <= datetime('now', '-' || ? || ' minutes')`
  ).run(minutes);
  return info.changes;
}
function setSession(id, sessionId) {
  getDb().prepare(`UPDATE conversations SET opencode_session_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(sessionId, id);
}
function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY id DESC').all(project_id);
}
function deleteOlderThan(project_id, cutoff) {
  const info = getDb().prepare(
    `DELETE FROM conversations WHERE project_id = ? AND updated_at < datetime(?)`
  ).run(project_id, cutoff);
  return info.changes;
}
function findById(id) { return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id); }
function listOlderThan(project_id, cutoff) {
  return getDb().prepare(
    `SELECT id FROM conversations WHERE project_id = ? AND updated_at < datetime(?)`
  ).all(project_id, cutoff);
}
function setOverrides(id, { model = null, agent = null, variant = null } = {}) {
  getDb().prepare(`UPDATE conversations SET model = ?, agent = ?, variant = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(model, agent, variant, id);
}

module.exports = {
  findActive, create, close, touch, autoCloseInactive, setSession, listByProject, deleteOlderThan,
  findById, setOverrides, listOlderThan,
};
