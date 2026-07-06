# Design: Admin Login + Per-Project 1-1 Agent Chat

Date: 2026-07-06
Status: approved by user (brainstorming session)

## Goal

Two related features for the private admin app (port `ADMIN_PORT`):

1. **Secure login** for the admin UI, which currently has no authentication at all
   (it relies only on the port being private).
2. **A 1-1 chat page per project** where the admin talks directly to that
   project's OpenCode agent from the browser, without going through Teams,
   with real-time streaming of agent progress.

Login is a prerequisite: it protects the whole admin UI including the new chat
page. The public event app (port `PORT`) is untouched, preserving the two-port
boundary.

## Decisions made during brainstorming

- Chat is **admin ↔ OpenCode agent** inside the admin UI (not Teams personal
  chat, not human-to-human).
- Agent responses **stream in real time** (tool steps + text chunks), not
  spinner-then-full-reply.
- **Single admin account** configured via environment variables; no users table.
- Architecture: **session cookie auth (SQLite-backed) + SSE streaming** — no
  new runtime dependencies (no express-session, no websockets).

## 1. Login

### Configuration

- `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` (documented in `.env.example`,
  README, and docker-compose).
- Fail closed: if either variable is missing, every `/admin` page renders a
  "credentials not configured" screen instead of the app. `/internal` and
  `/health` keep working.

### Sessions

- New `sessions` table: `token_hash` (SHA-256 of the cookie token), `created_at`,
  `expires_at`. Only the hash is stored; a leaked DB cannot be replayed.
- Cookie `otb_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` enabled
  via `COOKIE_SECURE=true` env for HTTPS deployments.
- Sliding expiry of 7 days (each authenticated request extends `expires_at`).
- Sessions survive server restarts (SQLite-backed) — matters because the prod
  process is restarted for migrations.
- The existing retention job also deletes expired session rows.

### Login flow and hardening

- `GET /admin/login` renders the login page; `POST /admin/login` verifies
  credentials.
- Credential comparison uses `crypto.timingSafeEqual` over fixed-length digests
  of both username and password (no timing side channel, no length leak).
- Rate limit: at most 5 failed attempts per 15 minutes per IP (in-memory
  counter); further attempts are rejected with a "try again later" message and
  a server-side log line.
- Failure message is generic ("Invalid credentials") — it never reveals which
  field was wrong.
- On success: create session row, set cookie, redirect to `?next=` target if it
  is a safe relative `/admin/...` path, else `/admin/projects`.
- `POST /admin/logout` deletes the session row, clears the cookie, redirects to
  login.

### Middleware

- Auth middleware guards everything under `/admin` except `GET|POST /admin/login`.
- Unauthenticated requests: HTML requests redirect to
  `/admin/login?next=<original>`; JSON/SSE requests get `401`.
- CSRF defense for all state-changing `/admin` POSTs: `SameSite=Lax` cookie plus
  an `Origin`/`Referer` host check (reject mismatches with `403`).
- Unchanged: `/assets` static files, `/health`, and `/internal/*` (already
  guarded by `x-otb-internal-token`, used by the MCP `call_api` bridge).

### Login UI

Minimal centered card in the existing Tailwind style: app name, username and
password inputs, Sign in button, red error line on failure. Logout button added
to the shared admin header.

## 2. Per-project chat

### Data model — maximal reuse

- An admin chat is a normal `conversations` row with the synthetic constant
  `teams_conversation_id = 'admin-ui'`. No schema change to conversations.
- Messages go into the existing `messages` table (`direction` inbound/outbound),
  runs into the existing `runs` table — so the dashboard usage/error/cost stats
  automatically include admin chats, retention cleanup applies unchanged, and
  the existing conversation detail page can display chat history.
- **New conversation** button closes the active `admin-ui` conversation and
  starts a fresh one (same semantics as the Teams `/new` command, fresh
  OpenCode session).

### Streaming service

- Add `runPromptStream({ dir, sessionId, text, conversationId, onEvent })` to
  `services/opencode.service.js`. It parses stdout **line by line as data
  arrives** (buffering partial lines) and emits typed events:
  - `session` — sessionID discovered
  - `tool` — a tool invocation step (name + state), from tool-related output events
  - `text` — a text chunk
  - `usage` — accumulated tokens/cost from `step_finish`
  - `done` / `error`
