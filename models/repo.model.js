const { getDb } = require('../lib/db');

function create({ project_id, git_url, auth_type, token, ssh_key, branch }) {
  const info = getDb().prepare(
    `INSERT INTO repos (project_id, git_url, auth_type, token, ssh_key, branch)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(project_id, git_url, auth_type || 'none', token || null, ssh_key || null, branch || 'main');
  return getDb().prepare('SELECT * FROM repos WHERE id = ?').get(info.lastInsertRowid);
}
function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY id').all(project_id);
}
function remove(id) { getDb().prepare('DELETE FROM repos WHERE id = ?').run(id); }

function setSyncStatus(id, { status, error = null }) {
  getDb().prepare(
    `UPDATE repos SET sync_status = ?, sync_error = ?,
       synced_at = CASE WHEN ? IN ('success','error') THEN datetime('now') ELSE synced_at END
     WHERE id = ?`
  ).run(status, error, status, id);
}

module.exports = { create, listByProject, remove, setSyncStatus };
