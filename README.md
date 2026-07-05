# OpenTraceBridge

OpenTraceBridge connects Microsoft Teams incident questions to an OpenCode-powered investigation workspace. It receives Teams events, keeps project-specific context, lets the agent inspect cloned repositories, exposes approved internal APIs through a guarded MCP tool, and posts the result back to Teams as Adaptive Cards.

## What It Does

- Receives Teams events at `GET /api/events/:slug` or `POST /api/events/:slug`.
- Maintains one OpenCode session per project and Teams conversation.
- Builds a per-project workspace under `workspaces/<slug>/` with cloned repositories, `AGENTS.md`, and `opencode.json`.
- Lets OpenCode call approved API groups through the `call_api` MCP tool without exposing API keys to the agent.
- Stores projects, repositories, API groups, conversations, messages, and API-call audit rows in SQLite.
- Sends asynchronous investigation results to Microsoft Teams through a project webhook.
- Provides an admin UI for project, repository, API group, conversation, and audit management.

## Architecture

```text
Teams group chat
  -> Power Automate
  -> OpenTraceBridge public API (:6666)
  -> SQLite + workspace preparation
  -> opencode run
  -> guarded call_api MCP calls when needed
  -> Teams webhook Adaptive Card
```

The admin UI and internal API run on the private admin port (`ADMIN_PORT`, default `8667`). The public port (`PORT`, default `6666`) only serves health checks and event ingestion.

## Quick Start

```bash
cp .env.example .env
npm install
npm test
npm start
```

Open the admin UI at `http://localhost:8667/admin/projects`.

For Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

OpenCode remote control is published on `http://localhost:4096` for local setup and debugging.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `6666` | Public event API port. |
| `ADMIN_PORT` | `8667` | Private admin UI and `/internal` API port. |
| `OPENCODE_SERVER_PASSWORD` | empty | Optional password for OpenCode remote control. |
| `OTB_DB_PATH` | `data/otb.sqlite` | SQLite database path. |
| `OTB_WORKSPACES_DIR` | `workspaces` | Directory for generated project workspaces. |

## Admin Setup

1. Create a project with a unique slug, name, keyword, system prompt, Teams webhook URL, and max message length.
2. Add one or more repositories. HTTPS token, SSH key, and unauthenticated clone modes are supported.
3. Add API groups by pasting a working `curl` command plus a markdown description for the agent. OpenTraceBridge extracts the base URL, method, auth header, and API key from the curl command, stores the secret server-side, and redacts it from generated workspace instructions.
4. Point Power Automate at:

```text
https://<public-host>/api/events/<project-slug>?text=...&conversationId=...&userId=...&userName=...
```

Use `<keyword> /new` in Teams to close the active conversation and start a new OpenCode session.

Saving a project (or adding/removing repos) force-syncs its sources into the
project workspace in the background; the admin UI shows per-repo sync status
and offers a **Sync now** button. Use `<keyword> /pull-source` in Teams to
re-pull the sources to the latest remote state on demand — the result is posted
back through the project webhook.

The project edit page shows the latest API calls made through the OpenCode
`call_api` tool. The full audit page remains available from **Open full audit**
and includes conversation sessions plus recent internal API calls.

OpenTraceBridge saves Teams chat history for each project, including
investigation prompts, `/new`, `/pull-source`, agent answers, and error
messages. Configure **Chat retention days** on the project form to control
automatic cleanup; `0` keeps history indefinitely.

## Development

Run the test suite with:

```bash
npm test
```

## Admin UI Styling

The private admin UI uses Tailwind CSS compiled into `public/styles/admin.css`.

Build the stylesheet after changing EJS classes or `assets/styles/admin.css`:

```bash
npm run build:css
```

During UI work, run the watcher in a second terminal:

```bash
npm run dev:css
```

Generated runtime data lives in `data/` and `workspaces/`. Do not commit `.env`, database files, cloned repositories, API keys, tokens, or OpenCode auth data.

## Documentation

- [Requirements](docs/REQUIREMENT.md)
- [Flow Notes](docs/FLOW.md)
- [Flow Diagrams](docs/DIAGRAMS.md)
- [Teams Webhook Contract](docs/send_msg_webhook.md)
