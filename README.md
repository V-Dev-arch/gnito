# Gnito

**Your AI. Your Machine. Your Rules.**

Gnito is an open-source, local-first, self-hosted AI workspace. It runs on
your computer, stores your data on your machine, and connects to any
OpenAI- or Anthropic-compatible model provider you choose (BYOK — bring
your own key).

> [!IMPORTANT]
> Gnito is not free to run against external providers: usage costs,
> quotas, rate limits, and data policies depend entirely on the provider
> you configure. Image generation can incur additional provider charges.
> Gnito does not bundle a model.

## Features

- **Local-first**: SQLite database and file storage under `~/.gnito/`.
  Nothing leaves your machine unless you configure a provider.
- **BYOK providers**: connect OpenAI, Anthropic, Ollama, LM Studio, vLLM,
  or any OpenAI/Anthropic-compatible endpoint. Keys are encrypted at rest.
- **Streaming chat**: real-time SSE streaming with cancel, retry, and edit.
- **Prompt attachments**: attach up to four local PNG/JPEG/WebP/GIF images or
  text/code files (up to 180 KiB each); files are sent for this message only,
  so reattach them for follow-ups. Image input requires a vision-capable model.
- **Image generation**: explicitly enable Image tools to let an OpenAI-compatible
  provider's Images API generate images; results appear inline with a download button.
- **Projects**: organize chats + per-project instructions.
- **Files**: browse and edit files in folders you explicitly approve
  (least-privilege grants, path-traversal defenses).
- **Web search**: opt-in per chat turn; source links are saved with the chat and
  passed to the selected model as untrusted evidence.
- **Terminal**: one-shot commands in a Docker-only isolated workspace, with
  visible command/output history, safe image/video previews and downloads, and no host-shell fallback.
- **Files**: read/write/delete tools respect approved folder permissions and
  record runs in the local audit history.
- **AI tool chaining**: terminal execution is explicitly enabled per message;
  image tools are separately opt-in. A dedicated network opt-in enables Docker
  bridge access, and the sandbox includes `ffmpeg` for video creation.
- **Automation Center**: schedule natural-language tasks via the local
  backend scheduler (cron). Missed-run policies and dry-run mode.
- **Incognito Mode**: temporary chats held in memory only. Never written
  to history, memory, or backups.
- **Encrypted backup**: AES-256-GCM + scrypt key derivation, password-protected.
- **Command palette** (Ctrl/Cmd+K) and accessible keyboard navigation.

## Install

Requires Node.js 20.19+. Docker Engine or Docker Desktop is optional for the
rest of Gnito, but required for Terminal. Build its prepared image from the
repository root with the command in [the terminal sandbox guide](docs/terminal-sandbox.md).

```bash
git clone <your-fork> gnito
cd gnito
npm install
npm run dev
```

Then open http://localhost:5173 (dev) or http://127.0.0.1:8377 (prod).

For video work, enable **Allow terminal** and **Network** in chat, then ask
Gnito to clone [OpenMontage](https://github.com/calesthio/OpenMontage), follow
its README, and save the result under `/workspace`. The model can return a
safe inline preview and a download link for images/videos created there. Network
access is a per-message opt-in; review the command and any external service or
provider cost before proceeding.

## Production

```bash
npm run build
npm start
```

The server binds to `127.0.0.1:8377` by default and serves the built
frontend + API from one origin.

## Data location

Everything Gnito saves lives under `~/.gnito/` (configurable via
`GNITO_DATA_DIR`):

| Path | What |
|---|---|
| `~/.gnito/gnito.db` | SQLite database (chats, projects, settings, tool runs) |
| `~/.gnito/secrets.enc` | Encrypted provider API keys (AES-256-GCM) |
| `~/.gnito/.gnito-master-key` | Vault master key (mode 0600) — see `docs/security.md` |
| `~/.gnito/backups/` | Encrypted backup archives |
| `~/.gnito/sandbox-workspace/` | Persistent files available to Docker terminal runs (1 GiB monitored cap) |
| `~/.gnito/generated-media/` | Locally stored provider-generated PNGs (1 GiB aggregate cap; remove files here to free space) |

## Security

- Binds to loopback (`127.0.0.1`) by default.
- Network deployments require an exact `GNITO_TRUSTED_ORIGINS` allowlist; this is not user authentication.
- Session-token + CSRF protection on all API routes.
- Path traversal and symlink escape blocked at every file route.
- Provider keys never logged or exposed to the client.
- Terminal runs only in a restricted Docker container; only the dedicated
  sandbox workspace is mounted, container networking is disabled unless enabled
  per message, and Gnito must run as a non-root OS user. The workspace has a
  1 GiB monitored cap with 512 MiB disk headroom. Docker and the host kernel remain part of the
  security boundary.
- See `docs/security.md` for the full threat model.

## Documentation

- `docs/architecture.md` — system design and module layout
- `docs/security.md` — threat model and security notes
- `docs/terminal-sandbox.md` — Docker setup, sandbox limits and image updates
- `docs/design-system.md` — tokens, themes, accessibility
- `docs/plugin-sdk.md` — writing your own plugin
- `docs/implementation-status.md` — what's complete vs. partial
- `CONTRIBUTING.md` — how to contribute

## License

MIT — see `LICENSE`.
