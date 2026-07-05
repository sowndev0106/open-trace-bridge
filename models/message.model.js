const { getDb } = require('../lib/db');

function add({ conversation_id, direction, user_id, user_name, content }) {
  const info = getDb().prepare(
    `INSERT INTO messages (conversation_id, direction, user_id, user_name, content)
     VALUES (?, ?, ?, ?, ?)`
  ).run(conversation_id, direction, user_id || null, user_name || null, content);
  return getDb().prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
}
function listByConversation(conversation_id) {
  return getDb().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversation_id);
}

module.exports = { add, listByConversation };
