# OpenTraceBridge Flow Notes

This file records the practical implementation decisions.

## Step 1: Teams Event Ingestion

The first working ingestion path used Power Automate instead of a full Azure Bot Service integration. The selected trigger was Microsoft Teams "When keywords are mentioned in a conversation" for a specific group chat.

Because the tenant did not have access to the premium HTTP action, the working workaround used OneDrive for Business "Upload file from URL". That action can issue a GET request to an external URL, so event data is passed in the query string:

```text
https://<public-host>/api/events/<project-slug>?text=<encoded>&conversationId=<encoded>&userId=<encoded>&userName=<encoded>
```

The server still supports POST for cleaner future integrations.

## Step 2: Dynamic Investigation

Implemented on 2026-07-05.

Main decisions:

- Use SQLite and an Express MVC admin UI.
- Route events by project slug instead of inferring the project from message content.
- Let the agent interpret free-form text instead of requiring rigid commands such as `trace transaction <id>`.
- Keep one OpenCode session per project and Teams conversation.
- Use `<keyword> /new` to start a fresh session.
- Generate a project workspace containing cloned repositories, `AGENTS.md`, and `opencode.json`.
- Expose exactly one MCP tool to OpenCode: `call_api`.
- Enforce API base URL, allowed methods, API-key attachment, and audit logging on the server.
- Send results asynchronously through each project's Teams webhook to avoid Power Automate timeouts.
- Run the app with Docker instead of pm2.

## Runtime

Docker runs the Express app and `opencode serve` in the same container.

- `6666`: public event API.
- `8667`: private admin UI and `/internal` API.
- `4096`: OpenCode remote control, bound to host localhost only.

Persisted data:

- `./data:/app/data`
- `./workspaces:/app/workspaces`
- `opencode-config` for OpenCode auth and session data.

## Remaining Operational Tasks

- Point each Power Automate flow to `/api/events/<project-slug>`.
- Configure a Teams webhook flow and paste the webhook URL into each project.
- Keep the public tunnel pointed only at port `6666`.
- Keep admin and OpenCode ports bound to localhost.
