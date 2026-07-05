const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const { extractPrompt } = require('../lib/eventGateway');
const { ensureWorkspace } = require('../services/workspace.service');
const { runPrompt } = require('../services/opencode.service');
const { sendTeamsMessage } = require('../services/webhook.service');

function eventFromRequest(req) {
  if (req.method === 'GET') {
    const q = req.query;
    return {
      text: q.text || '', userId: q.userId || '', userName: q.userName || '',
      conversationId: q.conversationId || '',
    };
  }
  const b = req.body || {};
  return {
    text: (b.raw && b.raw.text) || '', userId: (b.user && b.user.id) || '',
    userName: (b.user && b.user.name) || '',
    conversationId: (b.channel && b.channel.conversationId) || '',
  };
}

async function investigate(project, conv, prompt) {
  const ws = await ensureWorkspace(project, repos.listByProject(project.id), apis.listByProject(project.id));
  const result = await runPrompt({ dir: ws, sessionId: conv.opencode_session_id, text: prompt });
  if (!conv.opencode_session_id) convs.setSession(conv.id, result.sessionId);
  return result.text || '(agent không trả text)';
}

function handleEvent(req, res) {
  const project = projects.findBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: `Không có project slug "${req.params.slug}"` });

  const ev = eventFromRequest(req);
  if (!ev.text || !ev.conversationId) {
    return res.status(400).json({ error: 'Thiếu text hoặc conversationId' });
  }

  const { isNew, prompt } = extractPrompt(ev.text, project.keyword);

  let conv = convs.findActive(project.id, ev.conversationId);
  if (isNew) {
    if (conv) convs.close(conv.id);
    conv = convs.create(project.id, ev.conversationId);
    messages.add({ conversation_id: conv.id, direction: 'in', user_id: ev.userId, user_name: ev.userName, content: ev.text });
    res.json({ handled: true, action: 'new-session', conversationId: conv.id });
    sendTeamsMessage(project.teams_webhook_url, `🆕 Đã tạo cuộc hội thoại mới cho **${project.name}**. Gõ \`${project.keyword}\` kèm câu hỏi để bắt đầu.`)
      .then(() => messages.add({ conversation_id: conv.id, direction: 'out', content: 'Đã tạo cuộc hội thoại mới' }))
      .catch((err) => console.error('Webhook fail:', err.message));
    return;
  }

  if (!conv) conv = convs.create(project.id, ev.conversationId);
  messages.add({ conversation_id: conv.id, direction: 'in', user_id: ev.userId, user_name: ev.userName, content: ev.text });

  // Ack ngay — kết quả trả async qua webhook (tránh Power Automate timeout)
  res.json({ handled: true, action: 'investigating', conversationId: conv.id });

  investigate(project, conv, prompt)
    .then((answer) => {
      messages.add({ conversation_id: conv.id, direction: 'out', content: answer });
      return sendTeamsMessage(project.teams_webhook_url, answer);
    })
    .catch((err) => {
      console.error(`Investigation fail (project=${project.slug}):`, err);
      messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
      return sendTeamsMessage(project.teams_webhook_url,
        `⚠️ Không hoàn tất được phân tích: ${err.message}`).catch((e) => console.error('Webhook fail:', e.message));
    });
}

module.exports = { handleEvent };