- The existing `runPrompt` is reimplemented on top of `runPromptStream`
  (collect events, resolve at end) so the Teams path keeps identical behavior
  and existing tests keep passing. Same 5-minute timeout, same
  `proc.spawn` stub indirection for tests.

### HTTP endpoints (admin app, behind auth)

- `GET /admin/projects/:id/chat` — chat page; loads message history of the
  active `admin-ui` conversation (empty state if none).
- `POST /admin/projects/:id/chat/messages` — body `{ text }`:
  1. Reject if a chat run is already in progress for this project (in-memory
     per-project lock) with `409` — the UI disables input while running anyway.
  2. Store the inbound message, ensure workspace via `sync.ensureReady`.
  3. Respond with `Content-Type: text/event-stream` **on the POST response
     itself**; the browser reads it via `fetch` + `ReadableStream`. Events
     mirror the service events (`tool`, `text`, `done`, `error`); `done`
     carries duration + usage.
  4. On completion (even if the client disconnected mid-stream): store the
     outbound message, record the `runs` row, update the conversation's
     OpenCode session id — identical bookkeeping to the Teams path.
- `POST /admin/projects/:id/chat/new` — close active admin conversation,
  create a new one, redirect back to the chat page.

### Chat UI

Route `/admin/projects/:id/chat`, linked from a **Chat** button on the project
list rows and the project edit page.

Layout (single column, full height):

- **Header**: back link + project name, **New conversation** button.
- **Message list**: user messages as right-aligned bubbles; agent replies
  left-aligned, rendered as sanitized markdown (`marked` + `DOMPurify` via CDN,
  matching the existing Toast UI CDN pattern). Each completed reply shows a
  small meta line: duration, tokens, cost (from the `done` event / runs data).
  Tool steps render as a collapsible "N steps" block above the reply text.
- **While running**: the reply bubble fills in live from `text` events; a
  status line above it shows the latest `tool` event ("running `call_api`…").
  The input is disabled until `done`/`error`.
- **Input bar**: auto-resizing textarea; Enter sends, Shift+Enter inserts a
  newline; Send button.

### Error handling

- Run error or timeout: red error bubble in the chat; the inbound message
  remains stored.
- SSE disconnect / page reload mid-run: the run continues server-side and the
  result is still persisted. On reload while the project lock is held, the page
  shows a "the agent is still working on a previous message — reload shortly"
  banner and keeps the input disabled.
- Login rate-limit and auth failures are logged server-side.

## 3. Testing

Reuse the existing `node --test` + supertest + `proc.spawn` stub patterns:

- Auth middleware: no cookie → redirect; invalid/expired token → redirect;
  valid session → pass; JSON request → 401; Origin mismatch on POST → 403.
- Login: success sets cookie + session row; wrong credentials → generic error;
  6th failed attempt within window → rate limited; logout clears session.
- Stream parser: feed stdout in arbitrary chunk boundaries (split mid-line) and
  assert emitted event sequence; `runPrompt` behavior unchanged.
- Chat endpoints: message send happy path with stubbed opencode (messages +
  runs rows written, SSE events emitted), 409 while locked, new-conversation
  flow, unauthenticated access rejected.

## 4. Files expected to change

- `server.js` — mount auth middleware on admin app, cookie parsing.
- `lib/db.js` — add the `sessions` table to the existing `CREATE TABLE IF NOT
  EXISTS` schema block.
- New: `services/auth.service.js`, `controllers/auth.controller.js`,
  `controllers/chat.controller.js`, `views/login.ejs`,
  `views/projects/chat.ejs`, `models/session.model.js`.
- `services/opencode.service.js` — streaming refactor.
- `routes/admin.routes.js` — login/logout/chat routes.
- `views/layout-head.ejs` / shared header — logout button, Chat links.
- `services/retention.service.js` — expired-session cleanup.
- `.env.example`, `README.md`, `docker-compose.yml` — new env vars.

## Out of scope

- Multiple users, roles, or per-user chat history.
- Teams personal (1-1) chat via Power Automate.
- Cancelling a run mid-flight; multi-tab live sync of the same chat.
- Auth on the public event API.
