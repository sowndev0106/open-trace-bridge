# OpenTraceBridge — Requirements (bản đang triển khai)

> Bản gốc trong `README.md` mô tả tầm nhìn đầy đủ (Teams/Discord bot, queue, policy engine, Postgres/Redis, Docker...). Tài liệu này là **requirement thực tế của bản đang build**, đã cập nhật theo các quyết định trong `FLOW.md`. Lịch sử: khởi đầu là quick-win demo với mock UI + fixtures; sau khi Step 1 (nhận event thật từ Teams qua Power Automate) chạy thành công, phạm vi được nâng lên thành hệ thống multi-project động với SQLite + UI quản trị.

## 1. Mục đích

Người dùng chat trong Microsoft Teams group chat (kèm keyword, vd `payment-trace`), hệ thống nhận event, tra cứu evidence (source code đã clone, API nội bộ đã khai báo) và gọi **OpenCode** (CLI, đã cài local v1.2.10) phân tích, rồi gửi kết quả ngược lại Teams qua webhook — thay vì kỹ sư phải tự đi qua nhiều dashboard/log/repo.

## 2. Trạng thái hiện tại (đã chạy thật)

- ✅ **Step 1 — Ingest event từ Teams**: Power Automate flow ("When keywords are mentioned" trên group chat) → Graph API lấy chi tiết message → Parse JSON → OneDrive "Upload file from URL" (workaround không cần Premium license, chỉ GET) → `GET /api/events` với query string. Đã nhận được event thật end-to-end. Chi tiết: `FLOW.md` Step 1/1b/1c.
- ✅ Server Express chạy qua **pm2** (process `open-trace-bridge`), port **6666**, tunnel public tại `https://6666.sowndev.com`.
- 🔲 **Step 2 — Investigation động** (phần dưới đây): đang thiết kế/triển khai.

## 3. Phạm vi Step 2

### Trong phạm vi

- **SQLite** (better-sqlite3) làm storage duy nhất.
- **Multi-project**: mỗi project có slug riêng; URL nhận event là `/api/events/<project-slug>` — Power Automate của mỗi group chat trỏ thẳng URL project tương ứng, không cần đoán project từ nội dung.
- **Admin UI** (Express + EJS, server-rendered, MVC) để CRUD:
  - Project: name, slug, system prompt (markdown), webhook URL trả kết quả về Teams.
  - Repos (nhiều repo / project): git url, auth `ssh` | `https-token` | `none`, token/ssh key (optional), branch.
  - API groups (nhiều group / project, mỗi group 1 API key): name, base URL, API key, auth header, **description markdown mô tả kỹ endpoints/params/filters**.
- **Workspace per project** (`/workspaces/<slug>/`): clone read-only các repo, sinh `AGENTS.md` (system prompt + API descriptions) và `opencode.json` (khai báo MCP server nội bộ).
- **OpenCode agent tự quyết định gọi API**: đọc mô tả API trong context, gọi qua MCP tool duy nhất `call_api(group, method, path, params)`. Server enforce: chỉ base URL đã khai báo, tự gắn API key (agent không thấy key), chỉ method cho phép, ghi audit.
- **Session continuity**: map `(project, teams conversationId) → opencode_session_id` trong DB. Message mới tiếp nối session cũ (`opencode run --session <id>`). Lệnh **`<keyword> /new`** (vd `payment-bot /new`) đóng session hiện tại và tạo session mới ngay (lưu DB).
- **Keyword prefix**: mỗi project khai báo keyword trigger (vd `payment-bot`) — server strip keyword khỏi đầu message trước khi gửi cho agent (agent chỉ nhận nội dung thật: "hi tìm hiểu source code và phân tích lỗi ở transactionId là...").
- **Trả kết quả async qua webhook**: server ack ngay, chạy opencode nền, POST kết quả về `teams_webhook_url` của project (tránh Power Automate timeout).
- **Audit**: bảng `messages` lưu mọi message in/out.
- Xử lý lỗi: opencode timeout (~5 phút)/crash → webhook báo lỗi thân thiện; git clone fail → báo webhook + đánh dấu trong UI; webhook fail → log, không crash.

### Ngoài phạm vi (phase sau, theo README.md)

- Azure Bot Service / Adaptive Card / Discord.
- Policy engine đầy đủ, redact PII/secrets, mã hoá secrets (hiện token/key lưu **plaintext trong SQLite** — chấp nhận vì nội bộ, ghi rõ để phase sau chuyển secret manager).
- Postgres/Redis/queue/worker riêng, network segmentation/hardening container (non-root, cap-drop... — Docker cơ bản NẰM TRONG scope, xem §9).
- Approval workflow, write-action lên production.

## 4. Kiến trúc

```text
Teams group chat ──Power Automate──► GET /api/events/<slug>?text=...&conversationId=...
                                              │
                                              ▼
                                    Express MVC (port 6666, pm2)
                                              │
                    ┌─────────────────────────┼──────────────────────┐
                    ▼                         ▼                      ▼
              SQLite                    Event controller        Admin UI (EJS)
              projects/repos/           /bot-new | tiếp nối     /admin: CRUD project,
              api_groups/               conversation            repos, api groups,
              conversations/messages         │                  xem conversations
                                              ▼
                                   Workspace /workspaces/<slug>/
                                     repos clone + AGENTS.md + opencode.json
                                              │
                                              ▼
                                   opencode run --session <id> "<text>"
                                     agent đọc code + MCP tool call_api(...)
                                              │              │
                                              │              ▼
                                              │    MCP server (nội bộ, cùng process)
                                              │    enforce base URL + gắn key + audit
                                              ▼
                                   Kết quả → POST teams_webhook_url → Teams
```

