// Send messages to Teams through the project webhook (Power Automate "When a Teams webhook
// request is received"). Format follows docs/send_msg_webhook.md:
// redact secrets, split by max_msg_length while preserving code fences,
// build Adaptive Cards, then POST each part sequentially.
const { redact, splitMarkdown, buildCard } = require('./teamsFormat');

async function postCard(webhookUrl, card) {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(card),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Webhook returned ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
}

// message: { status, title, markdown, metadata }. See docs/send_msg_webhook.md.
async function sendTeamsMessage(webhookUrl, message) {
  if (!webhookUrl) throw new Error('Project has not configured teams_webhook_url');
  const m = typeof message === 'string'
    ? { status: 'success', title: 'Result', markdown: message, metadata: {} }
    : message;

  const clean = redact(m.markdown || '');
  const maxLen = Number(m.maxLength) > 0 ? Number(m.maxLength) : 20000;
  const chunks = splitMarkdown(clean, maxLen);

  for (let i = 0; i < chunks.length; i++) {
    const card = buildCard({
      status: m.status,
      title: m.title,
      markdown: chunks[i],
      metadata: m.metadata || {},
      partInfo: { index: i + 1, total: chunks.length },
    });
    await postCard(webhookUrl, card);
  }
}

module.exports = { sendTeamsMessage };
