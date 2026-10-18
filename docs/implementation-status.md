# Gnito — Implementation Status

Honest report of what is complete vs. partial vs. not implemented. Run `npm run typecheck && npm run lint && npm test && npm run build` to reproduce the current validation checks.

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
| Tool registry + permission gates | Existing approval binds execution to exact stored input |
| Terminal allowlist | Existing command runner uses `shell:false` and an allowlist |
| Automation Center + scheduler | Existing APIs and scheduler support scheduled and one-shot jobs; see limitations below for model tool chaining |
| Plugin manifests | zod-validated install/enable/disable/uninstall lifecycle |
| Encrypted backup + restore | Existing tests cover wrong password, tampering and truncation; restore is transactional |
| Design system + brand | Dark/light tokens, updated SVG mark/wordmark/favicon; desktop browser smoke test and phone-width layout screenshot |
| Tests + build | TypeScript, strict lint, 24 tests, production client/server build; provider stream and saved-chat reload smoke-tested locally |

## Partial / not implemented

| Feature | Limitation |
|---|---|
| Agent loop (multi-step tool calling) | Tool registry + approval flow exist, but chat does not yet perform automatic multi-step tool calling. |
| Web search | A `web_search` tool implementation exists, but it is not yet orchestrated by chat as an AI tool; backend parsing/default-provider reliability needs more work. |
| MCP connectors | No MCP client/runtime is implemented. |
| Terminal isolation | The allowlisted runner executes on the host; it is not a virtual/container sandbox. Do not treat it as isolated. |
| Memory extraction | Memory storage is opt-in, but the assistant does not automatically extract and save memories from chats. |
| AI task suggestions and pause/resume | Suggestions are not generated contextually by the model; Stop exists, but there is no pause/resume generation flow. |
| Manus provider | Not enabled: this adapter supports synchronous Chat Completions and Anthropic Messages, not Manus’s distinct asynchronous Responses/Tasks API. |
| Plugin code execution | Plugins install/register manifests but their `index.js` is not loaded or invoked. |
| Backup of user files | User files are not included in v1 backups; folders must be re-granted after restore. |
| Enter-to-send setting | Setting is saved but the composer does not currently read it. |
| Audio / voice | Settings toggle exists; microphone and TTS pipelines do not. |
| Git / GitHub connectors | Permission slugs are defined, but no connector implementation is included. |
| Browser E2E tests | No automated browser E2E suite yet; manual browser smoke test on desktop and a phone-width screenshot only. |
