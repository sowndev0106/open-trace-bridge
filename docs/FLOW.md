# OpenTraceBridge — Flow (Quick-Win Demo)

Tài liệu này ghi lại luồng xử lý được bàn từng bước, đi kèm `REQUIREMENT.md`.
Mỗi bước sẽ được cập nhật/refine dần — bước nào còn "draft, sẽ nghiên cứu lại" sẽ được đánh dấu rõ.

---

## Step 1 — Nhận event từ channel và forward về Event Gateway

> Trạng thái: **draft, sẽ nghiên cứu lại**

### Mục tiêu

User gõ một câu chat có chứa keyword/command trong "channel" (ở bản demo là ô chat trong `index.html`, thay cho Teams thật). Hệ thống cần nhận được tin nhắn đó và gửi POST kèm thông tin cơ bản để bước sau xử lý.

### Quyết định

- **Parse keyword/command ở server-side**, không phải client-side. Frontend gửi lên **toàn bộ tin nhắn thô**, không tự lọc/regex trước. Lý do: giống hệt cách Teams/Discord thật gửi mọi activity cho bot; sau này thay `index.html` bằng webhook Teams thật thì backend không cần đổi logic.
- Endpoint: `POST /api/events` (đóng vai trò Event Gateway trong kiến trúc PRD gốc §6.1).

### Payload event (mock)

```json
{
  "eventId": "evt_<uuid>",
  "source": "mock-teams",
  "raw": {
    "text": "@OpenTraceBridge trace transaction txn_123"
  },
  "user": { "id": "demo-user", "role": "oncall" },
  "channel": {
    "type": "teams",
    "conversationId": "demo-conv-1",
    "threadId": "demo-thread-1"
  },
  "timestamp": "<ISO date>"
}
```

Đây là bản rút gọn của event format thật trong PRD gốc (§6.1) — giữ nguyên field `source` / `user` / `channel` để tương thích khi thay nguồn event thật vào sau.

### Xử lý ở server (`lib/eventGateway.js`)

1. Nhận `POST /api/events`.
2. Validate payload cơ bản: có `raw.text`, có `user`, có `channel`.
3. Gọi `parseCommand(raw.text)` — regex nhận diện:
   - `trace transaction <id>`
   - `trace request <id>`
   - `trace incident <id>`
4. Không match pattern nào → trả lời "usage hint", **dừng lại tại đây** — không tạo incident, không gọi opencode.
5. Match được → tạo internal command object `{ type, id, event }`, forward tiếp sang bước lookup fixtures + gọi opencode (xem `REQUIREMENT.md` §4–§6).
6. UI nhận ack ngay lập tức ("Đã tạo incident INC-xxxx, đang điều tra...") rồi nhận card kết quả sau — giữ đúng cảm giác UX 2 bước dù trong bản demo mọi thứ chạy đồng bộ.

### Việc cần làm khi quay lại nghiên cứu Step 1

- [ ] Xác nhận lại cấu trúc payload event (có cần thêm field nào không, có field nào thừa không).
- [ ] Xác nhận quy tắc regex cho `parseCommand` (case-insensitive? có bắt buộc phải có `@OpenTraceBridge` ở đầu không?).
- [ ] Quyết định response khi không match: im lặng hay luôn trả usage hint (tránh spam nếu sau này nối vào channel thật có nhiều tin nhắn không liên quan).

### Step 1b — Nguồn input THẬT: Power Automate (Teams Workflows)

> Trạng thái: **draft, đang thử nghiệm thật**

Thay vì chờ tích hợp Bot Framework đầy đủ, dùng **Power Automate / Teams Workflows** để nghe thật ngay — không cần đăng ký Azure Bot. Vì bước parse keyword đã đặt ở server-side (`eventGateway.js`), endpoint `/api/events` dùng chung cho cả mock UI (`index.html`) lẫn nguồn thật này — không cần đổi code khi chuyển từ mock sang thật.

**Setup thực tế đã chọn (khác với bản nháp ban đầu):**

- Trigger dùng: **Microsoft Teams — "When keywords are mentioned in a conversation"** (không dùng "When a new channel message is added" như bản nháp đầu, vì trigger keyword-mention tự lọc sẵn, không cần thêm bước Condition riêng).
- **Nghe trên Group chat, không phải Channel** — quyết định có chủ đích của user (không phải nhầm lẫn). `Message type` = `Group chat`, `Conversation Ids` = group chat cụ thể (vd "Testt noti").
- **Keyword hợp nhất thành 1 chuỗi duy nhất: `payment-trace`** (không tách riêng `trace`/`incident`/`request`). Lý do: đơn giản hoá điều kiện trigger — mọi phân loại lệnh cụ thể (transaction/request/incident, ID nào) sẽ do **AGENT (OpenCode) tự đọc hiểu free-text và phân biệt sau**, thay vì bắt buộc đúng cú pháp `trace transaction <id>` ngay từ đầu.
- Action gọi ra ngoài: **"Send an HTTP request V2" (Office 365 Groups)** — dùng thay cho action "HTTP" built-in vì tenant hiện tại không có license Premium cho HTTP chuẩn. (Lưu ý: khi build lại flow trong classic designer `make.powerautomate.com`, action **HTTP** built-in thật lại xuất hiện không bị khoá Premium — nếu vào lại từ đây thì ưu tiên dùng bản HTTP built-in chuẩn thay vì bản Office 365 Groups.)

