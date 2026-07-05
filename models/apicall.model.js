const { getDb } = require('../lib/db');

function add({ project_id, conversation_id, group_name, method, url, status, request_params, response_body, error, duration_ms }) {
  getDb().prepare(
    `INSERT INTO api_calls (project_id, conversation_id, group_name, method, url, status, request_params, response_body, error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(project_id, conversation_id ?? null, group_name, method, url, status ?? null,
    request_params ?? null, response_body ?? null, error ?? null, duration_ms ?? null);
}
function listByConversation(conversation_id) {
  return getDb().prepare('SELECT * FROM api_calls WHERE conversation_id = ? ORDER BY id DESC').all(conversation_id);
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

module.exports = { add, listByProject, listByConversation, deleteOlderThan };
