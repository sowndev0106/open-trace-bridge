# Project Source Sync — Design

Date: 2026-07-05
Status: Approved approach (A), pending spec review

## Problem

Today the git clone/pull of project repos happens inside `ensureWorkspace()` on **every incoming message** (`controllers/event.controller.js` → `investigate()`). This has three problems:

1. Every question pays git-sync latency before opencode starts.
2. `git pull --ff-only` fails when the remote branch was force-pushed or diverged; the workspace gets stuck until someone deletes it manually.
3. Saving a project in the admin UI gives no feedback about whether the sources are actually cloneable; errors only surface later, in Teams, when a user asks a question.

## Goals

- Saving a project (create/update), adding a repo, or deleting a repo triggers a **background force-sync** of that project's workspace (`workspaces/<slug>/`). Remote always wins.
- Message handling only runs opencode in the existing workspace; it force-syncs **only as a fallback** when the workspace is not ready.
- Sync status is visible in the admin UI (project list + project edit page), per repo, with timestamps and error details.
- A **"Sync now"** button on the project edit page re-triggers the sync manually.
- A **`/pull-source`** chat command (same style as `/new`) force-syncs the project and replies with the result via the Teams webhook.

Architecture stays single-container; a "project's container" means its workspace directory `workspaces/<slug>/` inside the shared `otb` container.

## Design

### 1. Force-sync semantics (workspace.service.js)

Split `ensureWorkspace()` into two parts:

- `syncRepo(repo, ws)` — one repo directory:
  - Directory has `.git`: `git fetch origin <branch>` → `git checkout <branch>` → `git reset --hard origin/<branch>` → `git clean -fd`. Remote always wins; local divergence and force-pushes are discarded.
  - No `.git`: `git clone --depth 1 --branch <branch> <url> <dir>` (unchanged).
- `writeWorkspaceFiles(project, apiGroups)` — writes `AGENTS.md` + `opencode.json`. Still executed on **every message** (cheap, keeps prompts/API config fresh) and at the end of every sync.
- Repo rows deleted from a project: sync removes workspace directories that no longer match any configured repo (only direct children previously created by us, matched via `repoDirName`; never touches `AGENTS.md`/`opencode.json`).

Existing auth handling (`gitEnvFor`, `cloneUrlFor`) is reused unchanged.

### 2. Sync orchestration (new `services/sync.service.js`)

- `triggerSync(projectId, { reason })` — fire-and-forget background sync:
  - Per-project in-process mutex: if a sync for the project is running, mark "rerun requested" and run once more after the current one finishes (no unbounded queue).
  - Sets all project repos to `syncing`, runs `syncRepo` per repo sequentially, records per-repo `success`/`error` + `sync_error` + `synced_at`, then writes workspace files.
- `ensureReady(project, repoRows, apiGroups)` — used by the message path:
  - If every repo has `sync_status = 'success'` and its directory exists → write workspace files only and return the workspace path (no git).
  - Otherwise → run the same force-sync inline (await), then return. Errors propagate to the existing Teams error message.
- No new dependencies; plain async functions + a `Map<projectId, state>` for the mutex. This process is a single Node instance, so an in-process lock is sufficient.

### 3. Status storage (SQLite, `repos` table)

Add columns via the existing try/catch `ALTER TABLE` migration pattern in `lib/db.js`:

- `sync_status TEXT NOT NULL DEFAULT 'pending'` — `pending | syncing | success | error`
- `sync_error TEXT` — last git error output (trimmed), null when not in `error`
- `synced_at TEXT` — datetime of last finished attempt

`repo.model.js` gains `setSyncStatus(id, { status, error, synced_at })` and `listByProject` already returns the new columns. Project-level status is derived in code: `error` if any repo errored, `syncing` if any is syncing, `pending` if any pending, else `success`.

### 4. Triggers

| Trigger | Path | Behavior |
|---|---|---|
| Create project | `POST /admin/projects` | `triggerSync` after insert (no-op when no repos yet) |
| Update project | `POST /admin/projects/:id` | `triggerSync` after update |
| Add repo | `POST /admin/projects/:id/repos` | `triggerSync` |
| Delete repo | `POST /admin/projects/:id/repos/:repoId/delete` | `triggerSync` (also prunes the directory) |
| Sync now button | new `POST /admin/projects/:id/sync` | `triggerSync`, redirect back to edit page |
| `/pull-source` in chat | `POST/GET /api/events/:slug` | see §6 |
| Message fallback | `investigate()` | inline `ensureReady` |

All admin triggers respond immediately (redirect); sync runs in the background.

### 5. Admin UI

- **Project list** (`views/projects/list.ejs`): status badge per project (derived status) + last synced time.
- **Project edit** (`views/projects/form.ejs`): per-repo badge (`pending`/`syncing`/`success`/`error`), `synced_at`, and the `sync_error` text when failed; a **Sync now** button.
- Lightweight status refresh: new `GET /admin/projects/:id/sync-status` returning JSON; the edit page polls it every few seconds while any repo is `pending`/`syncing` and updates badges in place (no full-page reload loop).

### 6. `/pull-source` chat command

- `extractPrompt()` in `lib/eventGateway.js` additionally detects `/pull-source` (after keyword strip), returning `isPullSource`.
- `handleEvent` branch, mirroring `/new`: respond `{ handled: true, action: 'pull-source' }` immediately, run the force-sync in the background, then send a Teams webhook message: success ("Sources updated to latest", per-repo summary) or error (repo + git error, suggestion to check the Admin UI).
- The command does not touch conversations/sessions; the current session stays intact.

### 7. Error handling

- Per-repo isolation: one repo failing does not stop the sync of the remaining repos; each repo records its own status.
- Git output stored in `sync_error` is truncated (~1000 chars) and never includes tokens (clone URL with embedded token is redacted from error text before storing).
- Message path: if inline fallback sync fails, the existing Teams "Investigation failed" message reports the git error.

### 8. Testing

Extend the existing node test setup (`tests/`):

- `eventGateway`: `/pull-source` detection (with/without keyword prefix).
- `sync.service`: mutex (second trigger during a run coalesces into one rerun), per-repo status transitions, derived project status; git calls stubbed.
- `workspace.service`: force-sync argument sequence (`fetch`/`checkout`/`reset --hard`/`clean -fd`) chosen when `.git` exists; pruning of removed-repo directories; token redaction in stored errors.
- Controller: save/add/delete repo triggers sync (spy), `POST /:id/sync` route, `sync-status` JSON shape.
- E2E message path: workspace `success` → no git invoked; workspace `error` → inline sync then run.

## Out of scope

- Per-project Docker containers.
- Sync history (only latest status is kept).
- Webhooks/schedulers that auto-pull on remote push.
