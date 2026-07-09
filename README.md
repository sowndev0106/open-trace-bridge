# OpenTraceBridge

OpenTraceBridge connects Microsoft Teams incident questions to an OpenCode-powered investigation workspace. It receives Teams events, keeps project-specific context, lets the agent inspect cloned repositories, exposes approved internal APIs through a guarded MCP tool, and posts the result back to Teams as Adaptive Cards.

## What It Does

- Receives Teams events at `GET /api/events/:slug` or `POST /api/events/:slug`.
- Maintains one OpenCode session per project and Teams conversation.
- Builds a per-project workspace under `workspaces/<slug>/` with cloned repositories, `AGENTS.md`, and `opencode.json`.
- Lets OpenCode call approved API groups through the `call_api` MCP tool without exposing API keys to the agent.
- Stores projects, repositories, API groups, conversations, messages, and API-call audit rows in SQLite.
- Sends asynchronous investigation results to Microsoft Teams through a project webhook.
- Provides an admin UI for project, repository, API group, conversation, and audit management, protected by a session-cookie login.
- Provides a per-project admin chat page that talks to the project's OpenCode agent with live streaming.

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

OpenCode remote control is published on `http://localhost:4096` (or `OPENCODE_PORT` below) for local setup and debugging.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `6666` | Public event API port. |
| `ADMIN_PORT` | `8667` | Private admin UI and `/internal` API port. |
| `ADMIN_USERNAME` | empty | Admin UI login username (required — the admin UI refuses to serve pages until both credentials are set). |
| `ADMIN_PASSWORD` | empty | Admin UI login password (required). |
| `COOKIE_SECURE` | empty | Set to `true` when the admin UI is served over HTTPS so the session cookie is Secure-only. |
| `OPENCODE_PORT` | `4096` | OpenCode remote control port (container-internal; no longer published to the host). |
| `OPENCODE_UI_PORT` | `8668` | OpenCode UI reverse proxy port. Requires an admin session cookie; injects the opencode basic-auth server-side. |
| `OPENCODE_SERVER_PASSWORD` | empty | Optional password for OpenCode remote control. |
| `OTB_DB_PATH` | `data/otb.sqlite` | SQLite database path. |
| `OTB_WORKSPACES_DIR` | `workspaces` | Directory for generated project workspaces. |

## Admin Setup

1. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` and sign in at `http://localhost:8667/admin/login`. Sessions last 7 days (sliding) and survive server restarts; failed logins are rate limited (5 per 15 minutes per IP).
2. Create a project with a unique slug, name, keyword, system prompt, Teams webhook URL, max message length, and chat retention days.
3. Add repository rows (HTTPS token, SSH key, or unauthenticated) and API group rows on the same page — one **Save** button at the top writes everything at once. Leaving a secret field blank keeps the stored value.
4. Add API groups by pasting a working `curl` command plus a markdown description for the agent. OpenTraceBridge extracts the base URL, method, auth header, and API key from the curl command, stores the secret server-side, and redacts it from generated workspace instructions.
5. Point Power Automate at:

```text
https://<public-host>/api/events/<project-slug>?text=...&conversationId=...&userId=...&userName=...
```

Use `<keyword> /new` in Teams to close the active conversation and start a new OpenCode session.

### Admin chat

Open **Chat** from a project row (or the project edit page) to talk to the
project's OpenCode agent directly from the browser. Tool steps and the answer
stream live; messages, runs, and costs are recorded exactly like Teams
conversations under the synthetic conversation id `admin-ui`, so they appear in
the dashboard stats and conversation history. **New conversation** starts a
fresh OpenCode session. One chat run per project executes at a time.

### Per-project isolation

Inside the container each `opencode run` executes as a dedicated system user
(`otb-<slug>`), created on first use. The project workspace is chowned to that
user (`0750`), while the SQLite data directory and `workspaces/.keys` are
root-only (`0700`). A prompt-injected agent that tries to read another
project's workspace, the DB (which holds repo tokens and API keys), or the SSH
keys gets a kernel-level permission error. Per-user opencode sessions persist
in the `project-homes` volume. On a dev host (non-root) this is skipped and
opencode runs as the current user.

Note: the embedded OpenCode UI (below) is served by a single `opencode serve`
process running as root — treat it as an admin power tool; the tracked chat
and Teams paths are the isolated ones.

### Embedded OpenCode UI

Each project also has an **OpenCode** button that embeds the full OpenCode web
interface inside the admin console (iframe served through a reverse proxy on
`OPENCODE_UI_PORT`). The proxy requires a valid admin session cookie and
injects the opencode basic-auth password server-side, so the raw
`opencode serve` port stays unpublished and the password never reaches the
browser. Sessions opened under `workspaces/<slug>` are limited by that
project's generated `opencode.json` (no edit/bash/webfetch, only that
project's `call_api` groups).

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

## Discord

OpenTraceBridge can also host Discord bots (no Power Automate needed — each bot
opens an outbound gateway WebSocket; no new public port).

1. Create an application at <https://discord.com/developers/applications>, add a
   Bot, enable the **Message Content** privileged intent, copy the bot token.
2. Admin UI → **Discord** → add the bot (name + token). Use the invite link
   shown next to the connected bot to add it to your server.
3. On a project's edit page, pick the bot and add the designated channel ids
   (Discord → right-click channel → Copy Channel ID, with developer mode on).
   Mode `mention` answers only @bot messages; `all` answers everything.
4. For private DMs, allowlist Discord user ids on the Discord page. `member`
   users pick from their granted projects (`/projects`, `/project <slug>`);
   `admin` users get every project and full agent tools (edit/bash/webfetch),
   still sandboxed to the per-project OS user.

Slash commands: `/ask`, `/new`, `/stop`, `/status`, `/model`, `/agent`,
`/skills`, `/commands`, `/cmd`, `/stats`, `/sync`, `/guide`, and in DMs
`/projects`, `/project`. Questions are plain messages (or `/ask`); the bot
reacts 👀 while accepted, ✅/❌/⏱️/🛑 when done, keeps the typing indicator
alive while running, splits answers at 2,000 chars without breaking code
fences, and attaches `answer.md` when the answer exceeds
`DISCORD_LONG_ANSWER_THRESHOLD`. Inbound images/text files are downloaded into
`workspaces/<slug>/.otb-uploads/<conversation>/` and passed to the agent.

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
