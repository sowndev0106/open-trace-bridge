const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const apis = require('../models/api.model');
const { executeApiCall } = require('../services/callapi.service');
const {
  parseCurlApiGroupInput,
  redactApiSecrets,
} = require('../services/curlApiGroup.service');

beforeEach(() => resetDbForTest());

function setup() {
  const p = projects.create({ slug: 'p6', name: 'P6', keyword: '', system_prompt: '', teams_webhook_url: '' });
  apis.create({ project_id: p.id, name: 'txn', base_url: 'https://api.example.com/v1',
    api_key: 'K', auth_header: 'Authorization', allowed_methods: 'GET', description_md: '' });
  return p;
}

test('rejects unknown group', async () => {
  const p = setup();
  await assert.rejects(
    executeApiCall({ project: p, groupName: 'nope', method: 'GET', path: '/x', params: {} }),
    /does not exist/i);
});

test('rejects method not allowed', async () => {
  const p = setup();
  await assert.rejects(
    executeApiCall({ project: p, groupName: 'txn', method: 'POST', path: '/x', params: {} }),
    /method/i);
});

test('rejects path escaping base url', async () => {
  const p = setup();
  await assert.rejects(
    executeApiCall({ project: p, groupName: 'txn', method: 'GET', path: '/../../evil', params: {} }),
    /base URL/i);
  await assert.rejects(
    executeApiCall({ project: p, groupName: 'txn', method: 'GET', path: 'https://evil.com/x', params: {} }),
    /base URL/i);
});

test('audit row stores full request params and response body', async () => {
  const p = setup();
  const apicalls = require('../models/apicall.model');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"total":2,"items":["a","b"]}', {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try {
    const r = await executeApiCall({
      project: p, groupName: 'txn', method: 'GET', path: '/transactions',
      params: { limit: 10, ref: 'txn_123' },
    });
    assert.strictEqual(r.status, 200);
  } finally {
    globalThis.fetch = origFetch;
  }

  const rows = apicalls.listByProject(p.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 200);
  assert.deepStrictEqual(JSON.parse(rows[0].request_params), { limit: 10, ref: 'txn_123' });
  assert.strictEqual(rows[0].response_body, '{"total":2,"items":["a","b"]}');
  assert.ok(Number.isInteger(rows[0].duration_ms) && rows[0].duration_ms >= 0);
  assert.strictEqual(rows[0].error, null);
});

test('audit row records the conversation that made the call', async () => {
  const p = setup();
  const apicalls = require('../models/apicall.model');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    await executeApiCall({
      project: p, groupName: 'txn', method: 'GET', path: '/x', params: {}, conversationId: 7,
    });
  } finally {
    globalThis.fetch = origFetch;
  }
  const rows = apicalls.listByProject(p.id);
  assert.strictEqual(rows[0].conversation_id, 7);
  assert.strictEqual(apicalls.listByConversation(7).length, 1);
  assert.strictEqual(apicalls.listByConversation(999).length, 0);
});

test('audit row stores the error when the upstream call fails', async () => {
  const p = setup();
  const apicalls = require('../models/apicall.model');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fetch failed: connect ECONNREFUSED'); };
  try {
    await assert.rejects(
      executeApiCall({ project: p, groupName: 'txn', method: 'GET', path: '/x', params: {} }),
      /ECONNREFUSED/);
  } finally {
    globalThis.fetch = origFetch;
  }

  const rows = apicalls.listByProject(p.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, null);
  assert.match(rows[0].error, /ECONNREFUSED/);
  assert.strictEqual(rows[0].response_body, null);
});

test('audit row truncates an oversized response body', async () => {
  const p = setup();
  const apicalls = require('../models/apicall.model');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('x'.repeat(150000), { status: 200 });
  try {
    await executeApiCall({ project: p, groupName: 'txn', method: 'GET', path: '/big', params: {} });
  } finally {
    globalThis.fetch = origFetch;
  }

  const rows = apicalls.listByProject(p.id);
  assert.ok(rows[0].response_body.length <= 100000 + 30);
  assert.match(rows[0].response_body, /\[truncated\]$/);
});

test('parses pasted curl into an API group using bearer auth', () => {
  const parsed = parseCurlApiGroupInput({
    name: 'transaction-api',
    curl_command: `curl -X POST \
      -H "Authorization: Bearer sk_live_123" \
      -H "Accept: application/json" \
      "https://api.internal.example/v1/transactions/search?limit=10"`,
    description_md: 'Search transactions by reference id.',
  });

  assert.deepStrictEqual(parsed, {
    name: 'transaction-api',
    base_url: 'https://api.internal.example/v1',
    api_key: 'Bearer sk_live_123',
    auth_header: 'Authorization',
    allowed_methods: 'POST',
    description_md: 'Search transactions by reference id.',
  });
});

test('parses pasted curl using default GET and x-api-key auth', () => {
  const parsed = parseCurlApiGroupInput({
    name: '',
    curl_command: `curl "https://ledger.example.com/accounts/acct_123/balance" -H "x-api-key: key_abc"`,
    description_md: 'Fetch account balance.',
  });

  assert.strictEqual(parsed.name, 'ledger-api');
  assert.strictEqual(parsed.base_url, 'https://ledger.example.com/accounts/acct_123');
  assert.strictEqual(parsed.api_key, 'key_abc');
  assert.strictEqual(parsed.auth_header, 'x-api-key');
  assert.strictEqual(parsed.allowed_methods, 'GET');
  assert.strictEqual(parsed.description_md, 'Fetch account balance.');
});

test('redacts configured API keys from generated markdown', () => {
  const text = 'Use Bearer sk_live_123 for this endpoint. key_abc must not appear.';
  const redacted = redactApiSecrets(text, [
    { api_key: 'Bearer sk_live_123' },
    { api_key: 'key_abc' },
  ]);

  assert.strictEqual(redacted, 'Use [REDACTED_API_KEY] for this endpoint. [REDACTED_API_KEY] must not appear.');
});

test('curl parser rejects missing curl command and missing URL', () => {
  assert.throws(
    () => parseCurlApiGroupInput({ name: 'x', curl_command: '', description_md: '' }),
    /Curl command is required/i
  );
  assert.throws(
    () => parseCurlApiGroupInput({ name: 'x', curl_command: 'curl -H "Authorization: Bearer x"', description_md: '' }),
    /valid http or https URL/i
  );
});
