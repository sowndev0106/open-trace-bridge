const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const cheerio = require('cheerio');

process.env.OTB_DB_PATH = ':memory:';

const { adminApp } = require('../server');
const { resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const apicalls = require('../models/apicall.model');
const sync = require('../services/sync.service');

beforeEach(() => {
  resetDbForTest();
});

function seedProject(overrides = {}) {
  return projects.create({
    slug: 'payment',
    name: 'Payment',
    keyword: 'payment-bot',
    system_prompt: 'Investigate payment incidents.',
    teams_webhook_url: 'https://hook.example/payment',
    max_msg_length: 20000,
    ...overrides,
  });
}

test('admin layout links the compiled Tailwind stylesheet and serves it', async () => {
  seedProject();

  const page = await request(adminApp).get('/admin/projects').expect(200);
  assert.match(page.text, /\/assets\/styles\/admin\.css/);
  assert.match(page.text, /OpenTraceBridge/);

  const css = await request(adminApp).get('/assets/styles/admin.css').expect(200);
  assert.match(css.text, /\.app-shell|\.btn|\.panel/);
});

test('projects index renders modern project table actions and endpoint copy', async () => {
  const project = seedProject();

  const response = await request(adminApp).get('/admin/projects').expect(200);
  const $ = cheerio.load(response.text);

  assert.strictEqual($('h1').text().trim(), 'Projects');
  assert.strictEqual($('a[href="/admin/projects/new"]').first().text().trim(), 'New project');
  assert.strictEqual($(`a[href="/admin/projects/${project.id}/edit"]`).length, 1);
  assert.strictEqual($(`form[action="/admin/projects/${project.id}/delete"][method="post"]`).length, 1);
  assert.match(response.text, /\/api\/events\/payment/);
  assert.match(response.text, /payment-bot/);
  assert.match(response.text, /table-shell/);
});

test('project edit form preserves workflows inside redesigned panels', async () => {
  const project = seedProject();
  repos.create({
    project_id: project.id,
    git_url: 'https://github.com/acme/payment.git',
    auth_type: 'none',
    branch: 'main',
  });
  apis.create({
    project_id: project.id,
    name: 'transaction-api',
    base_url: 'https://api.internal',
    api_key: '',
    auth_header: 'Authorization',
    allowed_methods: 'GET',
    description_md: 'Read transactions.',
  });

  const response = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(response.text);

  assert.strictEqual($(`form[action="/admin/projects/${project.id}"][method="post"]`).length, 1);
  assert.strictEqual($('input[name="slug"]').val(), 'payment');
  assert.strictEqual($('input[name="name"]').val(), 'Payment');
  assert.strictEqual($('input[name="keyword"]').val(), 'payment-bot');
  assert.strictEqual($('textarea[name="system_prompt"]').text(), 'Investigate payment incidents.');
  assert.strictEqual($('input[name="teams_webhook_url"]').val(), 'https://hook.example/payment');
  assert.strictEqual($('input[name="max_msg_length"]').val(), '20000');
  assert.strictEqual($(`a[href="/admin/projects/${project.id}/conversations"]`).text().trim(), 'Open audit trail');
  assert.strictEqual($(`form[action="/admin/projects/${project.id}/repos"][method="post"]`).length, 1);
  assert.strictEqual($(`form[action="/admin/projects/${project.id}/apis"][method="post"]`).length, 1);
  assert.match(response.text, /https:\/\/6666\.sowndev\.com\/api\/events\/payment/);
  assert.match(response.text, /panel-body/);
});

test('project create validation shows all field errors and preserves input', async () => {
  const response = await request(adminApp)
    .post('/admin/projects')
    .type('form')
    .send({
      slug: 'Bad Slug!',
      name: '',
      keyword: 'bad keyword',
      system_prompt: 'Keep this prompt',
      teams_webhook_url: 'not-a-url',
      max_msg_length: '100',
    })
    .expect(400);

  const $ = cheerio.load(response.text);
  const errors = $('.error-list li').map((_, el) => $(el).text()).get();

  assert.ok(errors.includes('Slug must use lowercase letters, numbers, and hyphens only.'));
  assert.ok(errors.includes('Name is required.'));
  assert.ok(errors.includes('Keyword must use letters, numbers, underscores, and hyphens only.'));
  assert.ok(errors.includes('Teams webhook URL must be a valid http or https URL.'));
  assert.ok(errors.includes('Max message length must be at least 500.'));
  assert.strictEqual($('input[name="slug"]').val(), 'Bad Slug!');
  assert.strictEqual($('textarea[name="system_prompt"]').text(), 'Keep this prompt');
});

test('repo validation rejects invalid auth and missing credentials without creating a repo', async () => {
  const project = seedProject();

  const response = await request(adminApp)
    .post(`/admin/projects/${project.id}/repos`)
    .type('form')
    .send({
      git_url: 'ftp://example.com/repo.git',
      auth_type: 'https-token',
      token: '',
      ssh_key: '',
      branch: '',
    })
    .expect(400);

  const $ = cheerio.load(response.text);
  const errors = $('.error-list li').map((_, el) => $(el).text()).get();

  assert.ok(errors.includes('Git URL must be an HTTPS URL or an SSH Git URL.'));
  assert.ok(errors.includes('Token is required for https-token repositories.'));
  assert.ok(errors.includes('Branch is required.'));
  assert.strictEqual(repos.listByProject(project.id).length, 0);
});

test('api group validation rejects invalid URL and methods without creating a group', async () => {
  const project = seedProject();

  const response = await request(adminApp)
    .post(`/admin/projects/${project.id}/apis`)
    .type('form')
    .send({
      name: 'bad name',
      base_url: 'not-a-url',
      api_key: '',
      auth_header: '',
      allowed_methods: 'GET,TRACE',
      description_md: 'Keep this description',
    })
    .expect(400);

  const $ = cheerio.load(response.text);
  const errors = $('.error-list li').map((_, el) => $(el).text()).get();

  assert.ok(errors.includes('API group name must use letters, numbers, underscores, and hyphens only.'));
  assert.ok(errors.includes('Base URL must be a valid http or https URL.'));
  assert.ok(errors.includes('Auth header is required.'));
  assert.ok(errors.includes('Allowed methods can only include GET, POST, PUT, PATCH, and DELETE.'));
  assert.strictEqual(apis.listByProject(project.id).length, 0);
  assert.match(response.text, /Keep this description/);
});

test('api group can be created from pasted curl and markdown description', async () => {
  const project = seedProject();

  await request(adminApp)
    .post(`/admin/projects/${project.id}/apis`)
    .type('form')
    .send({
      name: 'transaction-api',
      curl_command: `curl -X POST -H "Authorization: Bearer sk_live_123" "https://api.internal.example/v1/transactions/search?limit=10"`,
      description_md: 'Search transactions by reference id.',
    })
    .expect(302);

  const rows = apis.listByProject(project.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'transaction-api');
  assert.strictEqual(rows[0].base_url, 'https://api.internal.example/v1');
  assert.strictEqual(rows[0].api_key, 'Bearer sk_live_123');
  assert.strictEqual(rows[0].auth_header, 'Authorization');
  assert.strictEqual(rows[0].allowed_methods, 'POST');
  assert.strictEqual(rows[0].description_md, 'Search transactions by reference id.');
});

test('conversation audit list renders redesigned tables', async () => {
  const project = seedProject();
  const conversation = convs.create(project.id, 'teams-conv-1');
  convs.setSession(conversation.id, 'ses_abc');
  apicalls.add({
    project_id: project.id,
    group_name: 'transaction-api',
    method: 'GET',
    url: 'https://api.internal/transactions/txn_123',
    status: 200,
  });

  const response = await request(adminApp).get(`/admin/projects/${project.id}/conversations`).expect(200);
  const $ = cheerio.load(response.text);

  assert.strictEqual($('h1').text().trim(), 'Conversations');
  assert.match(response.text, /Payment/);
  assert.strictEqual($(`a[href="/admin/conversations/${conversation.id}"]`).length, 1);
  assert.match(response.text, /ses_abc/);
  assert.match(response.text, /transaction-api/);
  assert.match(response.text, /Latest API calls/);
  assert.match(response.text, /table-shell/);
});

test('conversation detail renders message timeline', async () => {
  const project = seedProject();
  const conversation = convs.create(project.id, 'teams-conv-1');
  convs.setSession(conversation.id, 'ses_abc');
  messages.add({
    conversation_id: conversation.id,
    direction: 'in',
    user_id: 'u1',
    user_name: 'Son',
    content: 'investigate txn_123',
  });
  messages.add({
    conversation_id: conversation.id,
    direction: 'out',
    user_id: null,
    user_name: null,
    content: 'I found the failing API call.',
  });

  const response = await request(adminApp).get(`/admin/conversations/${conversation.id}`).expect(200);
  const $ = cheerio.load(response.text);

  assert.strictEqual($('h1').text().trim(), `Conversation #${conversation.id}`);
  assert.match(response.text, /Payment/);
  assert.match(response.text, /ses_abc/);
  assert.match(response.text, /Son/);
  assert.match(response.text, /investigate txn_123/);
  assert.match(response.text, /I found the failing API call/);
  assert.match(response.text, /message-timeline/);
});

test('project save, repo add/delete, and Sync now all trigger a background sync', async () => {
  const triggered = [];
  const origTrigger = sync.triggerSync;
  sync.triggerSync = (id, opts = {}) => { triggered.push({ id: Number(id), reason: opts.reason }); return Promise.resolve(); };
  try {
    await request(adminApp).post('/admin/projects').type('form').send({
      slug: 'billing', name: 'Billing', keyword: 'billing-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/b', max_msg_length: '20000',
    }).expect(302);
    const project = projects.findBySlug('billing');
    await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
      slug: 'billing', name: 'Billing 2', keyword: 'billing-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/b', max_msg_length: '20000',
    }).expect(302);
    await request(adminApp).post(`/admin/projects/${project.id}/repos`).type('form').send({
      git_url: 'https://github.com/acme/billing.git', auth_type: 'none', branch: 'main',
    }).expect(302);
    const repo = repos.listByProject(project.id)[0];
    await request(adminApp).post(`/admin/projects/${project.id}/repos/${repo.id}/delete`).expect(302);
    await request(adminApp).post(`/admin/projects/${project.id}/sync`).expect(302);
    assert.deepStrictEqual(triggered.map((t) => t.id), Array(5).fill(project.id));
    assert.strictEqual(triggered[4].reason, 'manual');
  } finally {
    sync.triggerSync = origTrigger;
  }
});

