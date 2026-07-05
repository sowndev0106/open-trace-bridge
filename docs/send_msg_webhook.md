# Send Message Webhook Format

Tài liệu này định nghĩa các format message OpenTraceBridge gửi về Microsoft Teams qua
Power Automate webhook sau khi OpenCode trả lời.

Webhook này chỉ dùng cho chiều **server -> Teams**. Flow không gửi `ack` message để
tránh spam group chat. Server chỉ gửi khi có kết quả thật, lỗi, timeout, hoặc sự kiện
session.

## 1. Transport

Webhook URL là HTTP POST URL lấy từ Power Automate trigger:

```text
When a Teams webhook request is received
```

Request luôn dùng:

```http
POST <teams_webhook_url>
Content-Type: application/json
```

Payload chuẩn là Adaptive Card wrapper:

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "content": {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": []
      }
    }
  ]
}
```

## 2. Message Contract

`webhook.service.js` nên build card từ object nội bộ dạng:

```js
{
  kind: 'investigation_report',
  status: 'success',
  title: 'Payment investigation',
  summary: 'Transaction txn_123 fail ở callback verification.',
  sections: [
    { title: 'Evidence', text: '- API status FAILED\n- Log SIGNATURE_INVALID' },
    { title: 'Next actions', text: '- Kiểm tra WEBHOOK_SECRET' }
  ],
  codeBlocks: [
    {
      language: 'js',
      file: 'services/payment/callback.js',
      text: 'function verifySignature(payload, signature) { ... }'
    }
  ],
  dataBlocks: [
    {
      title: 'Transaction API response',
      language: 'json',
      text: '{ "status": "FAILED" }'
    }
  ],
  metadata: {
    project: 'payment',
    sessionId: 'ses_xxx',
    conversationId: 'teams-conv-id'
  }
}
```

`kind` quyết định bố cục. `status` quyết định tone của title/subtitle:

```text
success  kết quả hoàn tất
warning  timeout hoặc kết quả một phần
error    lỗi hệ thống
info     session event
debug    code/data snapshot nếu gửi riêng
```

## 3. Shared Card Layout

Mỗi card nên theo thứ tự:

1. Title ngắn, rõ nội dung.
2. Summary 1-3 dòng.
3. Các section chính.
4. Code/data block nếu có.
5. Metadata nhỏ ở cuối.

Adaptive Card body gợi ý:

```json
[
  {
    "type": "TextBlock",
    "text": "Payment investigation",
    "weight": "Bolder",
    "size": "Medium",
    "wrap": true
  },
  {
    "type": "TextBlock",
    "text": "Transaction txn_123 fail ở callback verification.",
    "wrap": true,
    "spacing": "Small"
  },
  {
    "type": "TextBlock",
    "text": "**Evidence**\n- API status FAILED\n- Log SIGNATURE_INVALID",
    "wrap": true,
    "spacing": "Medium"
  },
  {
    "type": "TextBlock",
    "text": "Project: payment | Session: ses_xxx",
    "isSubtle": true,
    "wrap": true,
    "spacing": "Medium"
  }
]
```

## 4. Response Kinds

### 4.1 `success_answer`

Dùng cho câu trả lời bình thường từ OpenCode, không cần report nhiều section.

Required fields:

```text
kind: success_answer
status: success
title
summary hoặc sections[0].text
metadata.project
```

Format:

```text
Kết quả

Transaction txn_123 đang ở trạng thái FAILED.
Nguyên nhân gần nhất là callback verification không pass.

Project: payment | Session: ses_xxx
```

### 4.2 `investigation_report`

Dùng cho phân tích incident/transaction/request. Đây là format chính của dự án.

Required sections:

```text
Tóm tắt
Kết luận
Evidence
Bước tiếp theo
```

Optional sections:

```text
Nguyên nhân khả nghi
API đã gọi
Repo/code liên quan
Rủi ro còn lại
```

Format:

```text
Payment investigation

Tóm tắt
Transaction txn_123 fail sau khi provider callback về hệ thống.

Kết luận
Lỗi nhiều khả năng nằm ở callback verification, không phải request outbound.

Evidence
- API /transactions/txn_123 status = FAILED
- Provider status = SUCCESS
- Log ghi nhận SIGNATURE_INVALID

