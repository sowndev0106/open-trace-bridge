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
