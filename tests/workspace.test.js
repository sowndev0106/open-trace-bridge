const { test } = require('node:test');
const assert = require('node:assert');
process.env.OTB_DB_PATH = ':memory:';
const { buildAgentsMd, buildOpencodeConfig, repoDirName } = require('../services/workspace.service');

const project = { id: 1, slug: 'payment', name: 'Payment', keyword: 'payment-bot',
  system_prompt: 'You are an incident investigator.', teams_webhook_url: '' };
const groups = [{
  name: 'txn-api', base_url: 'https://api.internal', api_key: 'SECRET-KEY',
  auth_header: 'Authorization', allowed_methods: 'GET', description_md: '## GET /transactions/{id}',
}];

test('buildAgentsMd contains prompt + api docs but NEVER the key', () => {
  const md = buildAgentsMd(project, groups);
  assert.ok(md.includes('You are an incident investigator.'));
  assert.ok(md.includes('txn-api'));
  assert.ok(md.includes('GET /transactions/{id}'));
  assert.ok(md.includes('call_api'));
  assert.ok(!md.includes('SECRET-KEY'));
});

test('buildOpencodeConfig denies edit/bash/webfetch and wires mcp', () => {
  const cfg = buildOpencodeConfig(project);
  assert.strictEqual(cfg.permission.edit, 'deny');
  assert.strictEqual(cfg.permission.bash, 'deny');
  assert.strictEqual(cfg.permission.webfetch, 'deny');
  assert.strictEqual(cfg.mcp.otb.type, 'local');
  assert.ok(cfg.mcp.otb.command[1].endsWith('mcp/callapi-stdio.js'));
  assert.strictEqual(cfg.mcp.otb.environment.OTB_PROJECT_SLUG, 'payment');
  assert.ok(cfg.mcp.otb.environment.OTB_INTERNAL_TOKEN.length >= 32);
});

test('repoDirName from url', () => {
  assert.strictEqual(repoDirName('https://github.com/org/my-repo.git'), 'my-repo');
  assert.strictEqual(repoDirName('git@github.com:org/other.git'), 'other');
});
