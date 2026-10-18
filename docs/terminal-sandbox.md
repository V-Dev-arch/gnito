# Gnito terminal sandbox

Gnito’s terminal runner uses Docker only. If the Docker CLI, daemon, or prepared image is unavailable—or Gnito itself is running as root—the Terminal page reports that state and refuses execution; it never falls back to a process on the host. Commands run in a fresh container with a persistent Gnito-only workspace mounted at `/workspace`.

## Setup

Install and start Docker Engine, then build the prepared image from the repository root:

```sh
docker build --pull -t gnito-sandbox:3.24.2 -f docker/terminal/Dockerfile .
```

The workspace is stored under `GNITO_DATA_DIR/sandbox-workspace` (by default, `~/.gnito/sandbox-workspace`). To execute a command, open **Terminal**, inspect the command text, and select **Run**. Each run is recorded in the tool-run history. The `terminal_run` tool API also requires approval before a stored command can execute; the chat does not yet autonomously call that tool.

## Isolation and limits

The runtime uses the pinned official Alpine base image `alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6`, builds a local image containing Bash, Node.js/npm, Python, Git and common utilities, and runs as the Gnito OS user (root-launched Gnito is refused). The container has no network, a read-only root filesystem, no Linux capabilities, `no-new-privileges`, a private PID namespace with a process cap, CPU/memory/file-size limits, and a bounded temporary filesystem. Only the dedicated sandbox workspace is mounted read/write. Gnito monitors that persistent directory with a 256 MiB application-level size cap and stops a run if the cap or the 128 MiB host free-space reserve is exceeded; this periodic monitor is a software guard, not an OS-enforced filesystem quota, so brief write overshoot is possible. The Docker socket, Gnito data directory, API keys, and other host paths are not mounted into the container. Server environment variables are not passed into the container.

This is container isolation, not a separate virtual machine. The local Docker daemon and host kernel remain part of the security boundary; keep Docker and the host patched. The default no-network policy also means terminal commands cannot download packages. Web search runs separately in Gnito’s server and is not granted to the command container.

## Image maintenance

The Dockerfile pins the base to Alpine 3.24.2 and its multi-architecture manifest digest. Alpine’s release table lists 3.24.2 and its maintenance window; update the version and digest deliberately, then rebuild the local image when updating this base.

## Sources

- [Docker Official Image: Alpine](https://hub.docker.com/_/alpine)
- [Alpine release branches](https://alpinelinux.org/releases/)
- [Docker `container run` reference](https://docs.docker.com/reference/cli/docker/container/run/)
- [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)
