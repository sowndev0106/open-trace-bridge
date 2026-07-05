# OpenTraceBridge Requirements

This document describes the currently implemented scope.

## Purpose

Users ask investigation questions in a Microsoft Teams group chat with a project keyword such as `payment-bot`. OpenTraceBridge receives the event, prepares project evidence from cloned source code and configured internal APIs, runs OpenCode, and sends the result back to Teams through a webhook.

## Current Scope

- SQLite is the only storage layer.
- Each project has its own slug and event URL: `/api/events/<project-slug>`.
- The admin UI is server-rendered with Express and EJS.
- Projects define a name, slug, keyword, system prompt, Teams webhook URL, and max message length.
- Each project can have multiple repositories and multiple API groups.
- Workspaces are generated under `workspaces/<slug>/`.
- The generated workspace contains cloned repositories, `AGENTS.md`, and `opencode.json`.
- OpenCode may call internal APIs only through the `call_api` MCP tool.
- The server enforces the API group, base URL, allowed methods, API key attachment, timeout, and audit logging.
- Conversations map `(project, teams conversationId)` to an OpenCode session ID.
- `<keyword> /new` closes the current conversation and starts a new session.
- Results are sent asynchronously through the project Teams webhook.
- Message and API-call audit rows are stored in SQLite.
- Docker runs Express and OpenCode in one app container.

## Out of Scope

- Azure Bot Service and Discord integration.
- A full policy engine.
- Secret encryption or a secret manager.
- Postgres, Redis, queues, or separate workers.
- Approval workflows or production write actions.

Current secrets are stored as plaintext in SQLite because this is an internal quick-win implementation. Move secrets to a proper secret manager before broader deployment.

## Architecture

```text
Teams group chat
  -> Power Automate
  -> GET/POST /api/events/:slug
  -> Express event controller
  -> SQLite conversation/message records
  -> workspace.service prepares repos + AGENTS.md + opencode.json
  -> opencode run --session <id> "<prompt>"
  -> call_api MCP tool when API data is needed
  -> /internal/call-api enforcement + audit
  -> webhook.service posts Adaptive Cards to Teams
```

## Directory Layout

```text
server.js                 starts public and admin apps
routes/                   admin, event, and internal routes
controllers/              request handlers
models/                   SQLite data access
views/                    EJS admin templates
services/                 workspace, OpenCode, webhook, Teams formatting, API-call enforcement
lib/eventGateway.js       HTML stripping, keyword stripping, /new detection, event validation
mcp/callapi-stdio.js      MCP stdio bridge for call_api
docs/                     project documentation
tests/                    node:test suite
```

## Event Flow

1. Receive `GET` or `POST /api/events/:slug`.
2. Look up the project by slug.
3. Require `text` and `conversationId`.
4. Strip HTML and the project keyword prefix.
5. If the remaining prompt starts with `/new`, close the active conversation and create a new one.
6. Otherwise, create or reuse the active conversation.
7. Acknowledge the HTTP request immediately.
8. Prepare the workspace.
9. Run OpenCode with the existing session when available.
10. Store the answer or error.
11. Post the result to Teams through the configured webhook.

## Security Rules

- The agent never receives API keys.
- API calls must stay under a configured API group base URL.
- Methods are restricted by `allowed_methods`.
- Every API call is audited.
- Repository access is read-only from the agent profile.
- The public app must not expose the admin UI or `/internal` routes.

## Success Criteria

- A project can be created through the admin UI.
- The project can include at least one repository and one API group.
- A Teams event reaches `/api/events/:slug` and receives an asynchronous Teams result.
- Follow-up questions reuse the same OpenCode session.
- `<keyword> /new` starts a new session.
- API calls made by the agent appear in the audit log.
- The server handles OpenCode failures, timeouts, git failures, and webhook failures without crashing.
- `docker compose up` starts the app, persists data, and exposes OpenCode remote control on localhost.
