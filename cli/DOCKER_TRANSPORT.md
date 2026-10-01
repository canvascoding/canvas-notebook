# Docker transport

The host CLI uses the Docker Engine HTTP API for local container and image inspection, daemon reachability, application version, admin updates, backups and managed PostgreSQL exec commands. Image status reads one container snapshot and one image snapshot instead of six separate inspect processes. The transport uses Node's built-in HTTP client; portable Linux bundles need no additional dependency.

Compose remains responsible for project-specific container selection, pulling images, starting services and recreating containers. Its configuration, profiles and project naming remain authoritative. Other Docker operations retain the CLI with bounded process execution; an explicitly followed log stream stays open until canceled.

## Endpoint selection

`DOCKER_CONTEXT` takes precedence over `DOCKER_HOST`. Without an explicit host, a bounded `docker context inspect` discovers the selected endpoint once per CLI invocation or management request. Failed initial negotiation can be tried again without retrying a container command. Local `unix://` endpoints support Docker Engine, rootless Docker and OrbStack. The client negotiates API versions 1.40 through 1.56 and honors a compatible `DOCKER_API_VERSION`.

SSH, TCP/TLS, Windows named pipes, custom Docker executables and unsupported API versions use the existing CLI transport. The API never guesses a default socket or switches to another daemon after a connection error. Set `CANVAS_DOCKER_ENGINE_API=off` to select the CLI explicitly.

## Execution contract

Exec creates an instance, starts an attached non-TTY stream, separates Docker stdout/stderr frames, and inspects the instance for its real exit code. stdin is sent through the upgraded connection and closed after the supplied input. Passwords and SQL secrets remain on stdin.

Metadata responses and captured output are bounded. Structured output rejects truncation; diagnostic output may keep a bounded tail. Partial frames, malformed headers, early disconnects, cancellation and deadlines fail the operation. An interrupted API exec includes its exec ID, container ID and the last observable running/exit state. It never reruns the command via the CLI.

Docker has no exec cancellation endpoint. Closing an attachment or timing out the Docker CLI can leave the remote process running. A timeout therefore reports this explicitly rather than claiming remote cancellation or success. CLI fallback cannot provide an exec ID and reports unknown remote state when interrupted.

Managed PostgreSQL preparation and backup execution share their caller's time budget. Required update backups use the remaining forward-update budget, preserving the rollback reserve. Process runners forward termination, clean up captured child process groups, handle stdin failures and enforce output limits. Updater events remain the existing bounded NDJSON protocol with sequential journal delivery and the apply acknowledgement.

## Verification

- `npm run test:cli:docker-engine`: isolated Unix socket daemon fixtures covering context precedence, negotiation, frames, stdin, exit codes, bounded responses, cancellation and no duplicate execution.
- `npm run test:cli:process-lifecycle`: real subprocess and updater protocol regressions.
- `npm run test:cli:docker-engine:local`: the running `canvas-local-team-seat-dev` stack; verifies the API against OrbStack, including PostgreSQL/pgvector and a self-terminating timeout probe.
- Control Plane `scripts/notebook-management-local-canary.mjs`: actual management API environment/account updates, normal login and a full backup exceeding the historical 2 MiB manifest threshold.

Reference: [Docker Engine API](https://docs.docker.com/reference/api/engine/) and [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/).
