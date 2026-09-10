# Canvas MCP authorization status

The Canvas MCP server connection list represents a user's stored OAuth consents. A consent alone does not establish that a client is connected or can still use the server.

The list separately reports current authorization usability, session and refresh expiry, and the last authenticated successful `tools/list` or `tools/call`. Anonymous discovery, rejected authorization and failed tool results do not advance the last-success timestamp. This timestamp records an observed success; it is not a heartbeat or a promise that the next request will succeed.

Usability combines current client/resource policy, consent, account and seat access, selected accessible workspaces, session lifetime, and observed access-token or refresh-grant evidence. Unknown evidence is not shown as active. Runtime token verification and workspace authorization remain authoritative for every request.

Usage evidence is stored privately under `users/<userId>/mcp/server-usage/`, keyed by the resource and client. Each versioned file holds a last-success timestamp and at most ten observed grants. It contains a SHA-256 token hash and session/lifetime metadata, never the token, request arguments, tool output or session cookies. Files use mode 0600, directories 0700, and writes are atomic and serialized. Usage evidence is historical: current consent and revocation checks prevent old records from restoring disconnected access.

Disconnect is scoped to the signed-in user and the selected client. Its transaction revokes that user's grants and removes their consent and workspace selections. Another user's authorization for the same OAuth client remains independent. To reconnect, the user starts authorization in their MCP client; opening Settings or an old chat does not start it automatically.
