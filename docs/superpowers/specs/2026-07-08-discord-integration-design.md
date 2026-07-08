# Discord Integration — Design Spec

Date: 2026-07-08
Status: approved for planning

## 1. Overview

Add Discord as a second chat surface next to Microsoft Teams. Admins register one or
more Discord bots globally; each project binds to one bot and designates the channels
the bot may answer in. Allowlisted Discord users can also DM a bot privately, pick a
project they are entitled to, and chat with that project's OpenCode agent. Questions
run through the exact same investigation pipeline as Teams (per-project workspace,
per-project OS user, OpenCode session per conversation, runs/messages/retention).

Unlike Teams (Power Automate + incoming webhook), Discord bots are hosted by us: each
bot opens an outbound WebSocket to the Discord Gateway (`discord.js` v14) and replies
via the REST API. No new public endpoint is opened; the two-port boundary is untouched.

## 2. Architecture

- **In-process gateway clients.** `services/discord.service.js` manages one
  `discord.js` Client per enabled bot. Clients start on server boot and are
  started/restarted/destroyed when an admin saves/enables/disables a bot — no server
  restart needed. `discord.js` handles reconnection and REST rate limits.
- **Intents:** `Guilds`, `GuildMessages`, `DirectMessages`, `MessageContent`
  (+ `Channel` partial for DMs). Message Content is a privileged intent and must be
  enabled in the Discord Developer Portal (no verification needed under 100 servers).
- **Shared pipeline.** Discord routing feeds the same `investigate()` flow used by
  `controllers/event.controller.js`: `sync.ensureReady` → `projectUser` isolation →
  `opencode.runPrompt` → record `messages`/`runs`. The Discord-specific part is only
  trigger detection, permissions, and reply rendering.
- **Rejected alternatives:** separate worker container (more moving parts than the
  deployment needs); Interactions-endpoint-only bot (cannot see plain channel
  messages; 3s ack / 15min follow-up limits do not fit long investigations).

## 3. Data model

New tables (SQLite migrations, same style as existing ones):

```sql
discord_bots(
  id INTEGER PK, name TEXT NOT NULL, token TEXT NOT NULL,       -- secret, redacted in UI
  enabled INTEGER NOT NULL DEFAULT 1, last_error TEXT,
  created_at, updated_at
)

discord_channels(
  id INTEGER PK, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL UNIQUE,                              -- Discord snowflake
  mode TEXT NOT NULL DEFAULT 'mention' CHECK (mode IN ('mention','all')),
  created_at
)

discord_dm_users(
  id INTEGER PK, discord_user_id TEXT NOT NULL UNIQUE, label TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  all_projects INTEGER NOT NULL DEFAULT 0,
  created_at, updated_at
)

discord_dm_user_projects(dm_user_id, project_id)                -- when all_projects = 0

discord_dm_selections(
  dm_user_id INTEGER, bot_id INTEGER, project_id INTEGER,
  PRIMARY KEY (dm_user_id, bot_id)
)

settings(key TEXT PRIMARY KEY, value TEXT)                      -- generic KV; used for
                                                                -- discord model allowlist
```

Changed tables:

- `projects` + `discord_bot_id INTEGER NULL REFERENCES discord_bots(id)` — one bot per
  project; NULL = Discord disabled for the project.
- `conversations`: rename `teams_conversation_id` → `external_id` (SQLite
  `ALTER TABLE ... RENAME COLUMN`; update `conversation.model.js` and callers).
  External id values: Teams keeps its existing conversation ids; Discord uses
  `discord:<channelId>` for channels and `discord:dm:<botId>:<userId>` for DMs.
- `conversations` + `model TEXT NULL`, `agent TEXT NULL` — per-conversation overrides
  set by `/model` and `/agent`; cleared on `/new`.

Settings keys: `discord_allowed_models` (newline-separated `provider/model` entries),
`discord_default_model` (optional; empty = OpenCode default).

## 4. Admin UI

New global page **/admin/discord**:

- **Bots** CRUD: name, token (write-only; shown redacted; blank on edit keeps the
  stored token — same pattern as repo tokens), enabled toggle. Live status per bot:
  connecting / connected (bot username) / error (`last_error`), plus the invite URL
  (`https://discord.com/oauth2/authorize?client_id=<application_id>&scope=bot`,
  application id read from the connected client).
