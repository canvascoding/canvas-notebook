# MCP connection health and notifications

Connection health is personal, persisted at `users/<userId>/mcp/connections/<connectionId>/health.json`, and bound to the connection's authentication revision and OAuth generation. This file contains allowlisted error codes and timestamps, never token values, provider response bodies, or exception messages. File permissions and atomic writes use the MCP storage layer.

Activation, authorization and reachability are independent. An idle client being closed is normal. Disabled connections have no open incident. Successful MCP requests record reachability and last success; OAuth refresh success updates authorization without incorrectly declaring an unavailable MCP endpoint healthy.

An expired token with no refresh path or a permanent authentication rejection opens one reconnect incident immediately. Missing permissions remain actionable even if the current token is otherwise valid. Transient provider/network failures require at least three separate check windows across five minutes before notifying. Concurrent failures within 30 seconds count once. Retry delay starts at 150 seconds and backs off to one hour. The same incident retains its ID and read state until recovery; no new inbox item is created for each failed call.

Settings status reads and notification reads reconcile local credentials without making provider requests. Direct-tool metadata and icons shown by status reads come from local caches. An explicit connection test can populate missing tool metadata.

The background monitor runs once per minute and reserves due checks across local server processes. It scans at most 100 users, visits at most 64 candidate connections, and performs at most eight network checks per pass, with a five-second signal per check and a 45-second pass budget. Scanning is also time-limited. Active seats and current access are checked before probing. STDIO is never started by this monitor. Set `MCP_HEALTH_CHECKS_ENABLED=false` to disable it.

Legacy MCP connections use protocol `ping`. MCP 2026-07-28 and newer use `server/discover`, since the stateless protocol removed legacy ping. These checks do not execute business tools. A provider may expose discovery without authentication; external token revocation can therefore only be confirmed by a request for which that provider actually validates authorization, or by a subsequent refresh rejection. Local expiry and previously observed authentication failures are still reported immediately.

Notifications are scoped to their owner and link to the exact connection in Settings. Marking one read does not resolve the underlying issue. Recovery removes the incident. The chat reconnect action uses the same current status and connection link; reopening a message never retries a business operation automatically.

Regression coverage: `npm run test:mcp:health`, `npm run test:mcp:oauth-lifecycle`, `npm run test:mcp:manager`, and `npx tsx scripts/home-notifications-test.ts`.