test('sync-status endpoint returns derived project status and per-repo rows', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git',
    auth_type: 'none', branch: 'main' });
  repos.setSyncStatus(repo.id, { status: 'error', error: 'auth denied' });

  const res = await request(adminApp).get(`/admin/projects/${project.id}/sync-status`).expect(200);
  assert.strictEqual(res.body.project, 'error');
  assert.strictEqual(res.body.repos.length, 1);
  assert.strictEqual(res.body.repos[0].sync_status, 'error');
  assert.strictEqual(res.body.repos[0].sync_error, 'auth denied');
  assert.ok(res.body.repos[0].synced_at);

  await request(adminApp).get('/admin/projects/999/sync-status').expect(404);
});

test('projects list shows a source sync badge per project', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git',
    auth_type: 'none', branch: 'main' });
  repos.setSyncStatus(repo.id, { status: 'success' });

  const res = await request(adminApp).get('/admin/projects').expect(200);
  const $ = cheerio.load(res.text);
  assert.match($('thead').text(), /Source/);
  assert.strictEqual($('[data-project-sync]').first().text().trim(), 'success');
});

test('project edit shows per-repo status, error detail, and a Sync now button', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git',
    auth_type: 'none', branch: 'main' });
  repos.setSyncStatus(repo.id, { status: 'error', error: 'auth denied' });

  const res = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(res.text);
  assert.strictEqual($(`form[action="/admin/projects/${project.id}/sync"]`).length, 1);
  assert.strictEqual($(`[data-repo-status="${repo.id}"] .status-badge`).text().trim(), 'error');
  assert.match($(`[data-repo-status="${repo.id}"]`).text(), /auth denied/);
});

test('project edit embeds the status poller only while a sync is unfinished', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git',
    auth_type: 'none', branch: 'main' }); // sync_status defaults to 'pending'

  let res = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  assert.match(res.text, /sync-status/);

  repos.setSyncStatus(repo.id, { status: 'success' });
  res = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  assert.ok(!/setInterval/.test(res.text));
});