**⚠️ Tác động tới `lib/eventGateway.js` (cần làm ở Step 2, chưa sửa vội bây giờ):**

`parseCommand()` hiện tại dùng regex cứng, chỉ nhận đúng format `trace transaction/request/incident <id>` — sẽ **KHÔNG match** với tin nhắn tự nhiên kiểu "payment-trace giúp tôi coi txn_123 bị lỗi gì". Cần đổi hướng ở Step 2: nếu regex cứng không match, không trả lỗi/usage-hint nữa mà **forward nguyên văn raw text cho OpenCode** để agent tự trích xuất transaction/request/incident ID và ý định từ free text.

**Setup chi tiết:**

1. Server cần 1 URL HTTPS public — hiện dùng domain tunnel `https://6666.sowndev.com` (đã xác nhận `/health` và `/api/events` phản hồi đúng từ ngoài internet).
2. Power Automate → tạo flow mới, trigger **"When keywords are mentioned in a conversation"**:
   - Keywords to search for: `payment-trace`
   - Message type: `Group chat`
   - Conversation Ids: chọn group chat cần nghe
3. Action gọi ra: **"Send an HTTP request V2" (Office 365 Groups)** (hoặc **HTTP** built-in nếu build lại từ classic designer), POST tới `https://6666.sowndev.com/api/events`, body map theo shape event đã định nghĩa ở Step 1:
   - `source` = `"teams"`
   - `raw.text` = nội dung tin nhắn
   - `user.id` / `user.name` = người gửi
   - `channel.conversationId` = conversation id của group chat, `channel.threadId` = message id
4. (Tuỳ chọn) Nhận response JSON từ action HTTP → thêm action **"Post message in a chat"** để trả kết quả ngược lại group chat thật. Cần lưu ý timeout nếu bước gọi `opencode` chạy lâu — có thể cần tách ack/callback thay vì chờ đồng bộ.

**Việc cần làm tiếp:**

- [ ] Test thật với group chat, xác nhận trigger "When keywords are mentioned" bắt được tin nhắn chứa `payment-trace`.
- [ ] Đo thời gian trễ của trigger (Power Automate polling có thể không tức thời).
- [ ] Quyết định cách trả lời lại group chat: đồng bộ trong flow hay callback riêng.
- [ ] **Step 2**: nới lỏng `parseCommand()` trong `eventGateway.js` — không match regex cứng thì forward free text cho OpenCode thay vì trả usage-hint.

### Step 1c — Vướng mắc: không action free nào gọi được POST ra domain ngoài

> Trạng thái: **đã giải quyết**

Thử nghiệm thật cho thấy cả 2 action tưởng là "generic HTTP" đều **không phải** — chúng là Graph API passthrough bị giới hạn:

- **"Send a Microsoft Graph HTTP request"** (Microsoft Teams connector): chỉ cho gọi path bắt đầu bằng `teams`/`me`/`users` + object con `channels/chats/messages/...`. Không gọi được domain ngoài Graph.
- **"Send an HTTP request"** (Office 365 Outlook/Office 365 Users/Office 365 Groups): tưởng là action gọi URL tự do (thông tin cũ từ cộng đồng, đã lỗi thời) — thực tế cũng chỉ là Graph passthrough, giới hạn còn hẹp hơn (`me`/`users` + `messages/mailFolders/events/calendar/...`). **Không gọi được ra `6666.sowndev.com`.**
- Action **HTTP** built-in thật (gọi được URL bất kỳ) bị khoá **Premium**, tenant hiện tại không có license.

**Giải pháp đã áp dụng — OneDrive for Business "Upload file from URL":**

Action này gọi HTTP **GET** tới URL bất kỳ (không giới hạn domain), lưu response thành file trong OneDrive. Giới hạn: chỉ GET, không gửi được JSON body/custom header, chỉ dùng được với endpoint không yêu cầu authentication — đúng với `server.js` hiện tại (public, không auth).

Vì vậy đổi cách truyền event: thay vì POST + JSON body, encode toàn bộ field thành **query string trên URL**:

```
https://6666.sowndev.com/api/events?text=<url-encode raw text>&userId=<...>&userName=<...>&conversationId=<...>&threadId=<...>&timestamp=<...>
```

