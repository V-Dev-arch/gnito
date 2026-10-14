# Gnito — Security & Threat Model

## What Gnito protects against

| Threat | Mitigation |
|---|---|
| Rogue webpage POSTs to your local Gnito | Session-token header (not a cookie) + Origin/Referer check |
| Cross-site request forgery (CSRF) | Custom `X-Gnito-Session` header + `Origin` validation |
| DNS rebinding | Origin must match host; loopback-only bind by default |
| Path traversal (`../`) | Input normalization + lexical + realpath containment check against approved roots |
| Symlink escape | `realpathSync` on both root and candidate before allow-listing |
| Secrets leaking into logs | Pattern-based redaction (`sk-`, `ghp_`, `Bearer …`, `key=value`) |
| Unauthenticated API access | All `/api/*` routes require a session token (except `/api/session`) |
| Wrong/corrupt backup archive | AES-256-GCM auth-tag check fails with 400 `wrong-password` |
| Local-network exposure | Binds `127.0.0.1` by default |

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
- `terminal:run` — additionally gated behind an allowlist of allowed
  first tokens (Settings → Tools). Commands not in the allowlist are
  rejected without ever spawning a process.

## Terminal + sandbox

Gnito's `terminal_run` tool runs on the **host**, not in a sandbox.
We do not mislabel it as sandboxed. The allowlist is the mitigation.
For true sandboxing, run Gnito inside a container/VM and treat the
whole environment as the trust boundary.

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
