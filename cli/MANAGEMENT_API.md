# Local Notebook management API

The host CLI exposes HTTP over `/run/canvas-notebook-management/api.sock`. The socket is mode `0600`, inside a systemd runtime directory with mode `0700`. Only host root processes can connect. The socket is not mounted into the Notebook container and has no TCP listener. `CANVAS_NOTEBOOK_MANAGEMENT_SOCKET` selects a different socket for isolated tests.

The service is installed by the regular installer and the signed Linux CLI package installer. Updating the CLI restarts the management service. Rolling back to a CLI without API support stops and disables the service. The standalone updater retains its existing managed-mode restrictions.

Every response has `protocolVersion: 1` and `ok`. Success contains `result`; failures contain `error: { code, message }`. Internal failures use a generic message. Responses and request bodies are bounded; passwords are supplied in the request body and then to the container on stdin.

| Request | Result |
| --- | --- |
| `GET /v1/capabilities` | Supported methods and the served config path |
| `GET /v1/config` | Redacted config, secret fingerprints, served config path and revision |
| `PATCH /v1/config/environment` | Atomic environment changes and removals; new revision and changed keys |
| `POST /v1/admin/reset-password` | Confirmed account email and name |

Environment patches accept `{ "set": { "KEY": "value" }, "remove": ["OLD_KEY"] }`. Send the revision from `GET /v1/config` as the `If-Match` header. Missing revisions return `428`; stale revisions and a busy host return `409`. All values are validated before a single secure file replacement. The same host operation lock used by CLI mutations prevents concurrent writes. Unknown config fields are preserved.

Patches only update desired configuration. Environment rendering, application recreation and PostgreSQL credential reconciliation continue through the existing CLI and recovery journal. The Control Plane agent retains its identity checks and reconciliation sequence.

The agent uses the API for batched environment writes/removals and account changes. An absent or refused socket during initial discovery permits the legacy CLI path. Protocol errors, permissions, config-path mismatch, revision conflicts and errors after a mutation request do not trigger fallback or automatic retries. A lost account response can leave the result unknown; the caller must reconcile before retrying. Requests disconnected while still waiting for the host lock are discarded.

Updates retain their existing validated NDJSON events and durable Control Plane operations. Swap retains its existing JSON contract. Backups retain JSON with a compact job summary: per-file manifest entries remain in the ZIP and latest metadata file, while counts, database type, consistency and upload checksums remain in the command result.

Run `npm run test:cli:management-api`, `npm run test:backup:cli-result` and the Control Plane's `npm run test:notebook-management-api` for contract tests. Verify the Linux package/service and the managed local stack before rollout.
