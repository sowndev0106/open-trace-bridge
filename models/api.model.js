const { getDb } = require('../lib/db');

function create({ project_id, name, base_url, api_key, auth_header, allowed_methods, description_md, curl_command }) {
  const info = getDb().prepare(
    `INSERT INTO api_groups (project_id, name, base_url, api_key, auth_header, allowed_methods, description_md, curl_command)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(project_id, name, base_url, api_key || '', auth_header || 'Authorization',
    allowed_methods || 'GET', description_md || '', curl_command || '');
  return getDb().prepare('SELECT * FROM api_groups WHERE id = ?').get(info.lastInsertRowid);
}
function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM api_groups WHERE project_id = ? ORDER BY id').all(project_id);
}
function findByProjectAndName(project_id, name) {
  return getDb().prepare('SELECT * FROM api_groups WHERE project_id = ? AND name = ?').get(project_id, name);
}
function remove(id) { getDb().prepare('DELETE FROM api_groups WHERE id = ?').run(id); }

function update(id, { name, base_url, api_key, auth_header, allowed_methods, description_md, curl_command }) {
  getDb().prepare(
    `UPDATE api_groups SET name = ?, base_url = ?, api_key = ?, auth_header = ?,
       allowed_methods = ?, description_md = ?, curl_command = ? WHERE id = ?`
  ).run(name, base_url, api_key || '', auth_header || 'Authorization',
    allowed_methods || 'GET', description_md || '', curl_command || '', id);
  return getDb().prepare('SELECT * FROM api_groups WHERE id = ?').get(id);
}

module.exports = { create, listByProject, findByProjectAndName, remove, update };
