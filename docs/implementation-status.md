# Gnito — Implementation Status

Honest report of what is complete vs. partial vs. not implemented.
Run `npm run typecheck && npm run test && npm run build` to reproduce the
checks yourself.

## ✅ Implemented and verified

| Feature | How verified |
|---|---|
| Local backend (Express, loopback) | Boots, serves dist/client + /api from one origin; `npm start` works after `npm run build` |
| SQLite persistence + migrations | `better-sqlite3`, WAL, versioned `_migrations` table |
| Session + CSRF + rate-limit | Unit tests; live curl tests (401 without session, 403 with bad Host, CSRF header enforced) |
| Host/Origin allowlist (loopback only) | Live curl: `Host: evil.com` → 403; no-Origin curl → allowed |
| Secrets vault (encrypted at rest) | Integration test: set/get/delete round-trip |
| Provider CRUD + connection test | Live curl round-trip (create, list, patch, delete, test endpoint); `baseUrl`/`base_url` mapping fixed |
| Streaming chat with cancel | `streamChat` returns `AbortController` synchronously; authoritative final text accumulated in the stream loop, not a React ref |
| Chats / messages / search | Live curl round-trip |
| Projects + per-project instructions | Live curl round-trip |
| Memory (opt-in) | Off by default; Incognito writes rejected via `X-Gnito-Incognito` header check in the route |
| Incognito Mode | In-memory map only; never touches `chats`/`messages` tables; temp files deleted on exit |
| File grants (least-privilege) | Live curl: `..` traversal rejected, existing-symlink escape rejected; write/delete requires the grant's specific `files:write`/`files:delete` permission |
| Tool registry + permission gates | Live curl: `files_write` create → approve → execute round-trip; approval binds to the exact stored input (request-body args ignored) |
| Terminal allowlist | Live curl: `ls` not in allowlist → rejected without spawning a process; `spawn` uses `shell:false` + args array |
| Automation Center | Live curl: create, activate, pause, run-now, duplicate, delete; occurrence-key UNIQUE index prevents duplicate runs; **verified the missing-placeholder SQL bug is fixed** (12 columns, 12 placeholders) |
| Scheduler (backend) | `node-cron` for recurring, `setTimeout` for one-shot; missed-run policies applied on boot; no fabricated `next_run_at` for recurring |
| Plugin manifests | zod-validated; install/enable/disable/uninstall lifecycle |
| Encrypted backup + restore | Unit tests: wrong password rejected, tampered ciphertext rejected, truncated archive rejected. Restore is transactional, remaps project IDs for chats, and does not overwrite without opt-in |
| Design system (dark + light) | Tokens in `tokens.css`, both themes; live browser screenshots (desktop + mobile) |
| Logo / wordmark / favicon | Original SVG marks under `public/brand/` |
| Command palette (Ctrl/Cmd+K) | Rendered; keyboard navigable; aria labels |
| Tests | 21 passing (`vitest run`) |
| Production build | `npm run build` bundles client (Vite) + server (esbuild); verified `npm start` boots and serves |

## ⚠️ Partial / with disclosed limitations

| Feature | Limitation |
|---|---|
| Agent loop (multi-step tool calling) | Tool registry + approval flow are real; there is no automatic multi-step reasoning loop. Automations call the provider once with `taskInstruction` (no tool-chaining). |
| Incognito model streaming | Incognito stores messages in memory but does not call a provider in this build (the UI shows a clear disclosure, not a fake response). |
| Plugin code execution | Plugins install + register manifests, but nothing currently loads/invokes their `index.js`. There is no global `gnito` SDK object yet. |
| Backup of user files | Not included in v1 backups; re-grant folders after restore. |
| Web search backend | DuckDuckGo HTML as default; self-hosted SearXNG recommended for production. |
| Terminal sandboxing | Host execution only, gated by allowlist. No container isolation in this iteration. |
| Enter-to-send setting | Saves to settings but is not yet read by the composer (composer always uses Enter-to-send). |
| Audio / voice | Settings toggle exists; no real microphone / TTS pipeline. |
| MCP connector | Manifest field defined; no MCP client. |
| Git / GitHub connectors | Permission slugs defined; no connector. |
| Browser E2E tests | None written (manual Playwright visual QA performed on desktop + mobile). |

## Not implemented (planned)

- Full agent loop with tool-calling (multi-turn reasoning).
- MCP client adapter.
- Git/GitHub tool adapters.
- Audio: mic input, STT, TTS, playback.
- Plugin process isolation (worker_threads + permission broker).
- Plugin tool loading (invoking plugin `index.js` exports).
- User-file backup inclusion.
- Automated browser tests (Playwright test suite).

## How to verify

```bash
npm run typecheck   # tsc for both client and server
 npm run test        # vitest (21 tests)
npm run build       # Vite + esbuild
npm start           # production server on 127.0.0.1:8377
```
