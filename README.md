# kedo-browser-bridge

Chrome (Manifest V3) extension that bridges the user's browser with a [kedo](https://github.com/supermaojj/kedo) backend over WebSocket.

**Status:** M1 (channel + context inbox). The plugin only sends pages to kedo — agent control of the browser comes in M2/M3.

See `PROTOCOL.md` for the wire format and `../kedo/docs/deep-dives/browser-bridge-design.md` for the full design.

## What M1 does

- Connects to a kedo backend at `ws://localhost:8765/ws/browser` (configurable).
- Adds a popup with a **Send to kedo** button: extracts the active page's main content (Mozilla Readability) + screenshot + optional user note, posts it to the kedo backend, where it lands in the *Context Inbox*.
- Does **not** create a kedo task automatically — the user picks inbox items in the kedo dashboard and starts a task from there.

## Dev setup

```bash
pnpm install
pnpm dev          # vite watch, outputs to dist/
```

Then in Chrome: `chrome://extensions/` → Developer mode → **Load unpacked** → select `dist/`.

On first popup open, paste:
- the kedo backend URL (default `ws://localhost:8765/ws/browser`)
- the token printed by kedo on startup (also stored at `~/.config/kedo/browser_token`)

## Roadmap

| Milestone | Plugin scope |
|---|---|
| M1 (current) | Send page to kedo inbox |
| M2 | Agent read-only: list_tabs / query / extract / screenshot / navigate |
| M3 | Agent write: click / type with Tier-2 confirmation |
| M4 | Isolated profile mode (kedo launches its own Chrome instance with this extension) |

## Boundaries (will not implement)

- Reading password fields or autofill credit-card inputs
- Executing arbitrary JavaScript on pages on behalf of the LLM
- Bypassing CAPTCHAs or anti-bot measures
- Cross-origin iframe traversal

See `PROTOCOL.md` §6 for the full hard-rules list.

## License

MIT (placeholder — pick before first publish).
