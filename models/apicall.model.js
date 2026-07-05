const { getDb } = require('../lib/db');

function add({ project_id, group_name, method, url, status }) {
  getDb().prepare(
    `INSERT INTO api_calls (project_id, group_name, method, url, status) VALUES (?, ?, ?, ?, ?)`
  ).run(project_id, group_name, method, url, status ?? null);
}
function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM api_calls WHERE project_id = ? ORDER BY id DESC').all(project_id);
}
function deleteOlderThan(project_id, cutoff) {
  const info = getDb().prepare(
    `DELETE FROM api_calls WHERE project_id = ? AND created_at < datetime(?)`
  ).run(project_id, cutoff);
  return info.changes;
}

module.exports = { add, listByProject, deleteOlderThan };
