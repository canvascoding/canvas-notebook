# Canvas MCP authorization status

The Canvas MCP server connection list represents a user's stored OAuth consents. A consent alone does not establish that a client is connected or can still use the server.

The list separately reports current authorization usability, session and refresh expiry, and the last authenticated successful `tools/list` or `tools/call`. Anonymous discovery, rejected authorization and failed tool results do not advance the last-success timestamp. This timestamp records an observed success; it is not a heartbeat or a promise that the next request will succeed.

Usability combines current client/resource policy, consent, account and seat access, selected accessible workspaces, session lifetime, and observed access-token or refresh-grant evidence. Unknown evidence is not shown as active. Runtime token verification and workspace authorization remain authoritative for every request.

Usage evidence is stored privately under `users/<userId>/mcp/server-usage/`, keyed by the resource and client. Each versioned file holds a last-success timestamp and at most ten observed grants. It contains a SHA-256 token hash and session/lifetime metadata, never the token, request arguments, tool output or session cookies. Files use mode 0600, directories 0700, and writes are atomic and serialized. Usage evidence is historical: current consent and revocation checks prevent old records from restoring disconnected access.

Disconnect is scoped to the signed-in user and the selected client. Its transaction revokes that user's grants and removes their consent and workspace selections. Another user's authorization for the same OAuth client remains independent. To reconnect, the user starts authorization in their MCP client; opening Settings or an old chat does not start it automatically.

## Studio image tools

Enable the three Studio image capabilities in **Settings → MCP** and grant the OAuth connection access to the Studio workspace. Clients need `studio:read` to discover models and retrieve results and `studio:generate` to submit jobs. Generation also requires workspace write and agent permissions and uses the provider configured in Studio.

1. Call `studio_image_catalog` with `workspaceId` to find available providers, model IDs, sizes, presets, products, personas, styles and saved reference images.
2. Call `studio_generate_image` with the workspace, a prompt and a fresh `idempotencyKey`. Use the catalog IDs in `preset_id`, `product_ids`, `persona_ids` or `style_ids`. Use `extra_reference_urls` for workspace images, uploaded references or public HTTPS images. Retry the same request with the same key.
3. Poll `studio_image_result` with the returned `generationId`. A completed result lists its output IDs and Studio media URLs. Pass an `outputId` to receive the image in MCP. Large images are returned as previews and the media URL opens the original in Canvas.
4. To edit a result, submit a new generation with its `source_output_id`, an editing prompt and a new key. Jobs and outputs appear in the same workspace Studio library.
