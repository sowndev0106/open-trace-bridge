const { getDb } = require('../lib/db');

function findActive(project_id, teams_conversation_id) {
  return getDb().prepare(
    `SELECT * FROM conversations WHERE project_id = ? AND teams_conversation_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT 1`
  ).get(project_id, teams_conversation_id);
}
function create(project_id, teams_conversation_id) {
  const info = getDb().prepare(
    `INSERT INTO conversations (project_id, teams_conversation_id) VALUES (?, ?)`
  ).run(project_id, teams_conversation_id);
  return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
}
function close(id) {
  getDb().prepare(`UPDATE conversations SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(id);
}
function setSession(id, sessionId) {
  getDb().prepare(`UPDATE conversations SET opencode_session_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(sessionId, id);
}
function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY id DESC').all(project_id);
}

module.exports = { findActive, create, close, setSession, listByProject };