Bước tiếp theo
- Kiểm tra WEBHOOK_SECRET giữa gateway và payment-service
- So sánh raw callback payload trước/sau proxy
```

### 4.3 `code_reference`

Dùng khi OpenCode cần gửi code snippet hoặc giải thích logic trong repo.

Rules:

- Luôn ghi file path.
- Luôn nói vì sao đoạn code liên quan.
- Chỉ gửi excerpt quan trọng.
- Nếu code dài hơn khoảng 80 dòng, truncate và ghi rõ đã cắt.
- Không gửi secret, token, private key.

Format:

````text
Code liên quan

File: services/payment/callback.js
Function: verifySignature

```js
function verifySignature(payload, signature) {
  const expected = hmac(payload, process.env.WEBHOOK_SECRET);
  return expected === signature;
}
```

Nhận xét
Logic này phụ thuộc WEBHOOK_SECRET. Nếu secret lệch giữa provider và service,
callback sẽ bị reject.
````

### 4.4 `data_snapshot`

Dùng khi trả về log, JSON, hoặc API response.

Rules:

- Hiển thị key fields trước raw data.
- Redact các key nhạy cảm: `authorization`, `api_key`, `token`, `secret`,
  `password`, `cookie`, `set-cookie`.
- Raw data dài phải truncate.
- Không gửi toàn bộ response nếu chỉ cần vài field.

Format:

````text
API snapshot

Endpoint: GET /transactions/txn_123
HTTP status: 200

Key fields
- transactionStatus: FAILED
- providerStatus: SUCCESS
- failureCode: SIGNATURE_INVALID

Raw excerpt
```json
{
  "id": "txn_123",
  "transactionStatus": "FAILED",
  "providerStatus": "SUCCESS"
}
```
````

### 4.5 `new_session`

Dùng khi user gửi lệnh `/new` sau khi strip keyword.

Required fields:

```text
kind: new_session
status: info
title
metadata.project
```

Format:

```text
Đã tạo hội thoại mới

Project: Payment Service
Các câu hỏi tiếp theo trong group chat này sẽ dùng OpenCode session mới.
```

### 4.6 `partial_or_timeout`

Dùng khi OpenCode timeout hoặc chỉ có kết quả một phần.

Required fields:

```text
kind: partial_or_timeout
status: warning
title
summary
sections: Đã xác định, Chưa hoàn tất, Gợi ý tiếp theo
```

Format:

```text
Phân tích chưa hoàn tất

OpenCode chạy quá 5 phút nên server đã dừng job.

Đã xác định
- Transaction tồn tại
- Status hiện tại là FAILED
- Có dấu hiệu lỗi callback

Chưa hoàn tất
- Chưa đọc hết log callback
- Chưa đối chiếu config provider

Gợi ý tiếp theo
Bạn có thể hỏi: "payment-bot tiếp tục kiểm tra callback logs cho txn_123".
```

### 4.7 `error`

Dùng cho lỗi hệ thống: git clone fail, API fail, OpenCode crash, thiếu config,
webhook fail nội bộ, hoặc exception không mong muốn.

Rules:

- Không lộ secret.
- Message thân thiện, nói user có thể làm gì.
- Technical detail ngắn, đủ debug.
- Nếu lỗi webhook fail thì chỉ log server; không thể gửi chính lỗi đó về webhook.

Format:

```text
Không hoàn tất được phân tích

Lý do
Không clone được repo payment-service.

Chi tiết kỹ thuật
git exited with code 128

