# Gnito — Security & Threat Model

## What Gnito protects against

| Threat | Mitigation |
|---|---|
| Rogue webpage POSTs to your local Gnito | Session-token header (not a cookie) + Origin/Referer check |
| Cross-site request forgery (CSRF) | Custom `X-Gnito-Session` header + `Origin` validation |
| DNS rebinding | Origin must match host; loopback-only bind by default; network deployments require explicit trusted origins |
| Path traversal (`../`) | Input normalization + lexical + realpath containment check against approved roots |
| Symlink escape | `realpathSync` on both root and candidate before allow-listing |
| Secrets leaking into logs | Pattern-based redaction (`sk-`, `ghp_`, `Bearer …`, `key=value`) |
| Unauthenticated API access | All `/api/*` routes require a session token (except `/api/session`) |
| Wrong/corrupt backup archive | AES-256-GCM auth-tag check fails with 400 `wrong-password` |
| Local-network exposure | Binds `127.0.0.1` by default |
| SSRF via search or URL reading | Rejects private, loopback, link-local, unspecified, mapped and special-use IP ranges; validates every DNS answer and pins it for the outbound connection; response sizes are capped and redirects are not followed |

## Deliberate network deployments

Keep the defaults for local use. To deliberately serve Gnito on a network,
set `GNITO_HOST` to the interface you intend to bind and set
`GNITO_TRUSTED_ORIGINS` to the exact browser origin(s), including scheme and
non-default port when applicable, for example:

```bash
GNITO_HOST=127.0.0.1 GNITO_TRUSTED_ORIGINS=https://gnito.example.com npm start
```

When using a reverse proxy, keep Gnito bound to loopback and terminate TLS at
the proxy. Do not use wildcard origins or expose Gnito directly to an
untrusted network. The origin allowlist is a CSRF/DNS-rebinding boundary, **not
user authentication**; anyone who can reach an allowed origin may access the
same Gnito instance. Add appropriate network access controls before sharing it.

## What Gnito does NOT protect against

- **Filesystem-compromise attacker.** The secrets vault master key is
  stored alongside the vault (mode 0600). Anyone with your filesystem
  can decrypt provider API keys. Set `GNITO_MASTER_KEY` from an OS
  keychain agent for a stronger model.
- **Compromised OS / supply-chain attacks.** Gnito trusts its own
  process and dependencies.
- **External provider policies.** Sending a prompt to OpenAI or
  Anthropic sends it to them. Gnito cannot control what they retain.
- **Incognito ≠ anonymity.** Incognito prevents *local* persistence
  only. External providers may still process and retain what you send.

## Tool permissions

Every tool declares required permissions. High-risk tools require an
explicit user approval step before execution:

- `files:write`, `files:delete` — user must approve the specific run.
- `terminal:run` — user approval is bound to the exact command. It runs only
  in the Docker sandbox described below; a missing Docker runtime is a hard
  failure, never a reason to execute on the host.
- Web search only runs after the user enables the composer’s Web search toggle
  for that turn. With the default backend, the query is sent to Brave Search and
  may be sent once to DuckDuckGo Lite if Brave fails or returns a challenge. A
  configured public HTTPS endpoint is used on its own. Private/local DNS
  answers and redirects are blocked; fetched snippets are treated as untrusted
  data by the model. `read_url` applies the same outbound-address policy.

## Terminal + sandbox

Gnito’s `terminal_run` tool uses a Docker container with a pinned Alpine base,
no network, a read-only root filesystem, dropped capabilities,
`no-new-privileges`, resource limits, and a single read/write mount for the
dedicated `sandbox-workspace` directory. The server refuses to run Terminal
when Gnito itself is running as root. A host-side watchdog caps the persistent
workspace at 256 MiB and preserves 128 MiB of free disk space; this is a
periodic software monitor rather than a kernel-enforced filesystem quota, so
brief write overshoot is possible. The container receives a minimal
environment; it does not receive provider keys, the Docker socket, the Gnito
data directory, or other host paths. The host shell is never used as fallback.
Commands can still modify or delete anything inside the mounted workspace, so
review the exact command before approving it.

Docker is a privileged host service and containers share the host kernel. This
reduces risk but is not equivalent to a separate virtual machine; maintain the
host kernel and Docker Engine, and do not expose the Docker daemon to untrusted
networks. The container’s network is disabled by default, which intentionally
prevents package downloads from within a run. See
[`docs/terminal-sandbox.md`](terminal-sandbox.md) for setup and the full
runtime configuration.

## Vault details

- Cipher: `AES-256-GCM` (Node `crypto`).
- Master key: random 32 bytes on first run, stored at
  `~/.gnito/.gnito-master-key` (mode `0600`), or from
  `GNITO_MASTER_KEY` env.
- Each provider key is stored as a single vault entry; the whole vault
  file is rewritten atomically on each change.

## Reporting a security issue

Open a private GitHub security advisory on the repo, or email the
maintainer listed in `SECURITY.md` (if present). Do not open a public
issue for vulnerabilities.
