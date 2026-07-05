# Curl API Groups And Project Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins add callable APIs by pasting a curl command plus markdown description, show recent OpenCode tool API calls directly on the project edit page, preserve complete chat history, and clean old history according to each project's retention setting.

**Architecture:** Add a small parser service that converts a pasted curl command into the existing `api_groups` fields, redacts secrets before anything reaches `AGENTS.md`, and keeps the existing guarded `call_api` MCP path unchanged. Reuse the existing `api_calls`, `conversations`, and `messages` tables for project-level audit and chat history visibility, then add a project retention setting plus a lightweight interval cleanup service for old conversations, messages, and API call rows.

**Tech Stack:** Node.js CommonJS, Express, EJS, better-sqlite3, node:test, supertest, cheerio.

## Global Constraints

- Source code, comments, user-facing strings, tests, documentation, README files, generated prompts, and future notes must be written in English.
- Keep secrets out of commits and out of generated workspace prompts.
- Preserve the two-port boundary: public event ingestion remains on `PORT`; admin UI and `/internal` APIs remain private on `ADMIN_PORT`.
- Do not change the MCP tool contract unless a task explicitly says so.
- Chat history retention defaults to 90 days; `0` disables automatic deletion for that project.
- Run tests with `npm test` or targeted `node --test tests/<file>.test.js`.

---

## File Structure

- Create `services/curlApiGroup.service.js`: owns curl tokenization, curl-to-api-group parsing, auth header extraction, URL/method extraction, and secret redaction.
- Modify `services/adminValidation.js`: accepts either legacy structured API fields or new `curl_command` input and normalizes both into the existing `api_groups` row shape.
- Modify `controllers/project.controller.js`: passes recent API calls to the project edit view and preserves the new API draft fields on validation failure.
- Modify `views/projects/form.ejs`: replaces the API group input area with a paste-friendly curl + markdown description workflow and adds a recent API calls table to the project view.
- Modify `services/workspace.service.js`: ensures generated `AGENTS.md` never contains raw API keys from API group descriptions.
- Modify `controllers/event.controller.js`: stores every Teams command and bot/system result in `messages`, including `/pull-source`.
- Modify `lib/db.js`: adds a `projects.chat_retention_days` column with migration support.
- Modify `models/project.model.js`: reads and writes `chat_retention_days`.
- Modify `models/conversation.model.js`, `models/message.model.js`, and `models/apicall.model.js`: add cleanup/query helpers needed by retention tests.
- Create `services/retention.service.js`: computes per-project cutoffs and deletes old chat/API audit rows.
- Modify `server.js`: starts the retention interval only in the real server process.
- Modify `tests/callapi.test.js`: adds parser and redaction unit tests.
- Modify `tests/adminUi.test.js`: adds admin UI tests for curl-based API group creation, project-page audit visibility, chat history access, and retention settings.
- Modify `tests/eventController.test.js`: verifies `/pull-source` is persisted in chat history.
- Create `tests/retention.test.js`: verifies retention cleanup deletes old rows and honors disabled retention.
- Modify `README.md`: updates Admin Setup docs to describe curl + markdown API configuration.

---

### Task 1: Add Curl Parsing And Secret Redaction Service

**Files:**
- Create: `services/curlApiGroup.service.js`
- Test: `tests/callapi.test.js`

**Interfaces:**
- Consumes: raw strings from admin form fields `curl_command`, `description_md`, optional `name`.
- Produces:
  - `parseCurlApiGroupInput({ name: string, curl_command: string, description_md: string }): { name, base_url, api_key, auth_header, allowed_methods, description_md }`
  - `redactApiSecrets(text: string, apiGroups: Array<{ api_key: string }>): string`

- [ ] **Step 1: Write failing parser tests**

Add these tests to the bottom of `tests/callapi.test.js`:

```js
const {
  parseCurlApiGroupInput,
  redactApiSecrets,
} = require('../services/curlApiGroup.service');

test('parses pasted curl into an API group using bearer auth', () => {
  const parsed = parseCurlApiGroupInput({
    name: 'transaction-api',
    curl_command: `curl -X POST \\
      -H "Authorization: Bearer sk_live_123" \\
      -H "Accept: application/json" \\
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/callapi.test.js
```

Expected: FAIL with `Cannot find module '../services/curlApiGroup.service'`.

- [ ] **Step 3: Implement the parser service**

Create `services/curlApiGroup.service.js`:

```js
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
  const label = host.length > 1 ? host[host.length - 2] : host[0];
  return `${label || 'api'}-api`.replace(/[^A-Za-z0-9_-]/g, '-');
}

