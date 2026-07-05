const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const apis = require('../models/api.model');
const { executeApiCall } = require('../services/callapi.service');

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
    /không tồn tại/i);
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