## 5. Cấu trúc thư mục (MVC)

```text
server.js               ← khởi động, mount routes
routes/                 admin.routes.js, events.routes.js
controllers/            project.controller.js, event.controller.js
models/                 project.model.js, repo.model.js, api.model.js, conversation.model.js
views/                  EJS templates (projects/list, projects/form, conversations/...)
services/               workspace.service.js (git clone/pull, sinh AGENTS.md/opencode.json)
                        opencode.service.js (spawn opencode run --session)
                        webhook.service.js  (POST kết quả về Teams)
                        mcp.service.js      (MCP server + call_api enforcement)
lib/eventGateway.js     ← validate/strip HTML/parse (giữ từ Step 1)
```

## 6. DB Schema (SQLite)

```sql
projects(id, slug UNIQUE, name, keyword, system_prompt, teams_webhook_url, created_at, updated_at)
-- keyword: trigger prefix trong Teams (vd 'payment-bot'), server strip khỏi message trước khi gửi agent
repos(id, project_id FK, git_url, auth_type, token, ssh_key, branch DEFAULT 'main')
api_groups(id, project_id FK, name, base_url, api_key, auth_header DEFAULT 'Authorization', description_md)
conversations(id, project_id FK, teams_conversation_id, opencode_session_id, status, created_at, updated_at)
messages(id, conversation_id FK, direction, user_id, user_name, content, created_at)
```

## 7. Luồng xử lý 1 message

```text
GET /api/events/<slug>?text=...&conversationId=...&userId=...&userName=...
1. Lookup project theo slug → không có → 404
2. Lưu message (direction=in)
3. Strip HTML + strip keyword prefix của project (vd "payment-bot") khỏi đầu text
4. Text còn lại bắt đầu "/new"? → đóng conversation active, tạo session mới ngay (lưu DB), reply webhook "Đã tạo hội thoại mới", xong
5. Tìm conversation active theo (project, conversationId) → chưa có → tạo session opencode mới, lưu DB
6. Ack HTTP 200 ngay — phần sau chạy nền
7. Đảm bảo workspace: clone/pull repos, regenerate AGENTS.md + opencode.json
8. opencode run --session <id> "<text đã strip>"
9. Kết quả/lỗi → POST teams_webhook_url → lưu message direction=out
```

Lưu ý: parse lệnh **không còn bắt cú pháp cứng** `trace transaction <id>` như bản quick-win — text tự do được forward nguyên văn cho agent tự hiểu (quyết định trong `FLOW.md` Step 1b). Chỉ còn lệnh đặc biệt `/bot-new` được xử lý ở server.

## 8. Bảo mật (mức hiện tại)

- Agent không thấy API key/token — server gắn key khi thực thi `call_api`.
- `call_api` chỉ gọi được dưới base URL đã khai báo trong project; mọi call ghi audit.
- Repo clone read-only; agent không có bash/git push (cấu hình opencode agent profile).
- Chấp nhận tạm: secrets plaintext trong SQLite, endpoint `/api/events` chưa có auth (dựa vào URL slug khó đoán) — nâng cấp ở phase sau.

## 9. Triển khai bằng Docker

Chạy toàn bộ bằng Docker (docker-compose), thay cho pm2 khi chuyển sang container:

- **1 container app** chứa cả Express app lẫn `opencode` CLI (cài sẵn trong image, kèm `git`, `ssh`).
- **Ports publish ra ngoài:**
  - `6666` — Express (event API + admin UI), tunnel ra internet như hiện tại.
  - `4096` — **OpenCode server (`opencode serve`) — LUÔN publish**. Lý do: opencode init bên trong container nên cần remote control từ ngoài để (a) setup API key/provider auth lần đầu (`opencode auth` không làm được qua stdin của container), (b) debug session/agent khi có sự cố. Chỉ bind `127.0.0.1:4096` trên host (không expose ra internet) vì cổng này không có auth.
- **Volumes (persist qua restart/rebuild):**
  - `./data:/app/data` — SQLite DB.
  - `./workspaces:/app/workspaces` — repos đã clone.
  - `opencode-config:/root/.local/share/opencode` + `/root/.config/opencode` — auth key, session storage của opencode (mất volume này là mất key + toàn bộ session history).
- Container khởi động chạy song song: `opencode serve --port 4096` và `node server.js` (dùng script entrypoint hoặc supervisord đơn giản).
- `opencode.service.js` gọi opencode qua CLI trong cùng container (hoặc qua HTTP API của `opencode serve` — quyết định lúc implement, ưu tiên cách ổn định hơn khi test thật).

## 10. Tiêu chí thành công Step 2

- Tạo được project qua UI với ≥1 repo và ≥1 API group.
- Chat trong Teams group chat đã gắn Power Automate → nhận được phân tích thật từ OpenCode gửi ngược về Teams qua webhook.
- Hỏi tiếp trong cùng group chat (vd `payment-bot tiếp tục trace ...`) → agent nhớ ngữ cảnh (cùng opencode session); `payment-bot /new` → bắt đầu session mới.
- Agent tự gọi đúng API đã khai báo khi câu hỏi cần dữ liệu (thấy trong audit log).
- Server không crash khi: opencode lỗi/timeout, git clone fail, webhook fail.
- Chạy được bằng `docker compose up`: port 6666 nhận event, port 4096 (localhost) vào được OpenCode remote control để setup key/debug; data + workspaces + opencode auth persist qua restart.
