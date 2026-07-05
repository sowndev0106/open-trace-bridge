# Unified Project Save — Design

Date: 2026-07-05
Status: Approved approach (A), pending spec review

## Problem

The project edit page has three separate persistence flows: the project-fields form (its Save button sits mid-page), an add-repo form, an add-API-group form, plus per-row delete forms. Users must save each piece separately, and the create page cannot configure repos or API groups at all. Secrets (`token`, `ssh_key`, `api_key`) are also rendered back into plain-text inputs.

## Goals

- **One Save button at the top** of the page that persists everything at once: project fields, all repo rows, all API group rows.
- The same unified form works on **both** the edit page and the New-project page (create everything in one POST).
- Existing repo/API rows are **editable inline**; Add/Remove only manipulate rows in the browser — nothing hits the server until Save.
- Secrets are password inputs, are **never echoed** back, and **blank means keep the existing value** for rows that already exist.
- Saving still triggers the background source sync exactly once.

## Design

### 1. Form layout (`views/projects/form.ejs`)

- The whole page content is wrapped in a single `<form method="post" action="/admin/projects[/:id]">`. The **Save** button lives in the top header section next to "Back to projects".
- The **Sync now** button (edit page only) cannot nest a form inside the main form; it becomes `<button form="sync-form">` referencing an empty `<form id="sync-form" method="post" action="/admin/projects/:id/sync">` rendered outside the main form. Same for no other buttons — Remove/Add are `type="button"`.
- **Repos panel**: each existing repo renders as an editable row of inputs named `repos[<i>][id]` (hidden), `[git_url]`, `[auth_type]`, `[branch]`, `[token]`, `[ssh_key]`. Sync status badge/error/timestamp stay next to each row (read-only). `token` is `<input type="password">`, `ssh_key` a textarea with empty content and a "leave blank to keep" hint; neither ever echoes a stored or submitted secret.
- **API groups panel**: rows named `apis[<i>][id]`, `[name]`, `[base_url]`, `[api_key]` (`type="password"`), `[auth_header]`, `[allowed_methods]`, `[description_md]`. `description_md` does re-render its value (not a secret).
- **Add repo / Add API group** buttons clone a `<template>` element, assigning the next index via a small inline vanilla-JS helper. **Remove** buttons delete the row's wrapper element. Indexes may end up sparse after removal; the server compacts arrays, so gaps are fine.
- The New-project page renders the same panels with zero rows.
- The sync-status poller script is unchanged.

### 2. Payload and parsing

`express.urlencoded({ extended: true })` (already enabled) parses `repos[0][git_url]=...` into `req.body.repos = [{...}]`. The controller normalizes: missing → `[]`, object with numeric keys → `Object.values`, then filters out fully-empty rows (every field blank) so a leftover blank template row does not error.

### 3. Validation (`services/adminValidation.js`)

New export `validateProjectBundle(body, { existingRepos, existingApis })`:

- Project fields: reuse `validateProjectInput`.
- Each repo row: reuse `validateRepoInput`, with one change to secret rules — if the row has an `id` matching an existing repo and the submitted secret is blank, the stored secret is carried into `values` before the "token/ssh key required" checks run.
- Each API row: reuse `validateApiGroupInput` with the same carry-over rule for `api_key` (blank + existing id → keep stored key; blank on a new row is allowed since `api_key` is optional today).
- Row errors are prefixed for the error list: `Repo #2: Branch is required.`, `API group #1: Base URL must be a valid http or https URL.` (1-based, in submitted order).
- Duplicate API group names within the submission are rejected (`call_api` resolves groups by name).
- Returns `{ values: { project, repos: [...], apis: [...] }, errors }`; each row's `values` keeps its `id` (number) or `null` for new rows.

`validateRepoInput` / `validateApiGroupInput` remain exported and unchanged in behavior for their own fields.

### 4. Persistence (models + controller)

- `repos.update(id, values)` — updates `git_url`, `auth_type`, `token`, `ssh_key`, `branch`. If `git_url` or `branch` changed, reset `sync_status` to `pending` (content will change); auth-only edits keep the current status.
- `apis.update(id, values)` — updates all API group fields.
- Controller `createProject` / `updateProject` accept the bundle and reconcile inside a better-sqlite3 transaction:
  1. insert/update the project;
  2. for each submitted repo row: `id` present → `repos.update`; absent → `repos.create`;
  3. delete existing repos whose id is not in the submission (same for API groups);
  4. after the transaction commits: `sync.triggerSync(projectId, { reason: 'create' | 'update' })` — once per save.
- Old per-section routes and handlers are **removed**: `POST /:id/repos`, `POST /:id/repos/:repoId/delete`, `POST /:id/apis`, `POST /:id/apis/:apiId/delete` (and `addRepo`/`deleteRepo`/`addApiGroup`/`deleteApiGroup` in the controller). `repoDraft`/`apiDraft` view plumbing goes away.

### 5. Error re-render

On validation failure, re-render the form (400) with the submitted values in place — including new, not-yet-saved rows — so nothing typed is lost, except secrets which render as empty password fields. The error list at the top shows the prefixed row errors.

### 6. Testing

- Update `tests/adminUi.test.js`: drop tests for removed routes; adapt the sync-trigger test (one trigger per save); keep sync-status/badge/poller tests (selectors updated to the new row markup).
- New tests: create-with-bundle (project + 2 repos + 1 API in one POST), update-reconcile (edit one repo, add one, omit one → deleted), blank-secret-keeps-existing (token unchanged in DB), secrets-never-echoed (`type="password"`, no secret text in HTML — matches the two unsaved editor tests), fully-blank row ignored, row-prefixed validation errors, duplicate API names rejected.
- `services/adminValidation` unit coverage for `validateProjectBundle` edge cases lives in the same file (route-level tests exercise it end-to-end; no separate unit file needed).

## Out of scope

- AJAX/JSON saving; the page stays server-rendered.
- Optimistic locking / concurrent-edit detection.
- Changing the Sync now button, sync-status endpoint, or poller behavior.
