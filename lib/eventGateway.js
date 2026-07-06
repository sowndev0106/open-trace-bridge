function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Single source of truth for chat commands: used both to parse incoming text
// and to render the /guide card. Adding a command means adding one entry
// here plus a handler branch in controllers/event.controller.js.
const COMMANDS = [
  { name: 'new', description: 'Close the active conversation and start a new OpenCode session.' },
  { name: 'pull-source', description: 'Force-sync all repositories to the latest remote state right now.' },
  { name: 'guide', description: 'Show this list of available commands.' },
];

// Strip the keyword prefix when present, then detect a leading /command.
// Returns { command, prompt }:
//   - command is null for plain text (forwarded to the agent as-is)
//   - command is 'unknown' when the text starts with "/" but matches no
//     known command (never forwarded to the agent)
//   - otherwise command is the matched command name from COMMANDS
function extractPrompt(rawText, keyword) {
  let text = stripHtml(rawText);
  const kw = String(keyword || '').trim();
  if (kw && text.toLowerCase().startsWith(kw.toLowerCase())) {
    text = text.slice(kw.length).trim();
  }

  if (!text.startsWith('/')) return { command: null, prompt: text };

  for (const { name } of COMMANDS) {
    const re = new RegExp(`^/${name}\\b`);
    if (re.test(text)) return { command: name, prompt: text };
  }
  return { command: 'unknown', prompt: text };
}

function validateEvent(body) {
  if (!body || typeof body !== 'object') return 'Payload is empty or invalid';
  if (!body.raw || typeof body.raw.text !== 'string') return 'Missing raw.text';
  if (!body.user) return 'Missing user';
  if (!body.channel) return 'Missing channel';
  return null;
}

module.exports = { stripHtml, extractPrompt, validateEvent, COMMANDS };