function deriveBaseUrl(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const baseParts = parts.length > 1 ? parts.slice(0, -1) : [];
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
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
node --test tests/callapi.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/curlApiGroup.service.js tests/callapi.test.js
git commit -m "feat: parse curl api group input"
```

---

### Task 2: Wire Curl Input Into Admin API Group Creation

**Files:**
- Modify: `services/adminValidation.js`
- Modify: `controllers/project.controller.js`
- Modify: `views/projects/form.ejs`
- Test: `tests/adminUi.test.js`

**Interfaces:**
- Consumes: `validateApiGroupInput(input)` with either `input.curl_command` or legacy structured fields.
- Produces: existing normalized API group row shape `{ name, base_url, api_key, auth_header, allowed_methods, description_md }`.

- [ ] **Step 1: Write failing admin creation test**

Add this test to `tests/adminUi.test.js` after `api group validation rejects invalid URL and methods without creating a group`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/adminUi.test.js --test-name-pattern "api group can be created"
```

Expected: FAIL because `curl_command` is ignored and `base_url` is required.

- [ ] **Step 3: Update validation to support curl input**

Modify `services/adminValidation.js`:

```js
const { parseCurlApiGroupInput } = require('./curlApiGroup.service');
```

Then replace the existing `validateApiGroupInput` function with:

```js
function validateApiGroupInput(input) {
  const errors = [];

  if (clean(input.curl_command)) {
    try {
      const parsed = parseCurlApiGroupInput(input);
      const methods = normalizeMethods(parsed.allowed_methods || 'GET');
      if (!methods.length || methods.some((method) => !ALLOWED_METHODS.has(method))) {
        errors.push('Allowed methods can only include GET, POST, PUT, PATCH, and DELETE.');
      }
      return {
        values: { ...parsed, allowed_methods: methods.join(',') },
        errors,
      };
    } catch (err) {
      return {
        values: {
          name: clean(input.name),
          base_url: '',
          api_key: '',
          auth_header: 'Authorization',
          allowed_methods: 'GET',
          description_md: String(input.description_md ?? ''),
          curl_command: String(input.curl_command ?? ''),
        },
        errors: [err.message],
      };
    }
  }

  const methods = normalizeMethods(input.allowed_methods || 'GET');
  const values = {
    name: clean(input.name),
    base_url: clean(input.base_url),
    api_key: String(input.api_key ?? ''),
    auth_header: clean(input.auth_header),
    allowed_methods: methods.join(','),
    description_md: String(input.description_md ?? ''),
  };

  if (!values.name) {
    errors.push('API group name is required.');
  } else if (!TOKEN_RE.test(values.name)) {
    errors.push('API group name must use letters, numbers, underscores, and hyphens only.');
  }

  if (!values.base_url) {
    errors.push('Base URL is required.');
  } else if (!isHttpUrl(values.base_url)) {
    errors.push('Base URL must be a valid http or https URL.');
  }

  if (!values.auth_header) errors.push('Auth header is required.');
  if (!methods.length || methods.some((method) => !ALLOWED_METHODS.has(method))) {
    errors.push('Allowed methods can only include GET, POST, PUT, PATCH, and DELETE.');
  }

  return { values, errors };
}
```

- [ ] **Step 4: Update project form API section**

In `views/projects/form.ejs`, replace the API add form body starting at `<form method="post" action="/admin/projects/<%= project.id %>/apis"` with:

```ejs
      <form method="post" action="/admin/projects/<%= project.id %>/apis" class="space-y-4">
        <div>
          <label for="api_name">Name</label>
          <input id="api_name" type="text" name="name" value="<%= apiValues.name || '' %>" placeholder="transaction-api" pattern="[A-Za-z0-9_-]+">
          <p class="field-help">Optional. If left blank, OpenTraceBridge derives a name from the curl URL host.</p>
        </div>
        <div>
          <label for="curl_command">Curl command</label>
          <textarea id="curl_command" name="curl_command" placeholder='curl -H "Authorization: Bearer sk_live_xxx" "https://api.internal.example/v1/transactions/txn_123"'><%= apiValues.curl_command || '' %></textarea>
          <p class="field-help">Paste a working curl command. The server stores the auth header value and only exposes the markdown description to the agent.</p>
        </div>
        <div>
          <label for="description_md">Markdown description</label>
          <textarea id="description_md" name="description_md" placeholder="Document endpoints, params, filters, and response fields for the agent."><%= apiValues.description_md || '' %></textarea>
        </div>
        <button class="btn btn-secondary" type="submit">Add API group</button>
      </form>
```

- [ ] **Step 5: Run targeted admin test**

Run:

```bash
node --test tests/adminUi.test.js --test-name-pattern "api group can be created"
```

Expected: PASS.

- [ ] **Step 6: Run full admin UI test file**

Run:

```bash
node --test tests/adminUi.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/adminValidation.js views/projects/form.ejs tests/adminUi.test.js
git commit -m "feat: add curl api group workflow"
```

---

### Task 3: Redact API Secrets From Generated Workspace Instructions

**Files:**
- Modify: `services/workspace.service.js`
- Test: `tests/workspace.test.js`

**Interfaces:**
- Consumes: `redactApiSecrets(text, apiGroups)` from `services/curlApiGroup.service.js`.
- Produces: `buildAgentsMd(project, apiGroups)` output that never includes any `api_key` value.

- [ ] **Step 1: Write failing redaction test**

Add this test to `tests/workspace.test.js`:

```js
test('buildAgentsMd redacts API keys from API descriptions', () => {
  const markdown = workspace.buildAgentsMd(
    {
      name: 'Payment',
      system_prompt: 'Investigate incidents.',
    },
    [
      {
        name: 'transaction-api',
        base_url: 'https://api.internal.example/v1',
        allowed_methods: 'GET',
        api_key: 'Bearer sk_live_123',
        description_md: 'Use Bearer sk_live_123 when trying this locally.',
      },
    ]
  );

  assert.doesNotMatch(markdown, /sk_live_123/);
  assert.match(markdown, /\[REDACTED_API_KEY\]/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/workspace.test.js --test-name-pattern "redacts API keys"
```

Expected: FAIL because the raw key appears in `AGENTS.md`.

- [ ] **Step 3: Apply redaction in workspace generation**

Modify the top of `services/workspace.service.js`:

```js
const { redactApiSecrets } = require('./curlApiGroup.service');
```

Then replace the API section description interpolation in `buildAgentsMd`:

```js
${g.description_md}
```

with:

```js
${redactApiSecrets(g.description_md, apiGroups)}
```

- [ ] **Step 4: Run targeted workspace test**

Run:

```bash
node --test tests/workspace.test.js --test-name-pattern "redacts API keys"
```

Expected: PASS.

- [ ] **Step 5: Run parser and workspace tests together**

Run:

```bash
node --test tests/callapi.test.js tests/workspace.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/workspace.service.js tests/workspace.test.js
git commit -m "fix: redact api secrets from workspace instructions"
```

---

### Task 4: Show Latest API Calls In Project Edit View

**Files:**
- Modify: `controllers/project.controller.js`
- Modify: `views/projects/form.ejs`
- Test: `tests/adminUi.test.js`

**Interfaces:**
- Consumes: `apicalls.listByProject(project.id): Array<{ created_at, group_name, method, url, status }>`
- Produces: project edit render context property `apiCalls`, displayed in a `Latest API calls` table.

- [ ] **Step 1: Write failing project audit visibility test**

Add this test to `tests/adminUi.test.js` after `conversation audit list renders redesigned tables`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/adminUi.test.js --test-name-pattern "project edit page shows latest API calls"
```

Expected: FAIL because project edit does not receive or render `apiCalls`.

- [ ] **Step 3: Pass recent API calls to the project form**

Modify `controllers/project.controller.js`:

```js
const apicalls = require('../models/apicall.model');
```

Update `renderProjectForm` so it accepts and passes `apiCalls`:

```js
function renderProjectForm(res, status, { project, repoRows, apiRows, errors = [], repoDraft = null, apiDraft = null, apiCalls = [] }) {
  return res.status(status).render('projects/form', {
    project,
    repos: repoRows || [],
    apis: apiRows || [],
    apiCalls,
    errors,
    error: errors[0] || null,
    repoDraft,
    apiDraft,
  });
}
```

In every `renderProjectForm` call where `project` is an existing saved project, add:

```js
apiCalls: apicalls.listByProject(p.id).slice(0, 25),
```

For `newProjectForm` and project create validation, keep `apiCalls` omitted so it defaults to `[]`.

- [ ] **Step 4: Render the audit table on project edit**

In `views/projects/form.ejs`, after the Power Automate endpoint section and before the Repos section, add:

```ejs
  <section class="panel mb-6">
    <div class="panel-body">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="section-heading">Latest API calls</h2>
          <p class="mt-1 text-sm text-ink-500">Recent calls made through the OpenCode <code>call_api</code> tool for this project.</p>
        </div>
        <a class="btn btn-secondary" href="/admin/projects/<%= project.id %>/conversations">Open full audit</a>
      </div>

      <% if (apiCalls && apiCalls.length) { %>
        <div class="table-shell shadow-none">
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr><th>Time</th><th>Group</th><th>Method</th><th>URL</th><th>Status</th></tr>
              </thead>
              <tbody>
                <% for (const a of apiCalls) { %>
                <tr data-api-call-row>
                  <td><%= a.created_at %></td>
                  <td><%= a.group_name %></td>
                  <td><span class="status-badge status-muted"><%= a.method %></span></td>
                  <td class="max-w-xl truncate"><%= a.url %></td>
                  <td><%= a.status || '-' %></td>
                </tr>
                <% } %>
              </tbody>
            </table>
          </div>
        </div>
      <% } else { %>
        <div class="rounded-lg border border-dashed border-line bg-slate-50 px-4 py-5 text-sm text-ink-500">No API calls have been recorded yet.</div>
      <% } %>
    </div>
  </section>
```

- [ ] **Step 5: Run targeted project audit test**

Run:

```bash
node --test tests/adminUi.test.js --test-name-pattern "project edit page shows latest API calls"
```

Expected: PASS.

- [ ] **Step 6: Run full admin UI tests**

Run:

```bash
node --test tests/adminUi.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add controllers/project.controller.js views/projects/form.ejs tests/adminUi.test.js
git commit -m "feat: show api call audit on project page"
```

---

### Task 5: Preserve And Surface Complete Chat History

**Files:**
- Modify: `controllers/event.controller.js`
- Modify: `controllers/project.controller.js`
- Modify: `views/projects/form.ejs`
- Modify: `tests/eventController.test.js`
- Modify: `tests/adminUi.test.js`

**Interfaces:**
- Consumes: existing `messages.add({ conversation_id, direction, user_id, user_name, content })` and `convs.findActive/create`.
- Produces: all Teams commands, including `/pull-source`, are persisted to conversation history; project edit shows recent chat sessions with links to full detail.

- [ ] **Step 1: Write failing `/pull-source` history test**

In `tests/eventController.test.js`, add `messages` import:

```js
const messages = require('../models/message.model');
```

Then replace the final assertion block in `/pull-source responds immediately, syncs in background, posts summary`:

```js
  // No conversation is created or touched by /pull-source.
  assert.strictEqual(convs.findActive(project.id, 'c1'), undefined);
```

with:

```js
  const conv = convs.findActive(project.id, 'c1');
  assert.ok(conv);
  await waitFor(() => messages.listByConversation(conv.id).length === 2);
  const rows = messages.listByConversation(conv.id);
  assert.strictEqual(rows[0].direction, 'in');
  assert.strictEqual(rows[0].content, 'payment-bot /pull-source');
  assert.strictEqual(rows[1].direction, 'out');
  assert.match(rows[1].content, /Sources updated to latest/);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/eventController.test.js --test-name-pattern "/pull-source"
```

Expected: FAIL because `/pull-source` does not create or update a conversation.

- [ ] **Step 3: Persist `/pull-source` inbound and outbound messages**

In `controllers/event.controller.js`, inside the `if (isPullSource)` block and before `res.json(...)`, add:

```js
    let conv = convs.findActive(project.id, ev.conversationId);
    if (!conv) conv = convs.create(project.id, ev.conversationId);
    messages.add({ conversation_id: conv.id, direction: 'in', user_id: ev.userId, user_name: ev.userName, content: ev.text });
```

Then replace the `sync.syncProject(project.id).then(...)` block with this shape so the webhook result is also stored:

```js
    sync.syncProject(project.id)
      .then(({ ok, results }) => {
        const lines = results
          .map((r) => `- ${r.git_url}: ${r.status}${r.error ? ` - ${r.error}` : ''}`)
          .join('\n');
        const title = ok ? 'Sources updated to latest' : 'Source sync failed';
        const markdown = lines || 'No repositories configured.';
        messages.add({ conversation_id: conv.id, direction: 'out', content: `${title}\n\n${markdown}` });
        return webhook.sendTeamsMessage(project.teams_webhook_url, {
          status: ok ? 'success' : 'error',
          title,
          markdown,
          metadata: { project: project.slug },
          maxLength: project.max_msg_length,
        });
      })
      .catch((err) => {
        messages.add({ conversation_id: conv.id, direction: 'out', content: `[error] ${err.message}` });
        console.error(`pull-source fail (project=${project.slug}):`, err.message);
      });
```

- [ ] **Step 4: Write failing project chat history visibility test**

Add this test to `tests/adminUi.test.js` after `conversation detail renders message timeline`:

```js
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
```

- [ ] **Step 5: Run chat visibility test to verify it fails**

Run:

```bash
node --test tests/adminUi.test.js --test-name-pattern "project edit page links recent chat history"
```

Expected: FAIL because the project edit page does not render chat history.

- [ ] **Step 6: Pass recent conversations to the project edit view**

In `controllers/project.controller.js`, add:

```js
const convs = require('../models/conversation.model');
```

Update `renderProjectForm` to accept `conversationRows`:

```js
function renderProjectForm(res, status, { project, repoRows, apiRows, errors = [], repoDraft = null, apiDraft = null, apiCalls = [], conversationRows = [] }) {
  return res.status(status).render('projects/form', {
    project,
    repos: repoRows || [],
    apis: apiRows || [],
    apiCalls,
    conversations: conversationRows,
    errors,
    error: errors[0] || null,
    repoDraft,
    apiDraft,
  });
}
```

In every `renderProjectForm` call for an existing project, add:

```js
conversationRows: convs.listByProject(p.id).slice(0, 10),
```

- [ ] **Step 7: Render chat history on project edit**

In `views/projects/form.ejs`, after the Latest API calls section and before Repos, add:

```ejs
  <section class="panel mb-6">
    <div class="panel-body">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="section-heading">Chat history</h2>
          <p class="mt-1 text-sm text-ink-500">Recent Teams conversations saved for this project.</p>
        </div>
        <a class="btn btn-secondary" href="/admin/projects/<%= project.id %>/conversations">View all chats</a>
      </div>

      <% if (conversations && conversations.length) { %>
        <div class="table-shell shadow-none">
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr><th>ID</th><th>Teams conversation</th><th>OpenCode session</th><th>Status</th><th>Updated</th></tr>
              </thead>
              <tbody>
                <% for (const c of conversations) { %>
                <tr data-chat-history-row>
                  <td><a class="font-semibold text-brand hover:text-brand-dark" href="/admin/conversations/<%= c.id %>">#<%= c.id %></a></td>
                  <td><%= c.teams_conversation_id %></td>
                  <td><code><%= c.opencode_session_id || '-' %></code></td>
                  <td><span class="status-badge <%= c.status === 'active' ? 'status-active' : 'status-muted' %>"><%= c.status %></span></td>
                  <td><%= c.updated_at %></td>
                </tr>
                <% } %>
              </tbody>
            </table>
          </div>
        </div>
      <% } else { %>
        <div class="rounded-lg border border-dashed border-line bg-slate-50 px-4 py-5 text-sm text-ink-500">No chat history has been recorded yet.</div>
      <% } %>
    </div>
  </section>
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
node --test tests/eventController.test.js --test-name-pattern "/pull-source"
node --test tests/adminUi.test.js --test-name-pattern "project edit page links recent chat history"
```

Expected: both commands PASS.

- [ ] **Step 9: Commit**

```bash
git add controllers/event.controller.js controllers/project.controller.js views/projects/form.ejs tests/eventController.test.js tests/adminUi.test.js
git commit -m "feat: preserve project chat history"
```

---

### Task 6: Add Project Retention Setting And Cleanup Job

**Files:**
- Modify: `lib/db.js`
- Modify: `models/project.model.js`
- Modify: `models/conversation.model.js`
- Modify: `models/apicall.model.js`
- Modify: `services/adminValidation.js`
- Create: `services/retention.service.js`
- Modify: `server.js`
- Modify: `views/projects/form.ejs`
- Modify: `tests/adminUi.test.js`
- Create: `tests/retention.test.js`

**Interfaces:**
- Consumes: project field `chat_retention_days`.
- Produces:
  - `retention.runRetentionCleanup(now = new Date()): { projectsChecked: number, conversationsDeleted: number, apiCallsDeleted: number }`
  - `retention.startRetentionJob({ intervalMs?: number }): NodeJS.Timeout`

- [ ] **Step 1: Write failing admin retention setting test**

In `tests/adminUi.test.js`, update `seedProject` to include:

```js
    chat_retention_days: 90,
```

Add this test after `project create validation shows all field errors and preserves input`:

```js
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
```

- [ ] **Step 2: Run admin retention test to verify it fails**

Run:

```bash
node --test tests/adminUi.test.js --test-name-pattern "project form saves chat retention days"
```

Expected: FAIL because the project model and form do not support `chat_retention_days`.

- [ ] **Step 3: Add DB column and project model support**

In `lib/db.js`, add this column to `CREATE TABLE IF NOT EXISTS projects` after `max_msg_length`:

```sql
  chat_retention_days INTEGER NOT NULL DEFAULT 90,
```

Add this migration to the `migrations` array:

```js
"ALTER TABLE projects ADD COLUMN chat_retention_days INTEGER NOT NULL DEFAULT 90",
```

In `models/project.model.js`, update `create`:

```js
function create({ slug, name, keyword, system_prompt, teams_webhook_url, max_msg_length, chat_retention_days }) {
  const info = getDb().prepare(
    `INSERT INTO projects (slug, name, keyword, system_prompt, teams_webhook_url, max_msg_length, chat_retention_days)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(slug, name, keyword || '', system_prompt || '', teams_webhook_url || '',
    Number(max_msg_length) > 0 ? Number(max_msg_length) : 20000,
    Number.isInteger(Number(chat_retention_days)) && Number(chat_retention_days) >= 0 ? Number(chat_retention_days) : 90);
  return findById(info.lastInsertRowid);
}
```

Update the `allowed` list:

```js
const allowed = ['slug', 'name', 'keyword', 'system_prompt', 'teams_webhook_url', 'max_msg_length', 'chat_retention_days'];
```

- [ ] **Step 4: Validate and render retention days**

In `services/adminValidation.js`, add `chat_retention_days` to `validateProjectInput` values:

```js
    chat_retention_days: clean(input.chat_retention_days),
```

Add after `maxLength`:

```js
  const retentionDays = Number(values.chat_retention_days);
```

Add validation:

```js
  if (!Number.isInteger(retentionDays)) {
    errors.push('Chat retention days is required and must be a whole number.');
  } else if (retentionDays < 0) {
    errors.push('Chat retention days must be 0 or greater.');
  }
```

Update the returned `values` object:

```js
    values: {
      ...values,
      max_msg_length: Number.isInteger(maxLength) ? maxLength : values.max_msg_length,
      chat_retention_days: Number.isInteger(retentionDays) ? retentionDays : values.chat_retention_days,
    },
```

In `views/projects/form.ejs`, inside the project settings form and next to `max_msg_length`, add:

```ejs
      <div>
        <label for="chat_retention_days">Chat retention days</label>
        <input id="chat_retention_days" type="number" name="chat_retention_days" min="0" required
               value="<%= project && project.chat_retention_days !== undefined ? project.chat_retention_days : 90 %>">
        <p class="field-help">Messages, conversations, and API-call audit rows older than this are deleted. Use 0 to keep history.</p>
      </div>
```

- [ ] **Step 5: Run admin retention test**

Run:

```bash
node --test tests/adminUi.test.js --test-name-pattern "project form saves chat retention days"
```

Expected: PASS.

- [ ] **Step 6: Write failing retention cleanup tests**

Create `tests/retention.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.OTB_DB_PATH = ':memory:';

const { getDb, resetDbForTest } = require('../lib/db');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const messages = require('../models/message.model');
const apicalls = require('../models/apicall.model');
const retention = require('../services/retention.service');

beforeEach(() => resetDbForTest());

test('retention cleanup deletes old conversations, messages, and API calls', () => {
  const project = projects.create({
    slug: 'payment',
    name: 'Payment',
    keyword: 'payment-bot',
    system_prompt: '',
    teams_webhook_url: '',
    max_msg_length: 20000,
    chat_retention_days: 7,
  });
  const oldConv = convs.create(project.id, 'old-chat');
  const newConv = convs.create(project.id, 'new-chat');
  messages.add({ conversation_id: oldConv.id, direction: 'in', content: 'old' });
  messages.add({ conversation_id: newConv.id, direction: 'in', content: 'new' });
  apicalls.add({ project_id: project.id, group_name: 'txn', method: 'GET', url: 'https://api.example/old', status: 200 });
  apicalls.add({ project_id: project.id, group_name: 'txn', method: 'GET', url: 'https://api.example/new', status: 200 });

  getDb().prepare(`UPDATE conversations SET updated_at = datetime('2026-06-20 00:00:00') WHERE id = ?`).run(oldConv.id);
  getDb().prepare(`UPDATE conversations SET updated_at = datetime('2026-07-04 00:00:00') WHERE id = ?`).run(newConv.id);
  getDb().prepare(`UPDATE api_calls SET created_at = datetime('2026-06-20 00:00:00') WHERE url LIKE '%/old'`).run();
  getDb().prepare(`UPDATE api_calls SET created_at = datetime('2026-07-04 00:00:00') WHERE url LIKE '%/new'`).run();

  const result = retention.runRetentionCleanup(new Date('2026-07-05T00:00:00Z'));

  assert.strictEqual(result.projectsChecked, 1);
  assert.strictEqual(result.conversationsDeleted, 1);
  assert.strictEqual(result.apiCallsDeleted, 1);
  assert.strictEqual(convs.findActive(project.id, 'old-chat'), undefined);
  assert.ok(convs.findActive(project.id, 'new-chat'));
  assert.strictEqual(messages.listByConversation(oldConv.id).length, 0);
  assert.strictEqual(apicalls.listByProject(project.id).length, 1);
});

test('retention cleanup skips projects with retention set to zero', () => {
  const project = projects.create({
    slug: 'payment',
    name: 'Payment',
    keyword: 'payment-bot',
    system_prompt: '',
    teams_webhook_url: '',
    max_msg_length: 20000,
    chat_retention_days: 0,
  });
  const oldConv = convs.create(project.id, 'old-chat');
  messages.add({ conversation_id: oldConv.id, direction: 'in', content: 'old' });
  apicalls.add({ project_id: project.id, group_name: 'txn', method: 'GET', url: 'https://api.example/old', status: 200 });
  getDb().prepare(`UPDATE conversations SET updated_at = datetime('2026-01-01 00:00:00') WHERE id = ?`).run(oldConv.id);
  getDb().prepare(`UPDATE api_calls SET created_at = datetime('2026-01-01 00:00:00')`).run();

  const result = retention.runRetentionCleanup(new Date('2026-07-05T00:00:00Z'));

  assert.strictEqual(result.conversationsDeleted, 0);
  assert.strictEqual(result.apiCallsDeleted, 0);
  assert.ok(convs.findActive(project.id, 'old-chat'));
  assert.strictEqual(apicalls.listByProject(project.id).length, 1);
});
```

- [ ] **Step 7: Run retention tests to verify they fail**

Run:

```bash
node --test tests/retention.test.js
```

Expected: FAIL with `Cannot find module '../services/retention.service'`.

- [ ] **Step 8: Add cleanup helpers**

In `models/conversation.model.js`, add:

```js
function deleteOlderThan(project_id, cutoff) {
  const info = getDb().prepare(
    `DELETE FROM conversations WHERE project_id = ? AND updated_at < datetime(?)`
  ).run(project_id, cutoff);
  return info.changes;
}
```

Update exports:

```js
module.exports = { findActive, create, close, setSession, listByProject, deleteOlderThan };
```

In `models/apicall.model.js`, add:

```js
function deleteOlderThan(project_id, cutoff) {
  const info = getDb().prepare(
    `DELETE FROM api_calls WHERE project_id = ? AND created_at < datetime(?)`
  ).run(project_id, cutoff);
  return info.changes;
}
```

Update exports:

```js
module.exports = { add, listByProject, deleteOlderThan };
```

- [ ] **Step 9: Implement retention service**

Create `services/retention.service.js`:

```js
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const apicalls = require('../models/apicall.model');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

function sqliteTimestamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function cutoffFor(now, days) {
  return sqliteTimestamp(new Date(now.getTime() - (days * 24 * 60 * 60 * 1000)));
}

function runRetentionCleanup(now = new Date()) {
  let projectsChecked = 0;
  let conversationsDeleted = 0;
  let apiCallsDeleted = 0;

  for (const project of projects.list()) {
    const days = Number(project.chat_retention_days);
    if (!Number.isInteger(days) || days <= 0) continue;
    projectsChecked += 1;
    const cutoff = cutoffFor(now, days);
    conversationsDeleted += convs.deleteOlderThan(project.id, cutoff);
    apiCallsDeleted += apicalls.deleteOlderThan(project.id, cutoff);
  }

  return { projectsChecked, conversationsDeleted, apiCallsDeleted };
}

function startRetentionJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const timer = setInterval(() => {
    try {
      const result = runRetentionCleanup();
      if (result.conversationsDeleted || result.apiCallsDeleted) {
        console.log(`[retention] deleted conversations=${result.conversationsDeleted} apiCalls=${result.apiCallsDeleted}`);
      }
    } catch (err) {
      console.error('[retention] cleanup failed:', err.message);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { runRetentionCleanup, startRetentionJob, cutoffFor };
```

In `server.js`, add near the top:

```js
const retention = require('./services/retention.service');
```

Inside `if (require.main === module)`, after starting both apps, add:

```js
  retention.startRetentionJob();
```

- [ ] **Step 10: Run retention tests**

Run:

```bash
node --test tests/retention.test.js
```

Expected: PASS.

- [ ] **Step 11: Run related tests**

Run:

```bash
node --test tests/adminUi.test.js tests/retention.test.js
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add lib/db.js models/project.model.js models/conversation.model.js models/apicall.model.js services/adminValidation.js services/retention.service.js server.js views/projects/form.ejs tests/adminUi.test.js tests/retention.test.js
git commit -m "feat: add project chat retention cleanup"
```

---

### Task 7: Update Documentation And Run Full Verification

**Files:**
- Modify: `README.md`
- Test: full test suite

**Interfaces:**
- Consumes: implemented admin curl workflow, project audit UI, chat history, and retention cleanup.
- Produces: README setup instructions matching the new workflow.

- [ ] **Step 1: Update README admin setup**

In `README.md`, replace Admin Setup step 3:

```md
3. Add API groups with a base URL, allowed methods, auth header, API key, and markdown description for the agent.
```

with:

```md
3. Add API groups by pasting a working `curl` command plus a markdown description for the agent. OpenTraceBridge extracts the base URL, method, auth header, and API key from the curl command, stores the secret server-side, and redacts it from generated workspace instructions.
```

After the `/pull-source` paragraph, add:

```md
The project edit page shows the latest API calls made through the OpenCode `call_api` tool. The full audit page remains available from **Open full audit** and includes conversation sessions plus recent internal API calls.

OpenTraceBridge saves Teams chat history for each project, including investigation prompts, `/new`, `/pull-source`, agent answers, and error messages. Configure **Chat retention days** on the project form to control automatic cleanup; `0` keeps history indefinitely.
```

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 3: Build CSS only if form classes changed outside existing utility names**

Run this only if the implementation added new custom CSS classes to `assets/styles/admin.css`:

```bash
npm run build:css
```

Expected: command exits 0 and `public/styles/admin.css` updates.

- [ ] **Step 4: Inspect git diff for accidental secrets**

Run:

```bash
git diff -- README.md services tests views controllers
```

Expected: no real API keys, tokens, private URLs, or local secrets appear. Test-only fake values such as `sk_live_123` are acceptable.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document curl api group setup"
```

---

## Self-Review

**Spec coverage:** The plan covers curl + markdown API group creation, server-side secret storage, secret redaction before `AGENTS.md`, project-page visibility of recent API calls, project chat-history visibility, persistence of `/pull-source`, and project-level retention cleanup. Conversation-level correlation for individual API calls is intentionally out of scope because existing `api_calls` rows already provide project-level tracking and the requested fast path is project view visibility.

**Placeholder scan:** Clean. Each code-changing step includes exact code or exact replacement instructions.

**Type consistency:** `parseCurlApiGroupInput` and `redactApiSecrets` are defined in Task 1 and consumed with the same names in later tasks. `apiCalls` and `conversationRows` are introduced in the controller render context and consumed by the EJS view as `apiCalls` and `conversations`. `runRetentionCleanup` and `startRetentionJob` are defined in Task 6 and consumed with those exact names.
