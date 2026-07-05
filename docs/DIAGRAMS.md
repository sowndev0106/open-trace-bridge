# OpenTraceBridge — Flow Diagrams

## 1. Kiến trúc tổng thể

```mermaid
flowchart TB
    subgraph TEAMS["Microsoft Teams"]
        GC["Group chat<br/>(user gõ: payment-bot ...)"]
    end

    subgraph PA["Power Automate (không cần Premium)"]
        TR["Trigger: When keywords<br/>are mentioned"]
        GR["Send a Microsoft Graph<br/>HTTP request<br/>(lấy nội dung message)"]
        PJ["Parse JSON"]
        UP["OneDrive: Upload file from URL<br/>(workaround gọi GET ra ngoài)"]
        TR --> GR --> PJ --> UP
    end

    subgraph SRV["OpenTraceBridge Server (Express MVC, port 6666)"]
        EV["GET /api/events/:slug"]
        GW["eventGateway<br/>strip HTML + keyword, detect /new"]
        DB[("SQLite<br/>projects / repos / api_groups<br/>conversations / messages / api_calls")]
        ADM["Admin UI (EJS)<br/>/admin/projects"]
        WS["workspace.service<br/>git clone/pull + AGENTS.md<br/>+ opencode.json"]
        OC["opencode.service<br/>opencode run -s session"]
        IN["/internal/call-api<br/>(enforce base URL, method,<br/>gắn API key, audit)"]
        WH["webhook.service<br/>Adaptive Card"]
        EV --> GW --> DB
        GW --> WS --> OC
        OC --> WH
        ADM --> DB
    end

    subgraph AGENT["OpenCode Agent (per workspace)"]
        AG["Đọc source code<br/>+ AGENTS.md"]
        MCP["MCP tool: call_api"]
        AG --> MCP
    end

    EXT["API nội bộ<br/>(transaction / logs / trace...)"]

    GC --> TR
    UP -- "GET ?text=&conversationId=..." --> EV
    OC <--> AG
    MCP --> IN --> EXT
    WH -- "POST Adaptive Card" --> GC
```

## 2. Sequence: một câu hỏi điều tra từ Teams

```mermaid
sequenceDiagram
    actor U as User (Teams)
    participant PA as Power Automate
    participant S as Server :6666
    participant DB as SQLite
    participant W as Workspace
    participant O as opencode CLI
    participant A as API nội bộ
    participant T as Teams (webhook)

    U->>PA: "payment-bot phân tích lỗi txn_123"
    PA->>PA: Graph API lấy message + Parse JSON
    PA->>S: GET /api/events/payment?text=...&conversationId=...
    S->>DB: lưu message (in), tìm conversation active
    alt chưa có conversation
        S->>DB: tạo conversation mới (session = NULL)
    end
    S-->>PA: 200 {action: investigating} (ack ngay)

    Note over S,O: chạy nền (async)
    S->>W: git clone/pull repos, ghi AGENTS.md + opencode.json
    S->>O: opencode run --format json [-s session] "prompt"
    O->>O: đọc source code trong workspace
    O->>S: MCP call_api(group, GET, /path)
    S->>S: enforce base URL + method, gắn API key
    S->>A: GET https://api.internal/...
    A-->>S: JSON data
    S-->>O: kết quả (đã audit vào api_calls)
    O-->>S: answer + sessionID
    S->>DB: lưu sessionID (lần đầu) + message (out)
    S->>T: POST webhook (Adaptive Card)
    T-->>U: Bot trả kết quả vào group chat
```

## 3. Vòng đời conversation & session (lệnh /new)

```mermaid
stateDiagram-v2
    [*] --> KhongCo: chưa từng chat
    KhongCo --> Active_NoSession: message đầu tiên<br/>(tạo conversation, session=NULL)
    Active_NoSession --> Active_CoSession: opencode run xong<br/>lưu sessionID vào DB
    Active_CoSession --> Active_CoSession: message tiếp theo<br/>opencode run -s SESSION<br/>(nhớ ngữ cảnh cũ)
    Active_CoSession --> Closed: "payment-bot /new"
    Active_NoSession --> Closed: "payment-bot /new"
    Closed --> Active_NoSession: message sau đó<br/>(conversation MỚI, session MỚI)
    note right of Active_CoSession
        (project, teams_conversation_id)
        → opencode_session_id
        Map lưu trong bảng conversations
    end note
```

## 4. Enforcement khi agent gọi API (call_api)

```mermaid
flowchart TD
    A["Agent gọi call_api(group, method, path, params)"] --> B["MCP stdio script<br/>(có OTB_INTERNAL_TOKEN trong env)"]
    B --> C["POST /internal/call-api"]
    C --> D{"Token đúng?"}
    D -- sai --> X1["403 forbidden"]
    D -- đúng --> E{"Group tồn tại<br/>trong project?"}
    E -- không --> X2["Lỗi: group không tồn tại"]
    E -- có --> F{"Method nằm trong<br/>allowed_methods?"}
    F -- không --> X3["Lỗi: method không được phép"]
    F -- có --> G{"Path tương đối +<br/>URL cuối nằm dưới base_url?"}
    G -- không --> X4["Lỗi: vượt ra ngoài base URL"]
    G -- có --> H["Gắn header API key<br/>(agent KHÔNG BAO GIỜ thấy key)"]
    H --> I["fetch (timeout 30s)"]
    I --> J["Ghi audit vào api_calls<br/>(kể cả khi lỗi)"]
    J --> K["Trả JSON về agent"]
```

## 5. Luồng xử lý request trong server (điểm rẽ nhánh)

```mermaid
flowchart TD
    A["GET/POST /api/events/:slug"] --> B{"Project slug<br/>tồn tại?"}
    B -- không --> E404["404"]
    B -- có --> C{"Có text +<br/>conversationId?"}
    C -- không --> E400["400"]
    C -- có --> D["extractPrompt:<br/>strip HTML + keyword"]
    D --> E{"Bắt đầu bằng /new?"}
    E -- có --> F["Đóng conversation active<br/>Tạo conversation mới<br/>Webhook: 'Đã tạo hội thoại mới'"]
    E -- không --> G{"Có conversation<br/>active?"}
    G -- không --> H["Tạo conversation mới"]
    G -- có --> I["Dùng conversation cũ<br/>(tiếp nối session)"]
    H --> J["ACK 200 ngay lập tức"]
    I --> J
    J --> K["Nền: workspace → opencode → webhook"]
    K -- lỗi git/timeout/crash --> L["Webhook báo lỗi thân thiện<br/>+ lưu [error] vào messages"]
    K -- thành công --> M["Webhook gửi answer<br/>+ lưu messages (out)"]
```
