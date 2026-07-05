const AUTH_HEADER_RE = /^(authorization|x-api-key|api-key|x-auth-token)$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

function clean(value) {
  return String(value ?? '').trim();
}

function tokenizeShell(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaping = false;
  const source = String(input || '').replace(/\\\r?\n/g, ' ');

  for (const ch of source) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function deriveNameFromUrl(url) {
  const host = new URL(url).hostname.split('.').filter(Boolean);
  const label = host[0];
  return `${label || 'api'}-api`.replace(/[^A-Za-z0-9_-]/g, '-');
}

function deriveBaseUrl(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const baseParts = /^v\d+$/i.test(parts[0] || '') ? parts.slice(0, 1) : parts.slice(0, -1);
  parsed.pathname = baseParts.length ? `/${baseParts.join('/')}` : '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href.replace(/\/$/, '');
}

function parseHeader(value) {
  const index = String(value).indexOf(':');
  if (index === -1) return null;
  const name = value.slice(0, index).trim();
  const headerValue = value.slice(index + 1).trim();
  if (!name || !headerValue) return null;
  return { name, value: headerValue };
}

function parseCurlApiGroupInput(input) {
  const curlCommand = clean(input.curl_command);
  if (!curlCommand) throw new Error('Curl command is required.');

  const tokens = tokenizeShell(curlCommand);
  const args = tokens[0] === 'curl' ? tokens.slice(1) : tokens;
  let method = 'GET';
  let url = '';
  const headers = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '-X' || token === '--request') {
      method = clean(args[i + 1]).toUpperCase();
      i += 1;
      continue;
    }
    if (token === '-H' || token === '--header') {
      const header = parseHeader(args[i + 1]);
      if (header) headers.push(header);
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!url && isHttpUrl(token)) url = token;
  }

  if (!isHttpUrl(url)) throw new Error('Curl command must include a valid http or https URL.');
  if (!method) method = 'GET';

  const auth = headers.find((header) => AUTH_HEADER_RE.test(header.name));
  const name = clean(input.name) || deriveNameFromUrl(url);
  if (!TOKEN_RE.test(name)) {
    throw new Error('API group name must use letters, numbers, underscores, and hyphens only.');
  }

  return {
    name,
    base_url: deriveBaseUrl(url),
    api_key: auth ? auth.value : '',
    auth_header: auth ? auth.name : 'Authorization',
    allowed_methods: method,
    description_md: String(input.description_md ?? ''),
  };
}

function redactApiSecrets(text, apiGroups) {
  let output = String(text || '');
  for (const group of apiGroups || []) {
    const key = String(group.api_key || '').trim();
    if (!key) continue;
    output = output.split(key).join('[REDACTED_API_KEY]');
  }
  return output;
}

module.exports = {
  parseCurlApiGroupInput,
  redactApiSecrets,
  tokenizeShell,
};
