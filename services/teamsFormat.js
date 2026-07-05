// Normalize OpenCode output into Adaptive Cards for Microsoft Teams.
// Spec: docs/send_msg_webhook.md.
// Pure functions; no network calls.

const REDACTIONS = [
  [/(authorization:\s*bearer\s+)\S+/gi, '$1[REDACTED]'],
  [/(x-api-key:\s*)\S+/gi, '$1[REDACTED]'],
  [/(api_key=)[^&\s]+/gi, '$1[REDACTED]'],
  [/(token=)[^&\s]+/gi, '$1[REDACTED]'],
  [/(password=)[^&\s]+/gi, '$1[REDACTED]'],
  [/(secret=)[^&\s]+/gi, '$1[REDACTED]'],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
];

function redact(text) {
  let out = String(text || '');
  for (const [re, sub] of REDACTIONS) out = out.replace(re, sub);
  return out;
}

// Split markdown into text and fenced-code blocks while preserving the language.
function tokenize(md) {
  const blocks = [];
  const lines = String(md || '').split('\n');
  let buf = [];
  let inCode = false;
  let lang = '';
  for (const line of lines) {
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence && !inCode) {
      if (buf.length) { blocks.push({ type: 'text', text: buf.join('\n') }); buf = []; }
      inCode = true; lang = fence[1] || '';
    } else if (fence && inCode) {
      blocks.push({ type: 'code', lang, text: buf.join('\n') }); buf = [];
      inCode = false; lang = '';
    } else {
      buf.push(line);
    }
  }
  if (buf.length) {
    blocks.push(inCode ? { type: 'code', lang, text: buf.join('\n') } : { type: 'text', text: buf.join('\n') });
  }
  return blocks;
}

const CUT_MARK = '\n[code continues in the next part]';

// Split one block into pieces <= maxLen without breaking fences.
function splitBlock(block, maxLen) {
  const wrapLen = block.type === 'code' ? ('```'.length * 2 + block.lang.length + 2 + CUT_MARK.length) : 0;
  const budget = Math.max(maxLen - wrapLen, 20);
  const pieces = [];
  let cur = [];
  let curLen = 0;
  for (const line of block.text.split('\n')) {
    if (curLen + line.length + 1 > budget && cur.length) {
      pieces.push(cur.join('\n'));
      cur = []; curLen = 0;
    }
    cur.push(line); curLen += line.length + 1;
  }
  if (cur.length) pieces.push(cur.join('\n'));
  return pieces.map((p, i) => {
    if (block.type === 'code') {
      const cont = i < pieces.length - 1 ? CUT_MARK : '';
      return { rendered: '```' + block.lang + '\n' + p + '\n```' + cont };
    }
    return { rendered: p };
  });
}

// Split markdown into messages <= maxLen, preferring block boundaries.
// Split code blocks are closed with a marker and reopened in the next message.
function splitMarkdown(md, maxLen) {
  const blocks = tokenize(md);
  const rendered = [];
  for (const b of blocks) {
    const asText = b.type === 'code' ? '```' + b.lang + '\n' + b.text + '\n```' : b.text;
    if (asText.length <= maxLen) rendered.push(asText);
    else rendered.push(...splitBlock(b, maxLen).map((p) => p.rendered));
  }

  const chunks = [];
  let cur = '';
  for (const piece of rendered) {
    if (!piece.trim()) continue;
    if (cur && cur.length + piece.length + 2 > maxLen) { chunks.push(cur); cur = ''; }
    cur = cur ? cur + '\n\n' + piece : piece;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [''];
}

const STATUS_MARK = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️', debug: '🔎' };

// Build one Adaptive Card message from one markdown chunk.
function buildCard({ status, title, markdown, metadata, partInfo }) {
  const mark = STATUS_MARK[status] || '';
  const partSuffix = partInfo && partInfo.total > 1 ? ` (part ${partInfo.index}/${partInfo.total})` : '';
  const body = [{
    type: 'TextBlock',
    text: `${mark} ${title}${partSuffix}`.trim(),
    weight: 'Bolder', size: 'Medium', wrap: true,
  }];

  for (const block of tokenize(markdown)) {
    if (!block.text.trim()) continue;
    if (block.type === 'code') {
      body.push({
        type: 'TextBlock',
        text: '```' + block.lang + '\n' + block.text + '\n```',
        wrap: true, fontType: 'Monospace', spacing: 'Medium',
      });
    } else {
      body.push({ type: 'TextBlock', text: block.text, wrap: true, spacing: 'Medium' });
    }
  }

  const metaParts = [];
  if (metadata && metadata.project) metaParts.push(`Project: ${metadata.project}`);
  if (metadata && metadata.sessionId) metaParts.push(`Session: ${metadata.sessionId}`);
  if (metaParts.length) {
    body.push({ type: 'TextBlock', text: metaParts.join(' | '), isSubtle: true, wrap: true, spacing: 'Medium' });
  }

  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body,
      },
    }],
  };
}

module.exports = { redact, splitMarkdown, buildCard, tokenize };
