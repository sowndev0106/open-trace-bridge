const fs = require('fs');
const path = require('path');

// Discord CDN URLs are signed and expire (~24h) — always download immediately,
// never store the URL for later.
const net = { fetch: (...args) => fetch(...args) };

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const TEXT_EXT = new Set(['txt', 'md', 'log', 'json', 'csv', 'yaml', 'yml', 'xml', 'html', 'css',
  'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php',
  'sh', 'sql', 'toml', 'ini', 'env', 'conf', 'diff', 'patch']);

const DEFAULT_ATTACHMENT_PROMPT = 'Analyze the attached file(s) in the context of this project.';

function limits() {
  return {
    maxBytes: Number(process.env.DISCORD_MAX_ATTACHMENT_MB || 20) * 1024 * 1024,
    maxCount: Number(process.env.DISCORD_MAX_ATTACHMENTS || 5),
  };
}

function ext(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function isAllowedType(a) {
  const e = ext(a.name);
  if (IMAGE_EXT.has(e) || TEXT_EXT.has(e)) return true;
  const ct = String(a.contentType || '');
  return ct.startsWith('text/') || ct.startsWith('image/');
}

function validate(attachments) {
  const { maxBytes, maxCount } = limits();
  if (attachments.length > maxCount) {
    return { ok: false, reason: `Please attach at most ${maxCount} files per message.` };
  }
  for (const a of attachments) {
    if (Number(a.size) > maxBytes) {
      return { ok: false, reason: `"${a.name}" is larger than ${maxBytes / 1024 / 1024} MB.` };
    }
    if (!isAllowedType(a)) {
      return { ok: false, reason: `"${a.name}" is not supported. Send images or text-based files.` };
    }
  }
  return { ok: true };
}

function sanitizeName(name) {
  return String(name || 'file')
    .replace(/[^\w.-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 120);
}

async function downloadAll(attachments, destDir, prefix) {
  fs.mkdirSync(destDir, { recursive: true });
  const paths = [];
  for (const a of attachments) {
    const resp = await net.fetch(a.url);
    if (!resp.ok) throw new Error(`Attachment download failed (${resp.status}) for ${a.name}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const p = path.join(destDir, `${sanitizeName(prefix)}-${sanitizeName(a.name)}`);
    fs.writeFileSync(p, buf);
    paths.push(p);
  }
  return paths;
}

function uploadDirFor(ws, conversationId) {
  return path.join(ws, '.otb-uploads', String(conversationId));
}

module.exports = { net, limits, isAllowedType, validate, downloadAll, uploadDirFor, DEFAULT_ATTACHMENT_PROMPT };
