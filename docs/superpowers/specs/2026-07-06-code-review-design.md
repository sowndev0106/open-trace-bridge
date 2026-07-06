# Code Review Feature — Design

Date: 2026-07-06
Status: Draft for review

## 1. Goal

Add an automated code-review capability to OpenTraceBridge (OTB). When a pull
request is opened or updated (or a branch is pushed, or a reviewer asks from
Teams), OTB runs the sandboxed OpenCode agent over the change and returns a
review. Results are posted as a comment on the GitHub pull request and/or sent
to the project's Teams chat.

The feature reuses OTB's existing machinery — git checkout, the sandboxed
OpenCode run, the Teams webhook output, the per-project config model, and the
per-project background-sync/mutex pattern. It does **not** introduce a new
product surface: OTB keeps its shape of "receive an event → run a locked-down
OpenCode agent → return the result".

## 2. Non-goals

- No automatic approval/merge of pull requests.
- No editing or pushing of code by the agent.
- No line-by-line inline suggestions in the first version — a single review
  comment (summary + findings) per run is enough.
- No support for git hosts other than GitHub in the first version.

## 3. Security model (central principle)

**The server is the only party that touches git, the GitHub API, and secrets.
The agent stays locked in the existing sandbox and only reads code and writes
prose.** This is the non-negotiable core of the design and the reason the
feature is in scope rather than a different product.

Concretely:

- The OpenCode agent config for review keeps `edit: deny`, `bash: deny`,
  `webfetch: deny` — identical to the investigation sandbox. The agent never
  runs git, never calls the network, never sees a token.
- The review workspace is **not** wired to the MCP `call_api` tool. There is no
  channel through which prompt injection in a pull request could reach internal
  APIs.
- The server computes the diff, builds the prompt, runs the agent, redacts the
  output, and posts it. All token and network operations live on the private
  side.

### 3.1 Risks addressed

The design closes the ten risks identified during analysis:

1. **RCE via `bash: allow`** — rejected. The agent keeps `bash: deny`; the
   server computes the diff.
2. **Prompt injection → data exfiltration via `call_api`** — the review
   workspace has no `call_api` tool, and pull-request content is wrapped in the
   prompt as labelled *data to review*, not instructions.
3. **Unauthenticated public webhook** — every webhook request must pass
   `X-Hub-Signature-256` HMAC verification against the per-project secret.
4. **Token leaking through the checkout** — the token is passed only via an
   in-memory git credential mechanism for the fetch; the checked-out repo's
   remote is scrubbed of credentials before the agent reads the directory.
5. **Over-privileged token** — a single fine-grained GitHub token scoped to
   `Contents: Read` + `Pull requests: Read and write`. It can clone and
   comment but **cannot push code** (`Contents: Write` is not granted).
6. **SSRF / arbitrary target from payload** — the repository is resolved from
   the stored project config; the payload's `repository.full_name` must match a
   configured repo, otherwise the event is rejected.
7. **Untrusted fork PRs** — an author allowlist (member association, or an
   `otb-review` label) gates who can trigger a review.
8. **Secret leaking into public PR comment/Teams** — a shared redaction pass
   runs on the agent output before it is posted anywhere.
9. **DoS from event floods** — per-PR mutex with coalescing (reuse of the
   `triggerSync` pattern) plus a global concurrency cap and `synchronize`
   debounce.
10. **Two-port boundary** — the webhook is received on the public port
    (ingestion only); all token/GitHub-API operations run on the private side.

## 4. Triggers

Three entry points feed one review worker. Each is independently toggled per
project (dynamic config, no redeploy):

| Trigger | Flag | Entry | Output |
| --- | --- | --- | --- |
| PR opened / synchronize | `review_on_pr` | `POST /api/reviews/:slug` (webhook) | PR comment + Teams |
| Push to branch | `review_on_push` | same webhook, `push` event | Teams only (no PR to comment) |
| Manual from Teams | `review_via_teams` | `<keyword> /review <pr-url-or-number>` via the existing event controller | PR comment + Teams |

When a flag is off, the matching event is acknowledged and ignored.

## 5. Flow (primary path: PR webhook)

```text
GitHub (PR opened / synchronize)
  -> POST /api/reviews/<slug>            [public :6666]
     1. Verify X-Hub-Signature-256 against project webhook secret  (fail -> 401)
     2. Match payload repository against a configured repo         (no match -> 404)
     3. Author allowlist check                                     (fail -> ignore)
     4. review_on_pr flag check                                    (off -> ignore)
     5. Respond 200 immediately, enqueue job (per-PR mutex)
  -> Review worker                        [private, background]
     6. Fetch PR head into workspaces/<slug>/reviews/pr-<n>/  (read via token)
     7. Scrub credentials from the checkout remote
     8. Server runs `git diff <base>...<head>`  -> unified diff
     9. Build review prompt: diff is DATA to review + read-only source tree
  -> opencode run   (edit/bash/webfetch: deny, no call_api)
     10. Agent reads diff + surrounding code -> markdown review
  -> Server
     11. Redact secrets from output
     12a. POST comment to the PR   (token with PR write, private side)
     12b. Send Adaptive Card to Teams (existing webhook.service)
     13. Clean up reviews/pr-<n>/
```

