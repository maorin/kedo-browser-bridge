# kedo Browser Bridge — Protocol

**Protocol versions:** `1.0`, `1.1` (latest)
**Status:** Draft. M1 (1.0) shipped. M2 (1.1, read-only browser control) in development.

This document is the contract between the kedo backend and any Browser Bridge client (Chrome MV3 extension by default; the same protocol can be implemented by other clients later).

## 1. Transport

- WebSocket, JSON frames (UTF-8 text).
- Default endpoint: `ws://localhost:8000/api/ws/browser` (kedo's FastAPI router is mounted under `/api`).
- Token rejection closes the socket with code 4001 immediately after `hello`.

## 2. Compatibility matrix

| Backend supports | Plugin supports | Negotiated | Available actions |
|---|---|---|---|
| 1.0, 1.1 | 1.0 | 1.0 | user_inject only |
| 1.0, 1.1 | 1.0, 1.1 | 1.1 | user_inject + read-only commands (list_tabs, navigate, screenshot, extract, query, wait_for) |

Negotiation: each side advertises a set of supported versions; the highest common version wins. If no overlap, the backend closes with code 4002 (`version_mismatch`) and the plugin shows a banner asking to update.

Breaking changes bump the major (1.x → 2.0). Additive new actions / fields are minor (1.x → 1.x+1).

## 3. Session roles

Each session has a `role`:

- `user` — the plugin runs in the user's normal browser. Default for users who install from the Chrome Web Store / Load unpacked.
- `agent` — the plugin runs in a kedo-launched Chrome instance with an isolated `--user-data-dir`. The backend trusts this session for autonomous research only and applies stricter rules for writes.

The plugin reports a `role_hint` on `hello`; the backend confirms the actual `role` on `hello_ack` (it may downgrade).

## 4. Messages

### 4.1 Handshake

```jsonc
// client → server (first frame after open)
{
  "type": "hello",
  "client": "kedo-browser-bridge",
  "client_version": "0.1.0",
  "protocol_versions": ["1.0"],
  "role_hint": "user",
  "token": "<from ~/.config/kedo/browser_token>"
}

// server → client
{
  "type": "hello_ack",
  "session_id": "...",
  "negotiated_protocol": "1.0",
  "role": "user",
  "server_capabilities": ["context_inbox", "permission_v1"]
}
```

If the server cannot accept (bad token / version mismatch), it sends `hello_nack` and closes:

```json
{ "type": "hello_nack", "reason": "version_mismatch" | "bad_token" | "duplicate_session" }
```

### 4.2 Heartbeat

Either side may send. Both sides treat 60 s of silence as "stale" and close with code 4003.

```json
{ "type": "heartbeat", "ts": 1714161234567 }
```

### 4.3 User inject (B scenario)

Plugin pushes the active page's content to the backend's Context Inbox. Not an RPC — no command id, no response expected beyond `ack`.

```jsonc
// client → server
{
  "type": "user_inject",
  "payload": {
    "url": "https://...",
    "title": "...",
    "dom_text": "Readability output, plain text",
    "excerpt": "Readability excerpt or null",
    "selection": "user-selected text or null",
    "screenshot_data_url": "data:image/png;base64,..." | null,
    "user_note": "optional user note" | null,
    "captured_at": "2026-05-08T14:23:11Z"
  }
}

// server → client
{
  "type": "ack",
  "kind": "user_inject_received",
  "inbox_item_id": "..."
}
```

The backend stores the screenshot under `~/.kedo/cache/screenshots/<inbox_item_id>.png` and rewrites the path before persisting the inbox row.

### 4.4 Command / result (1.1)

Server-to-client RPC. The plugin echoes back a `result` keyed by `id`. Read-only and navigation actions are normative as of 1.1; click / type / submit / permission_response will be added in 1.2 with M3.

```jsonc
// server → client
{ "type": "command", "id": "<uuid>", "action": "<action>", "params": { ... } }

// client → server (success)
{ "type": "result", "id": "<uuid>", "success": true, "data": { ... } }

// client → server (failure)
{ "type": "result", "id": "<uuid>", "success": false,
  "error": { "code": "ELEMENT_NOT_FOUND", "message": "..." } }
```

#### 4.4.1 Action: `list_tabs`

No parameters. Returns:

```json
{ "tabs": [
    { "id": 12, "window_id": 1, "url": "https://...", "title": "...",
      "active": true, "status": "complete" }
  ] }
```

#### 4.4.2 Action: `navigate`

Params:

| field | type | required | default |
|---|---|---|---|
| `url` | string | yes | — |
| `tab_id` | int | no | active tab |
| `new_tab` | bool | no | false |
| `timeout_ms` | int | no | 30000 |

Returns `{ tab_id, url, title, status }`. Errors with `PROTOCOL_BLOCKED` for non-http(s) schemes, `NAVIGATION_TIMEOUT` if page does not reach `complete` within timeout.

#### 4.4.3 Action: `screenshot`

Params: `tab_id` (optional). Returns `{ data_url, tab_id }`. `data_url` is `data:image/png;base64,...`.

#### 4.4.4 Action: `extract`

Params: `tab_id` (optional). Returns `{ url, title, text_content, excerpt, length, selection }`. Uses Mozilla Readability on a DOM clone.

#### 4.4.5 Action: `query`

Params (at least one of selector/text_match/aria_label is required):

| field | type | required |
|---|---|---|
| `selector` | string (CSS) | one of three |
| `text_match` | string (substring) | one of three |
| `aria_label` | string (exact) | one of three |
| `tab_id` | int | no |
| `limit` | int (default 20) | no |

Returns `{ total, matches: [{ matched_strategy, tag, role, aria_label, text, href, visible, is_password_field, rect: {x,y,w,h} }] }`. `is_password_field` is true for `<input type=password>` or `autocomplete~="cc-"`; clients must refuse to interact with these in 1.2+.

#### 4.4.6 Action: `wait_for`

Params: same triple as `query`, plus:

| field | type | default |
|---|---|---|
| `vanish` | bool | false |
| `timeout_ms` | int (max 60000) | 30000 |

Returns `{ found, elapsed_ms, count }` on success, or `{ error: "WAIT_TIMEOUT" }` on timeout.

### 4.5 Permission request (M3+, reserved)

Backend asks the plugin to display a confirmation UI when the dashboard is not the active surface.

```json
{ "type": "permission_request", "id": "...", "action": "click", "domain": "example.com", "tier": 2 }
{ "type": "permission_response", "id": "...", "decision": "allow_once" | "allow_30min" | "deny" }
```

## 5. Error codes (from `result.error.code`)

| code | when |
|---|---|
| `ELEMENT_NOT_FOUND` | selector + text + aria triple all missed |
| `PERMISSION_DENIED` | user denied or domain blocked |
| `NAVIGATION_TIMEOUT` | page did not load within 30 s |
| `PASSWORD_FIELD_BLOCKED` | type/click hit a `type=password` or `autocomplete~="cc-"` field |
| `NO_AGENT_SESSION` | the isolated profile is not running |
| `PROTOCOL_BLOCKED` | URL is `chrome://`, `file://`, or `chrome-extension://` |
| `INTERNAL` | unhandled exception in client; details in `message` |

## 6. Hard rules (cannot be overridden by config)

The plugin **must** enforce these client-side regardless of any server command:

1. Reject any action whose target URL is `chrome://`, `file://`, or `chrome-extension://`. Return `PROTOCOL_BLOCKED`.
2. Skip any input matching `<input type="password">` or `autocomplete~="cc-"`. Return `PASSWORD_FIELD_BLOCKED`.
3. Do not traverse cross-origin iframes for query/click/type.
4. Do not execute arbitrary JS strings supplied by the server (M3+ may add a vetted action library, but `eval`-style passthrough is forbidden by this protocol).
5. On CAPTCHA detection (heuristic: presence of `iframe[src*="recaptcha"]`, `[data-sitekey]`, etc.), abort with `PERMISSION_DENIED` and message `"captcha_detected"` — do not attempt to interact.

## 7. Audit

The plugin SHOULD log every received `command` and emitted `result` to `chrome.storage.local` under key `audit_log_v1` (capped at 1000 entries, FIFO). The user can export the log from the popup.

The backend MUST log every command it issues to `~/.kedo/browser-audit.jsonl`.

## 8. Versioning policy

- `1.x` minor: additive only (new actions, new fields, new error codes).
- `2.0`: breaking changes (renamed fields, removed messages, different transport).
- The plugin and backend independently advertise supported versions; they pick the highest common one.