- **DM allowlist** CRUD: Discord user id, label, role (`member`/`admin`),
  all-projects toggle or an explicit project multi-select. Admin role implies access
  to all projects.
- **Models**: textarea for allowed `provider/model` entries + default model.

Project edit page gains a **Discord** section: bot dropdown + channel rows
(channel id, mode `mention`/`all`). Saved with the same single Save button.

## 5. Routing

All inbound gateway messages are ignored when the author is a bot (loop protection).

**Guild channels.** Look up `discord_channels` by channel id; the owning project must
reference the receiving bot. Unknown channel → silence. Mode `mention` → only handle
messages that @mention the bot (mention stripped from the prompt); mode `all` → handle
every message. Replies run with the project's standard locked-down `opencode.json`
(no edit/bash/webfetch; only that project's `call_api` groups).

**DMs.** Sender not in `discord_dm_users` → complete silence (do not reveal the bot).
Allowlisted users must select a project first (`/project`); selectable projects =
projects bound to this bot ∩ the user's entitlements (admins: all projects bound to
the bot). Plain DM text is treated as an investigation prompt in the selected project.
Replies go only to that user's DM.

**DM admin role.** Sessions for `role = 'admin'` users run with a full-permission
OpenCode config: `workspace.service` generates `opencode.admin.json` next to
`opencode.json` (all tools enabled — edit/bash/webfetch/skills — plus the project's
`call_api` groups), and the runner points OpenCode at it (config path env var) for
those runs only. The process still runs as the project OS user `otb-<slug>` — never
root — so DB secrets, SSH keys, and sibling workspaces stay unreadable even under
prompt injection.

**Conversations.** Same lifecycle as Teams: active conversation per external id,
`/new` closes and recreates, inactivity auto-close and retention apply unchanged.

## 6. Slash commands

Registered per bot as global application commands on connect; handled via gateway
`InteractionCreate`. Every command acks immediately with `deferReply`; long results
edit the reply, and if the interaction token has expired (>15 min) the result is sent
as a normal message instead.

Available in channels and DMs:

