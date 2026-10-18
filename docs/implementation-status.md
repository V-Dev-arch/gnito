# Gnito — Implementation Status

Honest report of what is complete vs. partial vs. not implemented. Reproduce validation with `npm run typecheck && npm run lint && npm test && npm run build`.

## Implemented and verified

| Feature | How verified |
|---|---|
| Local backend (Express, loopback) | Boots, serves `dist/client` and `/api` from one origin; `npm start` works after `npm run build` |
| SQLite persistence + migrations | `better-sqlite3`, WAL, versioned `_migrations` table |
| Session + CSRF + rate limit | Unit tests; live curl checks for session, CSRF header, and trusted-host enforcement |
| Secrets vault | Integration test: set/get/delete round-trip; provider keys are stored server-side |
| Provider setup + model discovery | Mock OpenAI-compatible provider round-trip; keyless custom endpoints are supported; preset-provider chat requires a saved key; arbitrary upstream bodies and custom headers are not returned to the client |
| Streaming chat + cancellation | Live mock-provider stream; final response is accumulated in the stream loop and normal completion does not abort the request |
| Chats / messages / search | Local persistence and reload verified with a mock provider |
| Incognito Mode | Provider streaming into an owner-bound in-memory session; no `chats`/`messages` writes; 30-minute idle and 12-hour maximum expiry; per-session and total session bounds; temporary files deleted on exit/expiry |
| Projects + per-project instructions | Existing API routes and local database support |
| Memory (opt-in) | Off by default; normal memory APIs are separate from Incognito sessions |
| File grants (least-privilege) | Existing path checks reject traversal and symlink escapes; write/delete require matching grant permissions |
| Tool registry + permission gates | Approval is bound to the exact stored input; execution uses an atomic status claim to prevent duplicate runs; tool-run history and first-turn search context linking are covered by tests |
| Terminal sandbox path | Docker-only image and restricted runner, explicit Terminal page, command history and stop action; non-root server requirement, per-file limit, monitored 256 MiB workspace cap and 128 MiB free-space reserve; tests verify isolation flags and no host fallback. A real container run still requires Docker and the prepared image on the host. |
| Explicit web search | Opt-in composer toggle, Brave Search fallback with live-verified titles, source links and snippets, custom public HTTPS SearXNG option, bounded response sizes, public-only DNS validation/pinning, redirects blocked, saved source cards and untrusted context sent to the selected model; parser, SSRF and audit-context tests pass. A real provider response using search context was not tested. |
| Outbound URL safety | The shared fetch layer rejects private, loopback, link-local, unspecified, mapped and special-use IP ranges across DNS answers, pins validated addresses for the request, and bounds response size. `read_url` and web search use it. |
| Automation Center + scheduler | Existing APIs and scheduler support scheduled and one-shot jobs; see limitations below for model tool chaining |
| Plugin manifests | zod-validated install/enable/disable/uninstall lifecycle |
| Encrypted backup + restore | Existing tests cover wrong password, tampering and truncation; restore is transactional |
| Design system + brand | Dark/light tokens, updated SVG mark/wordmark/favicon; desktop browser smoke test and phone-width layout screenshot |
| Tests + build | TypeScript, strict lint, 37 tests, production client/server build; provider stream and saved-chat reload smoke-tested locally; default Brave web search smoke-tested live |

## Partial / not implemented

| Feature | Limitation |
|---|---|
| Agent loop (multi-step tool calling) | Chat does not yet let the model autonomously request tools. Web search is user-invoked with a composer toggle; the Terminal page is user-operated. Generic tool approvals are not an AI orchestration loop. |
| MCP connectors | No MCP client/runtime is implemented. |
| Terminal container QA | Docker is not installed in the current development sandbox, so an actual container execution could not be smoke-tested here. Gnito reports this as unavailable and never runs the command on the host. The workspace byte cap is a periodic host-side software monitor, not a kernel-enforced filesystem quota; brief write overshoot is possible. |
| Memory extraction | Memory storage is opt-in, but the assistant does not automatically extract and save memories from chats. |
| AI task suggestions and pause/resume | Suggestions are not generated contextually by the model; Stop exists, but there is no pause/resume generation flow. |
| Manus provider | Not enabled: this adapter supports synchronous Chat Completions and Anthropic Messages, not Manus’s distinct asynchronous Responses/Tasks API. |
| Plugin code execution | Plugins install/register manifests but their `index.js` is not loaded or invoked. |
| Backup of user files | User files are not included in v1 backups; folders must be re-granted after restore. |
| Enter-to-send setting | Setting is saved but the composer does not currently read it. |
| Audio / voice | Settings toggle exists; microphone and TTS pipelines do not. |
| Git / GitHub connectors | Permission slugs are defined, but no connector implementation is included. |
| Browser E2E tests | No automated browser E2E suite yet; manual browser smoke test on desktop and a phone-width screenshot only. |
