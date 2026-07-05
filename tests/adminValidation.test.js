const { test } = require('node:test');
const assert = require('node:assert');
const { validateProjectBundle } = require('../services/adminValidation');

const goodProject = {
  slug: 'pay', name: 'Pay', keyword: '', system_prompt: '',
  teams_webhook_url: '', max_msg_length: '20000',
};

test('bundle accepts arrays or indexed objects and drops fully-empty rows', () => {
  const { values, errors } = validateProjectBundle({
    ...goodProject,
    repos: { 0: { git_url: 'https://github.com/a/b.git', auth_type: 'none', branch: 'main', token: '', ssh_key: '' },
             2: { git_url: '', auth_type: 'none', branch: '', token: '', ssh_key: '' } },
    apis: [{ name: 'txn', base_url: 'https://api.x', api_key: '', auth_header: 'Authorization',
             allowed_methods: 'GET', description_md: '' }],
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(values.repos.length, 1);
  assert.strictEqual(values.repos[0].id, null);
  assert.strictEqual(values.apis.length, 1);
});

test('bundle prefixes row errors with their 1-based position', () => {
  const { errors } = validateProjectBundle({
    ...goodProject,
    repos: [
      { git_url: 'https://github.com/a/b.git', auth_type: 'none', branch: 'main' },
      { git_url: 'ftp://bad', auth_type: 'none', branch: '' },
    ],
    apis: [{ name: 'bad name', base_url: 'not-a-url', auth_header: '', allowed_methods: 'GET' }],
  });
  assert.ok(errors.includes('Repo #2: Git URL must be an HTTPS URL or an SSH Git URL.'));
  assert.ok(errors.includes('Repo #2: Branch is required.'));
  assert.ok(errors.includes('API group #1: API group name must use letters, numbers, underscores, and hyphens only.'));
  assert.ok(errors.includes('API group #1: Base URL must be a valid http or https URL.'));
  assert.ok(errors.includes('API group #1: Auth header is required.'));
});

test('blank secret on an existing row inherits the stored secret; new row still errors', () => {
  const existingRepos = [{ id: 7, git_url: 'https://github.com/a/b.git', auth_type: 'https-token',
    token: 'stored-tok', ssh_key: null, branch: 'main' }];
  const ok = validateProjectBundle({
    ...goodProject,
    repos: [{ id: '7', git_url: 'https://github.com/a/b.git', auth_type: 'https-token', token: '', ssh_key: '', branch: 'main' }],
  }, { existingRepos });
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.values.repos[0].token, 'stored-tok');
  assert.strictEqual(ok.values.repos[0].id, 7);

  const bad = validateProjectBundle({
    ...goodProject,
    repos: [{ git_url: 'https://github.com/a/c.git', auth_type: 'https-token', token: '', ssh_key: '', branch: 'main' }],
  }, { existingRepos });
  assert.ok(bad.errors.includes('Repo #1: Token is required for https-token repositories.'));
});

test('blank api_key on an existing row inherits the stored key', () => {
  const existingApis = [{ id: 3, name: 'txn', base_url: 'https://api.x', api_key: 'stored-key',
    auth_header: 'Authorization', allowed_methods: 'GET', description_md: '' }];
  const { values, errors } = validateProjectBundle({
    ...goodProject,
    apis: [{ id: '3', name: 'txn', base_url: 'https://api.x', api_key: '', auth_header: 'Authorization',
      allowed_methods: 'GET', description_md: '' }],
  }, { existingApis });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(values.apis[0].api_key, 'stored-key');
  assert.strictEqual(values.apis[0].id, 3);
});

test('duplicate API group names are rejected', () => {
  const { errors } = validateProjectBundle({
    ...goodProject,
    apis: [
      { name: 'txn', base_url: 'https://api.x', auth_header: 'Authorization', allowed_methods: 'GET' },
      { name: 'txn', base_url: 'https://api.y', auth_header: 'Authorization', allowed_methods: 'GET' },
    ],
  });
  assert.ok(errors.includes('API group names must be unique.'));
});
