// Gửi message về Teams qua webhook của project (Power Automate "When a Teams webhook
// request is received"). Format theo docs/send_msg_webhook.md:
// redact secrets (§6) → split theo max_msg_length (§5, code fence được đóng/mở chuẩn)
// → build Adaptive Card (§3) → POST tuần tự từng phần.
const { redact, splitMarkdown, buildCard } = require('./teamsFormat');

async function postCard(webhookUrl, card) {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(card),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Webhook trả ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
}

// message: { status, title, markdown, metadata } — xem docs/send_msg_webhook.md §2/§4
async function sendTeamsMessage(webhookUrl, message) {
  if (!webhookUrl) throw new Error('Project chưa cấu hình teams_webhook_url');
  const m = typeof message === 'string'
    ? { status: 'success', title: 'Kết quả', markdown: message, metadata: {} }
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
