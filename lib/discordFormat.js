// Discord rendering rules: plain markdown chunks for answers (2000-char bot
// limit, code fences kept balanced), colored embeds for status notices,
// emoji reactions for the question lifecycle. Pure functions; no discord.js.
const { redact, splitMarkdown } = require('../services/teamsFormat');

const DISCORD_CHUNK_LEN = 2000;
const HEAD_LEN = 1800; // room left for the "full answer attached" note

const COLORS = { info: 0x3b82f6, success: 0x22c55e, warning: 0xeab308, error: 0xef4444 };
const EMOJI = { accepted: '👀', success: '✅', error: '❌', timeout: '⏱️', stopped: '🛑' };

function renderAnswer(text, { maxLength = 20000, fileThreshold = Number(process.env.DISCORD_LONG_ANSWER_THRESHOLD || 6000) } = {}) {
  let clean = redact(String(text || ''));
  if (clean.length > maxLength) {
    const suffix = '\n…(truncated)';
    clean = clean.slice(0, Math.max(maxLength - suffix.length, 0)) + suffix;
  }
  if (clean.length > fileThreshold) {
    const head = splitMarkdown(clean, HEAD_LEN)[0] || '';
    return {
      chunks: [head + '\n\n*(full answer attached as answer.md)*'],
      file: { name: 'answer.md', content: clean },
    };
  }
  return { chunks: splitMarkdown(clean, DISCORD_CHUNK_LEN), file: null };
}

function statusEmbed({ status, title, description, footer }) {
  const embed = {
    color: COLORS[status] || COLORS.info,
    title: String(title || '').slice(0, 256),
    description: redact(String(description || '')).slice(0, 4096),
  };
  if (footer) embed.footer = { text: String(footer).slice(0, 2048) };
  return embed;
}

function attachmentMarkers(attachments) {
  return (attachments || []).map((a) => `[attachment: ${a.name}]`).join('\n');
}

module.exports = { COLORS, EMOJI, DISCORD_CHUNK_LEN, renderAnswer, statusEmbed, attachmentMarkers };
