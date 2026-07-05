const express = require('express');
const { parseCommand, validateEvent } = require('./lib/eventGateway');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

function handleEvent(event) {
  console.log('Incoming event payload:', JSON.stringify(event, null, 2));

  const validationError = validateEvent(event);
  if (validationError) {
    console.warn('Event rejected:', validationError);
    return { status: 400, body: { error: validationError } };
  }

  const command = parseCommand(event.raw.text);
  if (!command) {
    return {
      status: 200,
      body: {
        handled: false,
        reply: 'Không nhận diện được lệnh. Dùng: trace transaction <id> | trace request <id> | trace incident <id>',
      },
    };
  }

  const incidentId = `INC-${Date.now()}`;
  console.log(`Command parsed: ${command.type} = ${command.id}, incidentId=${incidentId}`);

  // Step 2 (lookup fixtures + gọi opencode) chưa nối vào đây, tạm trả ack.
  return {
    status: 200,
    body: {
      handled: true,
      incidentId,
      command,
      reply: `Đã nhận lệnh, đang tạo incident ${incidentId} (evidence lookup + OpenCode sẽ nối ở bước tiếp theo).`,
    },
  };
}

app.post('/api/events', (req, res) => {
  const result = handleEvent(req.body);
  res.status(result.status).json(result.body);
});

// GET variant: Power Automate không có action miễn phí nào gọi được HTTP POST
// ra domain ngoài (chỉ có "Upload file from URL" của OneDrive, chỉ hỗ trợ GET,
// không có body/header tuỳ ý) — nên nhận event qua query string thay vì JSON body.
app.get('/api/events', (req, res) => {
  const event = {
    source: req.query.source || 'teams',
    raw: { text: req.query.text || '' },
    user: { id: req.query.userId || '', name: req.query.userName || '' },
    channel: {
      conversationId: req.query.conversationId || '',
      threadId: req.query.threadId || '',
    },
    timestamp: req.query.timestamp || new Date().toISOString(),
  };
  const result = handleEvent(event);
  res.status(result.status).json(result.body);
});

app.use((req, res) => {
  console.log('Unhandled route:', req.method, req.originalUrl, JSON.stringify(req.body));
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 6666;
app.listen(PORT, () => {
  console.log(`OpenTraceBridge server listening on port ${PORT}`);
});
