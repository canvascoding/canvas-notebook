# MCP connection storage and recovery

Personal MCP configurations live in `users/<userId>/mcp/config.json` under the
configured data root. Each connection has an immutable UUID, owner, optional
organization and authorization revision. Separate entries can connect different
accounts to the same endpoint. Rename an entry by retaining its `connectionId`;
omit the ID when creating an additional account. Removed IDs cannot be imported
to revive an account.

OAuth credentials live in `users/<userId>/mcp/connections/<connectionId>/`.
Tokens, dynamically registered client secrets and PKCE state are authenticated
AES-256-GCM envelopes. Authentication binds the ciphertext to the owner,
organization, connection and storage purpose. Directories use mode `0700` and
files `0600`. Cosmetic edits and activation changes do not change the OAuth
configuration hash; endpoint, issuer, client and scope changes do.

## Encryption keys

Provision a cryptographically random key of at least 32 bytes before using OAuth:

- An externally provisioned `INTEGRATIONS_ENV_MASTER_KEY` takes precedence. Keep
  it in the deployment secret manager; it also protects other integration data.
- Otherwise configure `MCP_CREDENTIAL_KEY` in the central integrations secret
  file, `/data/secrets/Canvas-Integrations.env`, through the integrations settings.
  This uses the existing explicit instance secret scope, not a member's file.

There is no fallback to plaintext. An unavailable or invalid key produces an
actionable settings error. Do not place keys in MCP server JSON or commit them.

For rotation, retain previous key values in `MCP_CREDENTIAL_PREVIOUS_KEYS`, a JSON
array. With an external master key, provision this array in the runtime
environment; otherwise use the central integrations secret file. New writes use
the active key, while the envelope key ID selects the correct retained key on
read. Retain old keys until every retained credential, OAuth state and backup
that must remain usable has been replaced or re-encrypted. Changing the shared
integrations master key also requires the integrations system's own rotation
procedure; MCP's previous-key support does not rotate that other data.

## Migration and backups

Legacy personal configurations receive stable identities on first read. The
credential migration only imports a legacy token whose recorded configuration
and exact original server name match. Sanitized-name collisions require fresh
authorization. Encrypted files are written before the migration marker and
plaintext removal; a failed encryption leaves the old files available for a
retry. Pre-upgrade pending OAuth flows must be restarted and their old PKCE
state is removed. Personal connections never import another user's credentials
or implicitly fall back to global credentials.

Back up the data root and preserve the corresponding encryption keys separately.
A data-only restore cannot decrypt secrets without those keys. If a key is kept
inside the central secret file, a full data-root backup includes it: protect and
encrypt that backup accordingly. Test restoration with matching keys before
retiring an old backup or key.

## Concurrent processes

Connection storage locks serialize writers across Node processes on the same
host. Live locks are never stolen because of age. A dead local process is
recovered automatically. A foreign-host lock, reused PID or interrupted lock
recovery fails closed. Before manually removing a `.mcp-storage-locks` entry,
stop every process using that data root and confirm the recorded owner has
stopped. Shared-file deployments across multiple hosts require a distributed
lock implementation; these file locks deliberately do not guess remote liveness.

## OAuth lifecycle

Every outbound HTTP request loads current credentials. Refreshes are serialized
per connection across local processes and re-read the token after obtaining the
lock, including refresh-token rotation. A 401 can renew credentials, but the
rejected operation is never automatically replayed. The caller must explicitly
retry, so a write action cannot be duplicated by transport recovery.

Disconnect and authorization configuration changes increment a durable generation
before waiting for provider requests. Registration, pending PKCE state, token
refresh and callback completion verify the current connection revision and
generation before saving. Cleanup removes only older generations, preserving a
new authorization that completed after a configuration change. Generation records
contain no credentials and remain as private files after disconnect. Include them
in backups with the connection configuration and credentials.

Pending states are consumed once under a cross-process lock and expire after ten
minutes. Disabled connections cannot start or complete authorization. UI polling
matches the exact completed OAuth state so an existing token cannot make a new
login appear complete.

When discovery advertises a revocation endpoint, new tokens retain it for a
bounded, best-effort revocation attempt on disconnect. Local invalidation and
credential removal succeed even when that endpoint fails. Revocation support and
grant propagation are provider-dependent; no successful remote revocation is
assumed from a failed request. See [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html).

Refreshable expired tokens remain authorized until refresh fails definitively.
Rate limits, network errors and provider outages preserve credentials for retry;
invalid grants require a new login. Unsupported token types and invalid token
lifetimes are rejected.
