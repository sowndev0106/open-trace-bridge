// Gửi message về Teams qua webhook của project (Power Automate "When a Teams webhook
// request is received" hoặc Incoming Webhook — cả 2 nhận Adaptive Card payload này).
async function sendTeamsMessage(webhookUrl, markdownText) {
  if (!webhookUrl) throw new Error('Project chưa cấu hình teams_webhook_url');
  const payload = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [{ type: 'TextBlock', text: markdownText, wrap: true }],
      },
    }],
  };
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Webhook trả ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
}

module.exports = { sendTeamsMessage };
