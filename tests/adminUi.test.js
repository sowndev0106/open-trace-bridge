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
    chat_retention_days: 90,
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
  assert.strictEqual($(`a[href="/admin/projects/${project.id}/conversations"]`).filter((_, el) => $(el).text().trim() === 'View logs').length, 1);
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
  assert.strictEqual($('input[name="chat_retention_days"]').val(), '90');
  assert.ok($(`a[href="/admin/projects/${project.id}/conversations"]`).filter((_, el) => $(el).text().trim() === 'Open audit trail').length >= 1);
  assert.strictEqual($('input[name="repos[0][git_url]"]').val(), 'https://github.com/acme/payment.git');
  assert.strictEqual($('input[name="apis[0][name]"]').val(), 'transaction-api');
  assert.strictEqual($('template[data-template="repos"]').length, 1);
  assert.strictEqual($('template[data-template="apis"]').length, 1);
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
      chat_retention_days: '90',
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

test('project form saves chat retention days', async () => {
  const project = seedProject();

  await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
    slug: 'payment',
    name: 'Payment',
    keyword: 'payment-bot',
    system_prompt: 'Investigate payment incidents.',
    teams_webhook_url: 'https://hook.example/payment',
    max_msg_length: '20000',
    chat_retention_days: '30',
  }).expect(302);

  const updated = projects.findById(project.id);
  assert.strictEqual(updated.chat_retention_days, 30);

  const response = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(response.text);
  assert.strictEqual($('input[name="chat_retention_days"]').val(), '30');
});

test('bundle validation rejects a bad repo row with prefixed errors and creates nothing', async () => {
  const project = seedProject();
  const response = await request(adminApp)
    .post(`/admin/projects/${project.id}`)
    .type('form')
    .send({
      slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
      chat_retention_days: '90',
      'repos[0][git_url]': 'ftp://example.com/repo.git',
      'repos[0][auth_type]': 'https-token',
      'repos[0][token]': '', 'repos[0][ssh_key]': '', 'repos[0][branch]': '',
    })
    .expect(400);
  const $ = cheerio.load(response.text);
  const errors = $('.error-list li').map((_, el) => $(el).text()).get();
  assert.ok(errors.includes('Repo #1: Git URL must be an HTTPS URL or an SSH Git URL.'));
  assert.ok(errors.includes('Repo #1: Token is required for https-token repositories.'));
  assert.ok(errors.includes('Repo #1: Branch is required.'));
  assert.strictEqual(repos.listByProject(project.id).length, 0);
});

test('bundle validation rejects a bad API row with prefixed errors and creates nothing', async () => {
  const project = seedProject();
  const response = await request(adminApp)
    .post(`/admin/projects/${project.id}`)
    .type('form')
    .send({
      slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
      chat_retention_days: '90',
      'apis[0][name]': 'bad name', 'apis[0][base_url]': 'not-a-url',
      'apis[0][auth_header]': '', 'apis[0][allowed_methods]': 'GET,TRACE',
      'apis[0][description_md]': 'Keep this description',
    })
    .expect(400);
  const $ = cheerio.load(response.text);
  const errors = $('.error-list li').map((_, el) => $(el).text()).get();
  assert.ok(errors.includes('API group #1: API group name must use letters, numbers, underscores, and hyphens only.'));
  assert.ok(errors.includes('API group #1: Base URL must be a valid http or https URL.'));
  assert.ok(errors.includes('API group #1: Auth header is required.'));
  assert.ok(errors.includes('API group #1: Allowed methods can only include GET, POST, PUT, PATCH, and DELETE.'));
  assert.strictEqual(apis.listByProject(project.id).length, 0);
  assert.match(response.text, /Keep this description/);
});

