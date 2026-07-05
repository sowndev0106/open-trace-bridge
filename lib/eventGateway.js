function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip keyword prefix (nếu có, case-insensitive, chỉ ở đầu chuỗi) và nhận diện lệnh /new.
// Mọi text còn lại forward nguyên văn cho agent — không còn parse cú pháp cứng.
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
  if (!body || typeof body !== 'object') return 'Payload rỗng hoặc không hợp lệ';
  if (!body.raw || typeof body.raw.text !== 'string') return 'Thiếu raw.text';
  if (!body.user) return 'Thiếu user';
  if (!body.channel) return 'Thiếu channel';
  return null;
}

module.exports = { stripHtml, extractPrompt, validateEvent };