`server.js` đã được sửa để `GET /api/events` nhận đúng các query param này (`text`, `userId`, `userName`, `conversationId`, `threadId`, `timestamp`), dùng chung logic xử lý (`handleEvent()`) với route `POST /api/events` (giữ route POST cho mock UI `index.html` sau này).

**Cấu hình action trong Power Automate:**

1. Xoá action "Send an HTTP request" (bị lỗi BadRequest).
2. Thêm action **OneDrive for Business → "Upload file from URL"**.
3. **Address**: build URL bằng cách nối text + dynamic content, mỗi giá trị động phải bọc qua hàm `encodeUriComponent(...)` để tránh ký tự đặc biệt phá query string, ví dụ:
   ```
   https://6666.sowndev.com/api/events?text=@{encodeUriComponent(body('Parse_JSON')?['body']?['content'])}&userId=@{encodeUriComponent(body('Parse_JSON')?['from']?['user']?['id'])}&userName=@{encodeUriComponent(body('Parse_JSON')?['from']?['user']?['displayName'])}&conversationId=@{encodeUriComponent(item()?['conversationId'])}&threadId=@{encodeUriComponent(item()?['messageId'])}&timestamp=@{encodeUriComponent(body('Parse_JSON')?['createdDateTime'])}
   ```
4. **Destination Folder**: 1 thư mục OneDrive bất kỳ để chứa file rác (vd `/OpenTraceBridgeLogs`), có thể xoá định kỳ sau — flow không cần đọc lại nội dung file này.
5. **File Name**: cần duy nhất mỗi lần chạy để tránh lỗi trùng tên, dùng `@{guid()}.json`.

**Việc cần làm tiếp:**

- [ ] Test lại flow với action mới, xác nhận GET tới server thành công (log server phải thấy request).
- [ ] Cân nhắc thêm flow/step dọn dẹp các file rác trong `/OpenTraceBridgeLogs` định kỳ.
- [ ] Nếu sau này xin được Power Automate Premium license, có thể bỏ workaround này, quay lại dùng action HTTP built-in + POST JSON body cho gọn.

---

## Step 2 — Investigation động (multi-project, SQLite, OpenCode session)

> Trạng thái: **ĐÃ IMPLEMENT + smoke test pass (2026-07-05)** — design: `REQUIREMENT.md` §3–§10, plan: `superpowers/plans/2026-07-05-step2-dynamic-investigation.md`, diagram: `DIAGRAMS.md`
>
> Smoke test đã verify: agent trả lời thật từ repo clone; session continuity (hỏi tiếp nhớ ngữ cảnh cùng session); `payment-bot /new` đóng conversation cũ, tạo mới; 17 unit test pass. Bug tìm được khi smoke: spawn opencode với stdin pipe mở làm treo tới timeout 5 phút — fix bằng `stdio: ['ignore',...]`.
>
> **Runtime chính thức: Docker (`docker compose up -d`), pm2 đã gỡ hẳn** (2026-07-05). Container chạy Express 6666 + `opencode serve` 4096 (bind 127.0.0.1 host); auth.json của opencode đã copy từ host vào volume container, đã verify opencode chạy được bên trong container. Lưu ý: session opencode cũ thời pm2 nằm ở host, không có trong container — conversation cũ nào còn giữ session id cũ sẽ lỗi "session not found", cứ `/new` là xong.
>
> Việc còn lại: (1) cập nhật URL Power Automate sang `/api/events/<slug>`; (2) tạo webhook nhận kết quả trong Teams (flow "When a Teams webhook request is received" → Post card in chat) rồi dán URL vào project; (3) Task 11 Docker — file đã viết sẵn, chưa build/test.

Các quyết định chính (bàn ngày 2026-07-05):

- **SQLite + Express MVC (EJS)**: UI admin server-rendered do chính server host, port 6666.
- **URL nhận event kèm project slug**: `/api/events/<slug>` — mỗi group chat Teams có Power Automate flow trỏ URL project riêng, khỏi đoán project.
- **Agent tự quyết định gọi API**: mô tả API (markdown, per group, mỗi group 1 key) đưa vào context; agent gọi qua MCP tool `call_api` duy nhất; server enforce base URL + gắn key + audit — agent không thấy key.
- **Session continuity**: `(project, teams conversationId) → opencode_session_id` trong DB; message mới tiếp nối session cũ; `/bot-new` đóng session, tạo mới.
- **Không parse cú pháp cứng nữa**: text tự do forward nguyên văn cho agent (thay thế TODO "nới lỏng parseCommand" ở Step 1b).
- **Reply async qua webhook** của project (tránh Power Automate timeout).
- **Docker**: 1 container app (Express + opencode), publish 6666 (public qua tunnel) và 4096 (`opencode serve`, chỉ bind localhost) để setup key/debug opencode từ ngoài container; volumes cho SQLite, workspaces, opencode auth/sessions.

## Step 3 — (chưa bàn)