Gợi ý
Kiểm tra Git URL/token trong Admin UI.
```

## 5. Handling Long OpenCode Output

OpenCode có thể trả lời rất dài, kèm code/log/JSON. Trước khi gửi Teams:

1. Normalize markdown line endings.
2. Redact secrets.
3. Split thành sections nếu nhận diện được heading.
4. Giữ summary ở đầu.
5. Truncate mỗi code/data block nếu quá dài.
6. Nếu tổng card quá dài, gửi phần chính trước và ghi rõ phần đã cắt.

Giới hạn nội bộ đề xuất:

```text
summary: tối đa 600 ký tự
section text: tối đa 2500 ký tự / section
code block: tối đa 80 dòng hoặc 6000 ký tự
data block: tối đa 120 dòng hoặc 8000 ký tự
card total: tối đa 22000 ký tự trước khi POST
```

Khi truncate, thêm dòng:

```text
[Đã cắt bớt nội dung dài. Hỏi tiếp trong thread nếu cần phần chi tiết.]
```

## 6. Redaction Rules

Trước khi gửi Teams, replace các pattern nhạy cảm:

```text
Authorization: Bearer <...>       -> Authorization: [REDACTED]
x-api-key: <...>                  -> x-api-key: [REDACTED]
api_key=<...>                     -> api_key=[REDACTED]
token=<...>                       -> token=[REDACTED]
password=<...>                    -> password=[REDACTED]
secret=<...>                      -> secret=[REDACTED]
-----BEGIN ... PRIVATE KEY-----   -> [REDACTED_PRIVATE_KEY]
```

Redaction chạy cho cả summary, sections, codeBlocks, dataBlocks, technical detail.

## 7. Test Payloads

Thay `<WEBHOOK_URL>` bằng URL Power Automate đã copy từ flow sạch footer.

### 7.1 Test `success_answer`

```bash
curl -X POST '<WEBHOOK_URL>' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "message",
    "attachments": [
      {
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {
          "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
          "type": "AdaptiveCard",
          "version": "1.4",
          "body": [
            {
              "type": "TextBlock",
              "text": "Kết quả",
              "weight": "Bolder",
              "size": "Medium",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "Transaction txn_123 đang ở trạng thái FAILED. Nguyên nhân gần nhất là callback verification không pass.",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "Project: payment | Session: ses_test",
              "isSubtle": true,
              "wrap": true
            }
          ]
        }
      }
    ]
  }'
```

### 7.2 Test `investigation_report`

```bash
curl -X POST '<WEBHOOK_URL>' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "message",
    "attachments": [
      {
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {
          "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
          "type": "AdaptiveCard",
          "version": "1.4",
          "body": [
            {
              "type": "TextBlock",
              "text": "Payment investigation",
              "weight": "Bolder",
              "size": "Medium",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "**Tóm tắt**\\nTransaction txn_123 fail sau khi provider callback về hệ thống.",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "**Kết luận**\\nLỗi nhiều khả năng nằm ở callback verification, không phải request outbound.",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "**Evidence**\\n- API /transactions/txn_123 status = FAILED\\n- Provider status = SUCCESS\\n- Log SIGNATURE_INVALID",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "**Bước tiếp theo**\\n- Kiểm tra WEBHOOK_SECRET\\n- So sánh raw callback payload trước/sau proxy",
              "wrap": true
            }
          ]
        }
      }
    ]
  }'
```

### 7.3 Test `code_reference`

```bash
curl -X POST '<WEBHOOK_URL>' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "message",
    "attachments": [
      {
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {
          "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
          "type": "AdaptiveCard",
          "version": "1.4",
          "body": [
            {
              "type": "TextBlock",
              "text": "Code liên quan",
              "weight": "Bolder",
              "size": "Medium",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "File: services/payment/callback.js\\nFunction: verifySignature",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "```js\\nfunction verifySignature(payload, signature) {\\n  const expected = hmac(payload, process.env.WEBHOOK_SECRET);\\n  return expected === signature;\\n}\\n```",
              "wrap": true,
              "fontType": "Monospace"
            },
            {
              "type": "TextBlock",
              "text": "**Nhận xét**\\nLogic này phụ thuộc WEBHOOK_SECRET. Nếu secret lệch giữa provider và service, callback sẽ bị reject.",
              "wrap": true
            }
          ]
        }
      }
    ]
  }'
```

### 7.4 Test `error`

```bash
curl -X POST '<WEBHOOK_URL>' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "message",
    "attachments": [
      {
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {
          "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
          "type": "AdaptiveCard",
          "version": "1.4",
          "body": [
            {
              "type": "TextBlock",
              "text": "Không hoàn tất được phân tích",
              "weight": "Bolder",
              "size": "Medium",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "**Lý do**\\nKhông clone được repo payment-service.",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "**Chi tiết kỹ thuật**\\ngit exited with code 128",
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": "**Gợi ý**\\nKiểm tra Git URL/token trong Admin UI.",
              "wrap": true
            }
          ]
        }
      }
    ]
  }'
```

## 8. Implementation Notes

- `sendTeamsMessage(webhookUrl, message)` nên accept object contract, không chỉ raw
  markdown string.
- Không gửi `ack`.
- `/new` gửi `new_session`.
- OpenCode timeout gửi `partial_or_timeout` nếu có partial text, nếu không có partial
  text vẫn dùng `partial_or_timeout` với nội dung thân thiện.
- Exception không recover được gửi `error`.
- Nếu webhook trả non-2xx: log lỗi server, lưu audit `direction=out` với trạng thái
  webhook fail nếu schema hỗ trợ, nhưng không crash process.
