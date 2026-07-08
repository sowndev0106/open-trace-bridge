const { getDb } = require('../lib/db');

function create({ discord_user_id, label = '', role = 'member', all_projects = 0 }) {
  const info = getDb().prepare(
    'INSERT INTO discord_dm_users (discord_user_id, label, role, all_projects) VALUES (?, ?, ?, ?)'
  ).run(String(discord_user_id), label, role, all_projects ? 1 : 0);
  return findById(info.lastInsertRowid);
}
function findById(id) { return getDb().prepare('SELECT * FROM discord_dm_users WHERE id = ?').get(id); }
function findByDiscordId(discord_user_id) {
  return getDb().prepare('SELECT * FROM discord_dm_users WHERE discord_user_id = ?').get(String(discord_user_id));
}
function list() { return getDb().prepare('SELECT * FROM discord_dm_users ORDER BY id').all(); }
function update(id, fields) {
  const allowed = ['label', 'role', 'all_projects'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return findById(id);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE discord_dm_users SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return findById(id);
}
function remove(id) { getDb().prepare('DELETE FROM discord_dm_users WHERE id = ?').run(id); }

function setProjects(dm_user_id, projectIds) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM discord_dm_user_projects WHERE dm_user_id = ?').run(dm_user_id);
    const ins = db.prepare('INSERT INTO discord_dm_user_projects (dm_user_id, project_id) VALUES (?, ?)');
    for (const pid of projectIds) ins.run(dm_user_id, pid);
  })();
}
function listProjectIds(dm_user_id) {
  return getDb().prepare('SELECT project_id FROM discord_dm_user_projects WHERE dm_user_id = ?')
    .all(dm_user_id).map((r) => r.project_id);
}
function getSelection(dm_user_id, bot_id) {
  const row = getDb().prepare(
    'SELECT project_id FROM discord_dm_selections WHERE dm_user_id = ? AND bot_id = ?'
  ).get(dm_user_id, bot_id);
  return row ? row.project_id : null;
}
function setSelection(dm_user_id, bot_id, project_id) {
  getDb().prepare(
    `INSERT INTO discord_dm_selections (dm_user_id, bot_id, project_id) VALUES (?, ?, ?)
     ON CONFLICT(dm_user_id, bot_id) DO UPDATE SET project_id = excluded.project_id`
  ).run(dm_user_id, bot_id, project_id);
}

module.exports = {
  create, findById, findByDiscordId, list, update, remove,
  setProjects, listProjectIds, getSelection, setSelection,
};
