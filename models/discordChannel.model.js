const { getDb } = require('../lib/db');

function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM discord_channels WHERE project_id = ? ORDER BY id').all(project_id);
}
function findByChannelId(channel_id) {
  return getDb().prepare('SELECT * FROM discord_channels WHERE channel_id = ?').get(String(channel_id));
}
// Full replace: the project form submits the complete channel list every save.
function replaceForProject(project_id, rows) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM discord_channels WHERE project_id = ?').run(project_id);
    const ins = db.prepare('INSERT INTO discord_channels (project_id, channel_id, mode) VALUES (?, ?, ?)');
    for (const r of rows) ins.run(project_id, String(r.channel_id), r.mode === 'all' ? 'all' : 'mention');
  })();
}

module.exports = { listByProject, findByChannelId, replaceForProject };