test('api group can be created from pasted curl and markdown description', async () => {
  const project = seedProject();

  await request(adminApp)
    .post(`/admin/projects/${project.id}`)
    .type('form')
    .send({
      slug: 'payment',
      name: 'Payment',
      keyword: 'payment-bot',
      system_prompt: 'Investigate payment incidents.',
      teams_webhook_url: 'https://hook.example/payment',
      max_msg_length: '20000',
      chat_retention_days: '90',
      'apis[0][name]': 'transaction-api',
      'apis[0][curl_command]': `curl -X POST -H "Authorization: Bearer sk_live_123" "https://api.internal.example/v1/transactions/search?limit=10"`,
      'apis[0][description_md]': 'Search transactions by reference id.',
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

test('api row form only offers name, curl, and description inputs plus a parsed summary', async () => {
  const project = seedProject();
  apis.create({
    project_id: project.id,
    name: 'transaction-api',
    base_url: 'https://api.internal.example/v1',
    api_key: 'Bearer sk_live_123',
    auth_header: 'Authorization',
    allowed_methods: 'POST',
    description_md: 'Search transactions.',
  });

  const response = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(response.text);

  assert.strictEqual($('input[name="apis[0][name]"]').length, 1);
  assert.strictEqual($('textarea[name="apis[0][curl_command]"]').length, 1);
  assert.strictEqual($('textarea[name="apis[0][description_md]"]').length, 1);
  assert.strictEqual($('input[name="apis[0][base_url]"]').length, 0);
  assert.strictEqual($('input[name="apis[0][auth_header]"]').length, 0);
  assert.strictEqual($('input[name="apis[0][allowed_methods]"]').length, 0);
  assert.strictEqual($('input[name="apis[0][api_key]"]').length, 0);
  assert.match(response.text, /POST https:\/\/api\.internal\.example\/v1/);
  assert.doesNotMatch(response.text, /sk_live_123/);
});

test('existing API row keeps parsed fields when saved without a new curl command', async () => {
  const project = seedProject();
  const api = apis.create({
    project_id: project.id,
    name: 'transaction-api',
    base_url: 'https://api.internal.example/v1',
    api_key: 'Bearer sk_live_123',
    auth_header: 'Authorization',
    allowed_methods: 'POST',
    description_md: 'Old description.',
  });

  await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
    slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
    teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
    chat_retention_days: '90',
    'apis[0][id]': String(api.id),
    'apis[0][name]': 'transaction-api',
    'apis[0][curl_command]': '',
    'apis[0][description_md]': 'New description.',
  }).expect(302);

  const rows = apis.listByProject(project.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].base_url, 'https://api.internal.example/v1');
  assert.strictEqual(rows[0].api_key, 'Bearer sk_live_123');
  assert.strictEqual(rows[0].auth_header, 'Authorization');
  assert.strictEqual(rows[0].allowed_methods, 'POST');
  assert.strictEqual(rows[0].description_md, 'New description.');
});

test('new API row without a curl command is rejected', async () => {
  const project = seedProject();
  const response = await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
    slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
    teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
    chat_retention_days: '90',
    'apis[0][name]': 'transaction-api',
    'apis[0][curl_command]': '',
    'apis[0][description_md]': 'No curl provided.',
  }).expect(400);

  const $ = cheerio.load(response.text);
  const errors = $('.error-list li').map((_, el) => $(el).text()).get();
  assert.ok(errors.includes('API group #1: Curl command is required.'));
  assert.strictEqual(apis.listByProject(project.id).length, 0);
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

test('conversation detail shows the API calls made by that conversation with full detail', async () => {
  const project = seedProject();
  const conversation = convs.create(project.id, 'teams-conv-1');
  const other = convs.create(project.id, 'teams-conv-2');
  apicalls.add({
    project_id: project.id, conversation_id: conversation.id,
    group_name: 'transaction-api', method: 'GET',
    url: 'https://api.internal/transactions/txn_123', status: 200,
    request_params: '{"limit":"10"}', response_body: '{"total":2}', duration_ms: 123,
  });
  apicalls.add({
    project_id: project.id, conversation_id: other.id,
    group_name: 'transaction-api', method: 'GET',
    url: 'https://api.internal/transactions/txn_OTHER', status: 200,
  });

  const response = await request(adminApp).get(`/admin/conversations/${conversation.id}`).expect(200);
  const $ = cheerio.load(response.text);

  assert.match(response.text, /API calls/);
  assert.strictEqual($('[data-api-call-row]').length, 1);
  assert.match(response.text, /txn_123/);
  assert.doesNotMatch(response.text, /txn_OTHER/);
  assert.match(response.text, /(&quot;|&#34;)limit(&quot;|&#34;)|"limit"/);
  assert.match(response.text, /(&quot;|&#34;)total(&quot;|&#34;)|"total"/);
});

test('project edit page shows latest API calls', async () => {
  const project = seedProject();
  apicalls.add({
    project_id: project.id,
    group_name: 'transaction-api',
    method: 'GET',
    url: 'https://api.internal/transactions/txn_123',
    status: 200,
  });

  const response = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(response.text);

  assert.match(response.text, /Latest API calls/);
  assert.match(response.text, /transaction-api/);
  assert.match(response.text, /https:\/\/api\.internal\/transactions\/txn_123/);
  assert.strictEqual($('[data-api-call-row]').length, 1);
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

test('project edit page links recent chat history', async () => {
  const project = seedProject();
  const conversation = convs.create(project.id, 'teams-conv-1');
  convs.setSession(conversation.id, 'ses_abc');
  messages.add({
    conversation_id: conversation.id,
    direction: 'in',
    user_id: 'u1',
    user_name: 'Son',
    content: 'payment-bot investigate txn_123',
  });

  const response = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(response.text);

  assert.match(response.text, /Chat history/);
  assert.match(response.text, /teams-conv-1/);
  assert.strictEqual($(`a[href="/admin/conversations/${conversation.id}"]`).length >= 1, true);
  assert.strictEqual($('[data-chat-history-row]').length, 1);
});

test('create, update, and Sync now each trigger exactly one background sync', async () => {
  const triggered = [];
  const origTrigger = sync.triggerSync;
  sync.triggerSync = (id, opts = {}) => { triggered.push({ id: Number(id), reason: opts.reason }); return Promise.resolve(); };
  try {
    await request(adminApp).post('/admin/projects').type('form').send({
      slug: 'billing', name: 'Billing', keyword: 'billing-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/b', max_msg_length: '20000', chat_retention_days: '90',
      'repos[0][git_url]': 'https://github.com/acme/billing.git',
      'repos[0][auth_type]': 'none', 'repos[0][branch]': 'main',
      'repos[0][token]': '', 'repos[0][ssh_key]': '',
    }).expect(302);
    const project = projects.findBySlug('billing');
    assert.strictEqual(repos.listByProject(project.id).length, 1);
    await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
      slug: 'billing', name: 'Billing 2', keyword: 'billing-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/b', max_msg_length: '20000', chat_retention_days: '90',
    }).expect(302);
    await request(adminApp).post(`/admin/projects/${project.id}/sync`).expect(302);
    assert.deepStrictEqual(triggered.map((t) => t.reason), ['create', 'update', 'manual']);
    assert.deepStrictEqual(triggered.map((t) => t.id), Array(3).fill(project.id));
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

test('save-all reconciles rows: edit one, add one, omit one (deleted)', async () => {
  const project = seedProject();
  const keep = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/keep.git', auth_type: 'none', branch: 'main' });
  const drop = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/drop.git', auth_type: 'none', branch: 'main' });
  const origTrigger = sync.triggerSync;
  sync.triggerSync = () => Promise.resolve();
  try {
    await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
      slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
      chat_retention_days: '90',
      'repos[0][id]': String(keep.id),
      'repos[0][git_url]': 'https://github.com/acme/keep.git',
      'repos[0][auth_type]': 'none', 'repos[0][branch]': 'release',
      'repos[0][token]': '', 'repos[0][ssh_key]': '',
      'repos[1][git_url]': 'https://github.com/acme/new.git',
      'repos[1][auth_type]': 'none', 'repos[1][branch]': 'main',
      'repos[1][token]': '', 'repos[1][ssh_key]': '',
    }).expect(302);
  } finally {
    sync.triggerSync = origTrigger;
  }
  const rows = repos.listByProject(project.id);
  assert.strictEqual(rows.length, 2);
  const kept = rows.find((r) => r.id === keep.id);
  assert.strictEqual(kept.branch, 'release');
  assert.strictEqual(kept.sync_status, 'pending'); // branch changed -> resync
  assert.ok(rows.some((r) => r.git_url === 'https://github.com/acme/new.git'));
  assert.ok(!rows.some((r) => r.id === drop.id));
});

test('blank token on save keeps the stored secret; secrets are never echoed', async () => {
  const project = seedProject();
  const repo = repos.create({ project_id: project.id, git_url: 'https://github.com/acme/sec.git',
    auth_type: 'https-token', token: 'ghp_supersecrettoken', branch: 'main' });
  const origTrigger = sync.triggerSync;
  sync.triggerSync = () => Promise.resolve();
  try {
    await request(adminApp).post(`/admin/projects/${project.id}`).type('form').send({
      slug: 'payment', name: 'Payment', keyword: 'payment-bot', system_prompt: 'x',
      teams_webhook_url: 'https://hook.example/payment', max_msg_length: '20000',
      chat_retention_days: '90',
      'repos[0][id]': String(repo.id),
      'repos[0][git_url]': 'https://github.com/acme/sec.git',
      'repos[0][auth_type]': 'https-token', 'repos[0][branch]': 'main',
      'repos[0][token]': '', 'repos[0][ssh_key]': '',
    }).expect(302);
  } finally {
    sync.triggerSync = origTrigger;
  }
  assert.strictEqual(repos.listByProject(project.id)[0].token, 'ghp_supersecrettoken');

  const page = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  assert.ok(!page.text.includes('ghp_supersecrettoken'));
  const $ = cheerio.load(page.text);
  assert.strictEqual($('input[name="repos[0][token]"]').attr('type'), 'password');
  assert.strictEqual($('input[name="repos[0][token]"]').val() || '', '');
  assert.strictEqual($('input[name="apis[0][api_key]"]').length, 0); // no api rows seeded
});

test('Save button is at the top inside the single unified form', async () => {
  const project = seedProject();
  const res = await request(adminApp).get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(res.text);
  const mainForm = $(`form[action="/admin/projects/${project.id}"]`);
  assert.strictEqual(mainForm.length, 1);
  // Save button lives in the header section (first section inside the form).
  assert.strictEqual(mainForm.find('section').first().find('button.btn-primary[type="submit"]').text().trim(), 'Save');
  // Sync now posts through the external sync form.
  assert.strictEqual($(`form#sync-form[action="/admin/projects/${project.id}/sync"]`).length, 1);
  assert.strictEqual($('button[form="sync-form"]').length, 1);
});
