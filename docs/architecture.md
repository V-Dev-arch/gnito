# Gnito — Architecture

## Overview

Gnito is a local-first AI workspace with three layers:

1. **Frontend** (React + Vite, TypeScript): the workspace UI.
2. **Local service** (Node.js + Express, TypeScript): the API boundary,
   scheduler, tool runtime, and secrets vault.
3. **Storage** (SQLite via `better-sqlite3`): single-file DB under
   `~/.gnito/gnito.db` plus an encrypted secrets vault.

The frontend never talks to model providers directly — all provider
traffic flows through the local service (so API keys never reach the
browser).

## Repository layout

```
src/
  client/                   # React app (Vite)
    App.tsx                 # router + theme + palette
    ui/                     # AppShell, CommandPalette, NotFound
    features/               # chat, incognito, files, automations, plugins, projects, settings
    lib/                    # api client, toast provider
    styles/                 # tokens.css, base.css, app.css
  server/                   # Node service
    index.ts               # entry, loopback bind
    config.ts              # env + paths
    db/index.ts            # SQLite + migrations
    security/
      auth.ts              # session + CSRF + rate limit
      vault.ts             # encrypted secrets
      redact.ts            # secret redaction in logs
    api/                    # route modules
      app.ts               # express app, registers all modules
      chat.ts, providers.ts, memory.ts, projects.ts,
      files.ts, tools.ts, automations.ts, plugins.ts,
      incognito.ts, settings.ts, backup.ts
  shared/types.ts           # zod schemas shared client + server
tests/
  unit/                    # security, redaction
  integration/             # isolation, backup crypto
plugins/example/           # sample plugin
docs/
public/brand/              # logo, wordmark, favicon (SVG)
```

## Request flow

```
Browser → Vite dev proxy → Express :8377
                             │
                             ├─ /api/session (unauthenticated, issues token)
                             ├─ /api/* (requires X-Gnito-Session)
                             │    ├─ zod validation
                             │    ├─ session + CSRF check
                             │    └─ handler → SQLite / vault / fetch(provider)
                             └─ static (dist/client in production)
```

## Incognito Mode

Incognito chats are held in an in-memory map (`SESSIONS`) on the
server. They never touch the `chats` / `messages` tables, and the
memory API rejects writes when `X-Gnito-Incognito: 1` is present.

## Scheduler

`node-cron` schedules recurring automations; `setTimeout` schedules
one-shots. On boot, `startScheduler()` re-arms active automations and
applies missed-run policies (`skip`, `run-once-on-startup`, or
`catch-up-within-window` up to 3 missed runs). Duplicate runs are
prevented by a unique `(automation_id, occurrence_key)` index on
`automation_runs`.

## Tools

Each tool in `TOOL_REGISTRY` declares a zod input schema, required
permissions, whether it requires user confirmation, and an async
`execute(input, signal)`. High-risk tools (`files_write`, `files_delete`,
`terminal_run`) cannot execute without a user-issued approval: a request is
stored as `pending-approval`, the user approves the exact saved input, and
only then does `execute` run. The Terminal page uses this flow. The chat does
not yet implement automatic model-directed tool calling; Web search is an
explicit user-enabled pre-search step.

## Provider adapters

`providers.ts` implements two request shapes:

- `openai-compatible` — `POST {base}/chat/completions`, `Authorization: Bearer <key>`.
- `anthropic-compatible` — `POST {base}/v1/messages`, `x-api-key` header.

Both stream SSE; the server parses `data:` lines and re-emits
`event: chunk|error|end` to the client.
