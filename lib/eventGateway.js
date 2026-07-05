function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip the keyword prefix when present and detect the /new command.
// Forward the remaining text to the agent unchanged; no rigid command parsing.
function extractPrompt(rawText, keyword) {
  let text = stripHtml(rawText);
  const kw = String(keyword || '').trim();
  if (kw && text.toLowerCase().startsWith(kw.toLowerCase())) {
    text = text.slice(kw.length).trim();
  }
  const isNew = /^\/new\b/.test(text);
  return { isNew, prompt: text };
}

function validateEvent(body) {
  if (!body || typeof body !== 'object') return 'Payload is empty or invalid';
  if (!body.raw || typeof body.raw.text !== 'string') return 'Missing raw.text';
  if (!body.user) return 'Missing user';
  if (!body.channel) return 'Missing channel';
  return null;
}

module.exports = { stripHtml, extractPrompt, validateEvent };
