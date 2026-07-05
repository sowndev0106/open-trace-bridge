function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCommand(rawText) {
  const text = stripHtml(rawText);
  const match = text.match(/\btrace\s+(transaction|request|incident)\s+(\S+)/i);
  if (!match) return null;
  return { type: match[1].toLowerCase(), id: match[2] };
}

function validateEvent(body) {
  if (!body || typeof body !== 'object') return 'Payload rỗng hoặc không hợp lệ';
  if (!body.raw || typeof body.raw.text !== 'string') return 'Thiếu raw.text';
  if (!body.user) return 'Thiếu user';
  if (!body.channel) return 'Thiếu channel';
  return null;
}

module.exports = { stripHtml, parseCommand, validateEvent };