| Command | Behavior |
| --- | --- |
| `/ask <question>` | Run an investigation (alternative to mention / plain message). |
| `/new` | Close the active conversation, start a fresh OpenCode session; resets model/agent overrides. |
| `/stop` | Cancel the running investigation of this conversation (kills the `opencode run` child; reacts 🛑). |
| `/status` | Project, session id, model/agent in effect, DM role, running run?, last source sync. |
| `/model [name] [variant]` | No args: show current + allowed list. With args: set per-conversation model (autocomplete = `opencode models` output ∩ admin allowlist; variant maps to `--variant`). |
| `/agent [name]` | No args: list workspace agents (`opencode agent list`). With arg: set per-conversation agent (`--agent`). |
| `/skills` | List skills available to the project workspace (scan `.opencode/skill/*/SKILL.md`, workspace + global). |
| `/commands` | List the workspace's custom OpenCode commands (`.opencode/command/`). |
| `/cmd <name> [args]` | Run a workspace custom command (`opencode run --command`). |
| `/stats` | Tokens + cost for the current conversation and project totals (from `runs`). |
| `/sync` | Re-pull project sources (Teams' `pull-source` equivalent). |
| `/guide` | Usage help + command list. |

DM-only:

| Command | Behavior |
| --- | --- |
| `/projects` | List projects the user may access on this bot. |
| `/project <slug>` | Select the DM's active project (autocomplete filtered by entitlements). |

Model/agent overrides are stored on the conversation row and passed to
`opencode run -m <model> [--variant v] [--agent a]`.

`/stop` requires the runner to keep a cancel handle per conversation id
(extension to `opencode.service.js`).

## 7. Replies

- **Investigation answers → plain markdown messages** (best code-block rendering,
  copyable), sent as a reply (message reference) to the triggering message. Content is
  truncated to the project's `max_msg_length`, then split into ≤2,000-character chunks
  (Discord bot limit) without breaking code fences (close ``` at chunk end, reopen at
  next chunk start).
- **Long answers → file.** Above `DISCORD_LONG_ANSWER_THRESHOLD` characters, send the
  head of the answer plus the full text attached as `answer.md` (bot upload limit
  8 MB — never a constraint in practice).
- **Status notices → colored embeds** (Teams Adaptive Card equivalent): blue = info
  (guide, new session), green = success (sync done), yellow = timeout warning,
  red = error. Title + description + footer (project slug, session id). Embed limits:
  4,096-char description, 6,000 chars total.
- **Reactions on the user's message:** 👀 when accepted for processing, then replaced
  by ✅ success / ❌ error / ⏱️ timeout / 🛑 stopped.
- **Typing indicator:** `sendTyping()` every `DISCORD_TYPING_REFRESH_MS` (Discord shows
  ~10 s per call) while the run is active, in channels and DMs.
- No extra acknowledgement messages (same principle as the Teams path).
- Components V2 was evaluated and rejected: 4,000-char total budget, disables
  `content`/`embeds`, more complexity for no benefit here.

## 8. Inbound attachments (files & images)

- Attachments on a handled message are **downloaded immediately** (Discord CDN URLs
  are signed and expire) into
  `workspaces/<slug>/.otb-uploads/<conversation_id>/<message_id>-<filename>`,
  chowned to the project OS user.
- The run is invoked with `opencode run --file <path> ...` per attachment — images go
  to the model as vision input, text files as attached context.
- Message with attachments but no text uses the default prompt:
  "Analyze the attached file(s) in the context of this project."
- Limits (env-configurable): max size per attachment (`DISCORD_MAX_ATTACHMENT_MB`,
  default 20), max attachments per message (`DISCORD_MAX_ATTACHMENTS`, default 5).
  Oversize/overcount → warning embed, message not processed.
- Accepted types: images (png/jpg/jpeg/gif/webp) and text-based files (txt, md, log,
  json, csv, yaml, source code, …). Other binaries → polite warning embed.
- `messages` rows record attachments as `[attachment: <filename>]` markers appended to
  the content so admin-UI history shows them.
- Cleanup: `.otb-uploads/<conversation_id>` is deleted when the retention job deletes
  the conversation (reuses `chat_retention_days`).

## 9. Configuration (env)

Added to `.env.example`:

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_MAX_ATTACHMENT_MB` | `20` | Max size per inbound attachment. |
| `DISCORD_MAX_ATTACHMENTS` | `5` | Max attachments handled per message. |
| `DISCORD_LONG_ANSWER_THRESHOLD` | `6000` | Answer length (chars) above which the full text is attached as `answer.md`. |
| `DISCORD_TYPING_REFRESH_MS` | `8000` | Typing-indicator refresh interval while a run is active. |

Bot tokens are deliberately **not** env vars — they live in the DB and are managed in
the admin UI (multi-bot, no restart on rotation).

## 10. Security

- Bot tokens sit in SQLite; the DB directory is root-only (0700), so per-project agent
  users cannot read them. Tokens are never written into workspaces or sent to clients.
- Gateway connections are outbound WebSockets — no new listening port; public/admin
  port boundary unchanged.
- Channel allowlist and DM allowlist are enforced server-side on every message;
  non-allowlisted DMs get silence.
- Bot-authored messages are ignored (no bot-to-bot loops).
- DM admin "full power" is tool-level only (edit/bash/webfetch in the workspace);
  the OS-user sandbox still applies. Root execution was explicitly rejected.

## 11. Error handling

- Investigation timeout/error → same message shapes as Teams (§4.6/§4.7 of the Teams
  flow), rendered as yellow/red embeds; reaction switched to ⏱️/❌.
- Bot login failure or gateway error → `last_error` stored, surfaced on /admin/discord;
  other bots are unaffected.
- Attachment download failure → warning embed, run proceeds without the file only if
  other inputs exist, otherwise aborts.

## 12. Testing

- The `discord.js` client is wrapped in a thin adapter (`lib/discordClient.js` -
  connect, on-message/on-interaction callbacks, send/reply/react/typing) so all routing
  logic is unit-testable with a fake adapter: channel modes, mention stripping, DM
  allowlist/roles, project selection, command parsing, chunking around code fences,
  attachment filtering, reaction lifecycle.
- Model tests for the new tables and the `external_id` rename.
- `opencode.service` cancel-handle extension covered by stubbed-spawn tests (existing
  pattern).

## 13. Out of scope (deliberate)

- `/get <path>` to download workspace files to Discord.
- `/share`, `/export` (data-exfiltration risk; admin UI already shows history).
- Thread-based replies; Discord-role-based permissions; per-user rate limiting.
- Components V2 rendering.
