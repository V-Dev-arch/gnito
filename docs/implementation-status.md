# Gnito — Implementation Status

This document separates implemented behavior from runtime-dependent or unfinished behavior. Reproduce repository validation with `npm run typecheck && npm run lint && npm test && npm run build`.

## Implemented and verified

| Feature | Current evidence |
|---|---|
| Local backend and persistence | Express serves the built client and API from one origin; SQLite uses WAL and versioned migrations. |
| Session security and secrets | CSRF/session/rate-limit and encrypted provider-vault paths have unit and integration coverage. Provider secrets and arbitrary upstream response bodies are not returned to the client. |
| Provider setup and model discovery | Presets cover OpenAI, Anthropic, Google Gemini, Groq, SpaceXAI (Grok), Manus, Moonshot (Kimi), and Z.ai, plus a custom OpenAI-compatible endpoint. The UI discovers models or offers a manual ID when discovery fails. |
| Provider branding | Each preset renders a bundled local SVG. Monochrome marks use a contrast-safe dark-mode treatment; multicolor marks retain their brand colors. SpaceXAI and Z.ai marks are documented in `docs/provider-presets.md`. |
| Chats and streaming | Chat transcripts persist in SQLite, reload by chat, and record provider/model metadata. Provider errors are surfaced as safe, actionable HTTP/status messages. Stop cancels active streaming and saves any partial assistant text. |
| Manus Tasks API | The separate asynchronous Manus adapter creates private remote tasks, reports actual task status, polls messages, attempts remote stop on cancellation, and includes the validated task URL in the assistant text saved to chat. Its integration test verifies the final link and task lifecycle. Manus does not access Gnito’s local terminal or MCP connectors. |
| Incognito | Provider streaming uses an owner-bound in-memory session with expiry and bounded session/transcript sizes; it does not write chat or memory records. |
| Opt-in local memory | Memory entries are stored locally and included in relevant provider context when enabled. Memory remains off by default. |
| Autonomous local terminal tool loop | OpenAI-compatible and Anthropic tool-call paths can request `terminal_run` only when the user enables terminal access for that message. Commands, network choice, status, output, and errors are recorded and streamed to the chat. The loop is capped at eight commands and ten model rounds. Mock-provider integration tests cover the permissioned path. |
| Docker terminal sandbox | Execution is Docker-only, non-root, read-only except for the persistent workspace, and has resource and workspace limits. Network is off by default; explicit opt-in selects Docker bridge networking. The Alpine image includes Git, GitHub CLI, curl, Python, Node.js, and common utilities. No host-shell fallback exists. |
| Web search and URL reading | Web search is opt-in, stores source cards, and supplies bounded untrusted search context to the selected model. The default Brave backend tries DuckDuckGo once if it fails or returns a challenge; explicitly configured public HTTPS endpoints are used on their own, with upstream HTTP 429 and Retry-After surfaced safely. Shared outbound fetching pins validated public DNS answers, blocks redirects and private/reserved destinations, and caps responses. |
| Automation Center | The local Node scheduler supports draft/activate/pause/duplicate/delete, recurring cron and one-shot schedules, manual run-now, run history, and missed-run policies. An automation currently executes one provider response and does not call the terminal/search tools autonomously. The local server must be running for scheduled execution. |
| User interface | The workspace uses a responsive light/dark design, saved-chat navigation, provider/model selection, per-message tool controls, and a separate terminal view with status and run history. |
| Build and tests | `npm run typecheck`, `npm run lint`, `npm test` (44 tests), `npm run build`, and `git diff --check` pass in the current branch. |

## Known limitations

| Feature | Limitation |
|---|---|
| Actual Docker execution | The current validation sandbox has no Docker CLI, so a real container command and network-on command could not be run here. The sandbox reports Docker unavailable and refuses host-shell fallback. The provided preview redirected to GitHub sign-in, and no Codespace was available through this environment. |
| MCP connectors | There is no MCP client/runtime in this branch; external MCP connectors cannot yet be used by the agent. |
| Automation tools | Scheduled automations do not use the autonomous chat tool loop, terminal, or web-search tools. Recurring-run preview times are explicitly approximate. |
| Memory extraction | Users can manage local memory, but the assistant does not automatically extract and save memories from chats. |
| Contextual follow-up suggestions | The assistant does not yet generate topic-specific follow-up suggestions after completing a task. |
| Pause/resume generation | Stop is available; generation cannot be paused and resumed. |
| Terminal quota enforcement | The workspace is byte-scanned and commands are stopped on limit; this is a host-side software monitor, not a kernel-enforced filesystem quota, so brief write overshoot is possible. |
| Plugins | Plugin manifests can be installed and managed, but plugin `index.js` files are not executed. |
| User-file backup | Files are not included in v1 backups; folder access must be re-granted after restore. |
| Audio/voice | Settings exist, but microphone and TTS pipelines are not implemented. |
| Browser E2E | No automated browser E2E suite is present. The current branch was validated with typecheck, lint, tests, and production builds; the live preview could not be inspected without GitHub authentication. |
