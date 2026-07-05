# Step 2 Dynamic Investigation Plan Archive

This file originally held the detailed implementation checklist for Step 2. Step 2 has since been implemented and the active documentation now lives in:

- `README.md`
- `docs/REQUIREMENT.md`
- `docs/FLOW.md`
- `docs/DIAGRAMS.md`
- `docs/send_msg_webhook.md`

Historical summary:

- Added SQLite-backed projects, repositories, API groups, conversations, messages, and API-call audit rows.
- Added the Express/EJS admin UI.
- Added project-specific event URLs at `/api/events/:slug`.
- Added project workspaces with cloned repositories, generated `AGENTS.md`, and generated `opencode.json`.
- Added OpenCode session continuity and the `/new` session reset flow.
- Added the guarded `call_api` MCP tool and `/internal/call-api` enforcement route.
- Added Teams webhook delivery with Adaptive Card formatting, redaction, and message splitting.
- Added Docker runtime support for Express and OpenCode remote control.
- Added tests for models, event parsing, workspace generation, API-call enforcement, OpenCode output parsing, and Teams formatting.