The `push` and Teams-command triggers join at step 6. For `push` there is no PR,
so only step 12b runs.

### 5.1 Determining the diff base

- For a PR: `base` is the PR base branch SHA from the payload
  (`pull_request.base.sha`); `head` is `pull_request.head.sha`. Diff is
  `git diff base...head` (merge-base three-dot).
- For a push: diff the pushed range from the payload (`before`..`after`); if
  `before` is all zeros (new branch), fall back to a diff against the project's
  default branch.

## 6. Data model changes

Add columns to `projects` (all with safe defaults; existing rows keep working):

```sql
ALTER TABLE projects ADD COLUMN review_enabled     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN review_on_pr       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN review_on_push     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN review_via_teams   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN review_webhook_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN review_github_token   TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN review_author_allowlist TEXT NOT NULL DEFAULT '';
```

- `review_webhook_secret` is generated per project (used to verify HMAC and
  shown in the setup guide). The token field follows the existing "leave blank
  to keep stored value" convention and is redacted from any generated output.
- A new `reviews` table records each run for the audit UI:

```sql
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,            -- 'pr' | 'push' | 'teams'
  repo_full_name TEXT,
  pr_number INTEGER,
  head_sha TEXT,
  status TEXT NOT NULL,             -- 'queued' | 'running' | 'posted' | 'error'
  result_md TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 7. GitHub token permissions

One fine-grained personal access token per project, scoped to exactly:

- **Contents: Read** — clone/fetch the head commit.
- **Pull requests: Read and write** — post the review comment.

This deliberately excludes `Contents: Write`, so a leaked token cannot push
code or move branches. Classic PATs (scope `repo`) must not be used because they
bundle code-write access.

## 8. Setup guide in the admin UI

A "Review setup" panel is added to the project form (`views/projects/form.ejs`),
rendered dynamically from the project's slug and secret. It documents, in plain
language, everything a maintainer must configure on GitHub:

- **Webhook URL** to paste into GitHub:
  `https://<public-host>/api/reviews/<slug>` (with a copy button).
- **Webhook secret** (the generated `review_webhook_secret`) to paste into the
  GitHub webhook "Secret" field.
- **Which events to select** in GitHub: *Pull requests* and *Pushes*.
- **Token permissions** required, shown as an explicit table so a maintainer
  grants the minimum scope and nothing more:

  | Action | Fine-grained permission needed | Grant it? |
  | --- | --- | --- |
  | Clone / fetch code | Contents: Read | ✅ |
  | Comment / review on a PR | Pull requests: Read and write | ✅ |
  | Push code, change branches | Contents: Write | ❌ do not grant |

  The panel also links to GitHub's fine-grained PAT creation page and warns
  against classic PATs (scope `repo`), which bundle code-write access.
- **What a webhook / curl is** — a short explanation and an example, matching
  the style of the existing curl-based API-group help so non-experts can follow.

The panel is static text keyed off project fields; it makes no API calls.

## 9. Components

New:

- `routes/reviews.routes.js` — public `POST /api/reviews/:slug`.
- `controllers/review.controller.js` — verify HMAC, match repo, allowlist, flag
  checks, enqueue.
- `services/review.service.js` — the worker: checkout, diff, prompt, run,
  redact, post; per-PR mutex + global concurrency cap.
- `services/github.service.js` — the only outbound GitHub API caller (post PR
  comment); holds the write token on the private side.
- `models/review.model.js` — the `reviews` table.
- A review-specific workspace/prompt builder (extends `workspace.service` with a
  review AGENTS/opencode config that omits `call_api`).

Changed:

- `models/project.model.js` — new columns in `create`/`update` allow-lists.
- `lib/db.js` — schema additions.
- `controllers/event.controller.js` — handle the `/review` Teams command.
- `views/projects/form.ejs` — review settings + setup-guide panel.
- `services/adminValidation.js` — validate the new fields.
- `README.md` / `docs` — document the review flow.

## 10. Testing

- HMAC verification: valid signature passes, tampered body / wrong secret → 401.
- Repo-match and allowlist gating reject unconfigured repos and non-allowed
  authors.
- Flag off → event acknowledged and ignored.
- Diff computation from a fixture payload produces the expected range.
- The review OpenCode config has `bash: deny` and no `call_api` MCP entry.
- Output redaction strips token/key/PEM patterns before posting.
- Per-PR mutex coalesces overlapping events into one rerun.
- GitHub comment posting is stubbed (like `opencode.service.proc`) so tests
  never hit the network.

## 11. Open questions

- Comment style: one consolidated review comment per run (chosen) vs. updating a
  single sticky comment on re-review. Default: post a new comment each run;
  revisit if noise becomes a problem.
- Whether `push` reviews should be limited to specific branches (e.g. only the
  default branch) via an additional per-project setting. Deferred until needed.
