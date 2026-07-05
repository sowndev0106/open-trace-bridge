const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const apicalls = require('../models/apicall.model');
const { getDb } = require('../lib/db');

function listForProject(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  res.render('conversations/list', {
    project: p,
    conversations: convs.listByProject(p.id),
    apiCalls: apicalls.listByProject(p.id).slice(0, 50),
  });
}
function detail(req, res) {
  const conv = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).send('Conversation not found');
  res.render('conversations/detail', {
    conv,
    project: projects.findById(conv.project_id),
    messages: messages.listByConversation(conv.id),
  });
}

module.exports = { listForProject, detail };
