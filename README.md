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
- **Image generation**: explicitly enable Image tools to let the AI create polished
  raster images through the configured compatible provider. Reference-image
  attachments, style, quality, aspect-ratio, and negative-prompt controls are
  supported; generated media is stored locally and shown inline with a download
  button. A local SVG fallback is available when raster generation is unavailable.
- **Projects**: organize chats + per-project instructions.
- **Files**: browse and edit files in folders you explicitly approve
  (least-privilege grants, path-traversal defenses).
- **Web search**: opt-in per chat turn; source links are saved with the chat and
  passed to the selected model as untrusted evidence. Configure a public HTTPS
  SearXNG JSON endpoint in Tools & Search, or use the built-in public fallbacks.
- **Terminal**: one-shot commands in a Docker-only isolated workspace, with
  visible command/output history, safe image/video previews and downloads, and no host-shell fallback.
- **Files**: read/write/delete tools respect approved folder permissions and
  record runs in the local audit history.
- **AI tool chaining**: terminal execution is explicitly enabled per message;
  image tools are separately opt-in. A dedicated network opt-in enables Docker
  bridge access, and the sandbox includes `ffmpeg` for video creation.
- **GitHub plugin**: connect a GitHub personal access token (PAT), stored in the
  encrypted local vault. The AI can use GitHub REST API read/write operations,
  while GitHub enforces the scopes and fine-grained permissions granted to the PAT.
- **Memory**: opt-in local memory that both the user and AI can read and write.
  Ask the AI to remember a durable preference or fact, review and delete entries
  in Settings, and use Incognito Mode when memory persistence is not wanted.
- **Automation Center**: schedule natural-language tasks via the local backend
  scheduler (cron), bind each automation to a specific provider and model, and
  configure missed-run policy, dry-run mode, terminal, network, and tool access.
  Scheduled conversations show their run duration and completion time.
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

### Memory

Enable **Memory** under **Settings → Memory & Privacy** before asking Gnito to
remember something. For example:

> Remember that I prefer concise answers and use metric units.

The AI may save durable preferences, goals, and useful facts through its memory
tools. It must not save passwords, API keys, or other highly sensitive data.
Memory entries can be read, added, and deleted manually from the same settings
panel. Memory tools are automatically available to normal chats while Memory is
enabled; Incognito chats never persist or access local memory.

### GitHub plugin

Open **Plugins → GitHub**, enter a PAT created with only the scopes and repository
permissions required for your work, and connect it. The PAT is encrypted locally
and is never sent to the model. The AI uses the plugin’s GitHub REST API tool, and
GitHub rejects operations outside the token’s permissions. Review write or
destructive actions before asking the AI to perform them.

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
| `~/.gnito/gnito.db` | SQLite database (chats, projects, memory, automations, settings, and tool runs) |
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
- GitHub PATs are encrypted in the local vault and never exposed to the model;
  GitHub scopes and fine-grained repository permissions remain authoritative.
- Memory is opt-in, locally stored, user-editable, and excluded from Incognito
  sessions. The AI is instructed not to store credentials or highly sensitive data.
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
