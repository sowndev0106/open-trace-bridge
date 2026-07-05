# Send Message Webhook Format

This document defines the message format OpenTraceBridge sends to Microsoft Teams through a Power Automate webhook after OpenCode returns an answer.

The webhook is used only for server-to-Teams messages. The server does not send chat acknowledgements, which avoids group-chat noise.

## Transport

The webhook URL comes from a Power Automate trigger such as "When a Teams webhook request is received".

Requests use:

```http
POST <WEBHOOK_URL>
content-type: application/json
```

The payload is an Adaptive Card wrapper:

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

## Internal Message Contract

`webhook.service.js` accepts this internal object:

```js
{
  status: 'success',
  title: 'Payment investigation',
  markdown: 'Transaction txn_123 failed during callback verification.',
  metadata: { project: 'payment', sessionId: 'ses_123' },
  maxLength: 20000
}
```

`status` controls the title marker:

| Status | Meaning |
| --- | --- |
| `success` | Completed result |
| `warning` | Timeout or partial result |
| `error` | System error |
| `info` | Informational event |
| `debug` | Optional debug snapshot |

## Card Layout

Each card should contain:

1. A short title.
2. The main markdown content.
3. Code or data blocks when present.
4. Subtle metadata at the bottom.

Long output is split into multiple cards. Split code blocks are closed and reopened so every card remains valid markdown.

## Response Kinds

### Success Answer

Used for normal OpenCode answers.

Example title:

```text
Payment - Result
```

Example body:

```text
**Summary**
Transaction txn_123 is currently FAILED.

**Conclusion**
The closest cause is callback verification.
```

### Investigation Report

Used for incident, transaction, or request analysis. Preferred headings:

- Summary
- Conclusion
- Evidence
- Next steps

Optional headings:

- Suspected cause
- API calls
- Related repository/code
- Remaining risk

### Code Reference

Used when the agent sends a code excerpt or explains repository logic.

Rules:

- Always include the file path.
- Explain why the excerpt matters.
- Send only the important excerpt.
- Truncate code longer than roughly 80 lines.
- Never send secrets, tokens, API keys, or private keys.

### Data Snapshot

Used for logs, JSON, or API responses.

Rules:

- Show key fields before raw data.
- Redact sensitive keys such as `authorization`, `api_key`, `token`, `secret`, `password`, `private_key`, `cookie`, and `set-cookie`.
- Truncate long raw data.
- Avoid sending entire responses when a few fields are enough.

### New Session

Used when the user sends `/new` after the keyword.

Example:

```text
New conversation created

The next questions in this group chat will use a new OpenCode session.
```

### Timeout Or Partial Result

Used when OpenCode times out or the server has only partial information.

Recommended sections:

- What was confirmed
- What did not finish
- Suggested next question

### Error

Used for system errors such as git clone failure, API failure, OpenCode crash, missing configuration, webhook failure, or unexpected exceptions.

Rules:

- Do not expose secrets.
- Use a friendly message.
- Include short technical detail when it helps debugging.
- If the webhook itself fails, log the error server-side; the same webhook cannot receive its own failure.

## Long Output Handling

Before sending Teams output:

1. Redact sensitive values.
2. Preserve fenced code blocks.
3. Split markdown by block boundaries when possible.
4. Keep the summary near the top.
5. Truncate long code or data blocks when needed.
6. If a full result is too long, send the useful part and make the truncation clear.

Suggested limits:

```text
summary: max 600 characters
section text: max 2500 characters per section
code block: max 80 lines or 6000 characters
data block: max 120 lines or 8000 characters
card total: max 22000 characters before POST
```

Truncation marker:

```text
[Long content was truncated. Ask a follow-up question in the thread if you need details.]
```

## Redaction Rules

Redaction runs across summaries, sections, code blocks, data blocks, and technical details.

Patterns currently include:

- `Authorization: Bearer ...`
- `x-api-key: ...`
- `api_key=...`
- `token=...`
- `password=...`
- `secret=...`
- PEM private keys

## Implementation Notes

- `sendTeamsMessage(webhookUrl, message)` accepts the object contract above.
- Do not send acknowledgement messages to the group chat.
- `/new` sends a `new_session` style info card.
- OpenCode timeouts send a warning card.
- Unrecoverable exceptions send an error card.
- Non-2xx webhook responses are logged and must not crash the process.
