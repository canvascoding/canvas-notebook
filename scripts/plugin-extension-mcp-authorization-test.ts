import assert from 'node:assert/strict';
import Module from 'node:module';
import type {McpServerConfig} from '../app/lib/mcp/config';

/** Projection failures are isolated here; the native companion verifies real authority/storage/OAuth. */
async function main() {
  const loader = Module as typeof Module & {_load: (name: string, parent: NodeModule | null, main: boolean) => unknown;
    _resolveFilename: (name: string, parent: NodeModule | null) => string};
  const originalLoad = loader._load;
  const actor = {userId: 'alice', workspaceId: 'personal-alice'};
  const oauthId = '11111111-1111-4111-8111-111111111111';
  const publicId = '22222222-2222-4222-8222-222222222222';
  const entries: Record<string, McpServerConfig> = {
    'Canva MCP': {connectionId: oauthId, ownerUserId: actor.userId, organizationId: null, auth: 'oauth', url: 'https://private.example/mcp', enabled: true},
    'Public MCP': {connectionId: publicId, ownerUserId: actor.userId, organizationId: 'org', auth: 'none', url: 'https://private.example/public', enabled: true},
  };
  let failHealth = false, oauth: Record<string, unknown> | Error = {configured: true, authorized: true}, oauthReads = 0;
  class McpAccessError extends Error { constructor(readonly status: number) {super('PRIVATE_ACCESS_REASON');} }
  const fixture = new Map<string, unknown>([
    ['@/app/lib/mcp/access', {McpAccessError, requireMcpUserAccess: async () => ({...actor, organizationId: 'org', canManageDefinitions: true}),
      assertMcpConnectionAccess: async (name: string, scope: {userId?: string; organizationId?: string}, options: {actor: {organizationId: string}}) => {
        assert.equal(scope.organizationId, 'org'); assert.equal(options.actor.organizationId, 'org', 'Current actor/org access check remains intact');
        return {connection: entries[name]};
      }}],
    ['@/app/lib/mcp/config', {readMcpConfig: async () => ({mcpServers: entries})}],
    ['@/app/lib/mcp/credential-storage', {resolveMcpCredentialScope: (connection: McpServerConfig, scope: {userId?: string; organizationId?: string}) => {
      assert.deepEqual(scope, {userId: actor.userId}, 'The base credential request never invents an actor organization');
      return {...scope, organizationId: connection.organizationId || null};
    }}],
    ['@/app/lib/mcp/connection-status', {readMcpConnectionStatus: async (id: string, connection: McpServerConfig, scope: {organizationId: string | null}) => {
      assert.equal(id, connection.connectionId, 'Health reconciliation uses the exact canonical connection identity');
      assert.equal(scope.organizationId, connection.organizationId, 'Health retains exact nullable credential binding');
      if (id === oauthId && failHealth) throw new Error('PRIVATE_HEALTH_PATH');
      return {lastCheckedAt: new Date().toISOString(), reachability: 'reachable'};
    }}],
    ['@/app/lib/mcp/oauth', {getMcpOAuthStatus: async (id: string, _origin: unknown, scope: {organizationId: string | null}) => {
      oauthReads += 1; assert.equal(id, oauthId, 'Only the exact OAuth connection needs a token read'); assert.equal(scope.organizationId, null);
      if (oauth instanceof Error) throw oauth; return oauth;
    }}],
    ['@/app/lib/mcp/server-definitions', {listMcpServerDefinitions: async (organizationId: string) => {assert.equal(organizationId, 'org');return [];}}],
    ['@/app/lib/integration-tools/connections/store', {listSharedIntegrationConnections: async () => []}],
    ['@/app/lib/mcp/icons', {readCachedMcpServerIcons: async () => ({})}],
  ]);
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    let resolved = name;try {resolved = loader._resolveFilename(name, parent);} catch { /* Exact aliases can still match. */ }
    const key = resolved.replace(`${process.cwd()}/`, '@/').replace(/\.(?:ts|tsx|js)$/u, '');
    return fixture.has(name) ? fixture.get(name) : fixture.has(key) ? fixture.get(key) : originalLoad(name, parent, isMain);
  };
  try {
    const {readMcpExtensions} = await import('../app/lib/plugins/plugin-extension-integrations');
    const check = async (authorization: string, health: string, coverage: string) => {
      const result = await readMcpExtensions(actor), item = result.items.find(value => value.id === `mcp-personal:${oauthId}`);
      assert(item?.kind === 'mcp');assert.equal(item.connections[0]?.authorization, authorization);assert.equal(item.connections[0]?.health, health);assert.equal(result.coverage.status, coverage);
      const anonymous = result.items.find(value => value.id === `mcp-personal:${publicId}`);assert(anonymous?.kind === 'mcp');
      assert.equal(anonymous.connections[0]?.authorization, 'not_required');
      assert(!JSON.stringify(result).includes('PRIVATE_') && !JSON.stringify(result).includes('private.example'), 'Private backend/errors do not enter the DTO');
      return result;
    };
    await check('authorized', 'healthy', 'complete');
    failHealth = true;await check('authorized', 'unknown', 'partial');
    failHealth = false;oauth = {configured: true, authorized: false, code: 'reauth_required'};await check('required', 'healthy', 'complete');
    for (const code of ['unavailable', 'mcp_credential_key_missing', 'decryption_failed']) {
      oauth = {configured: true, authorized: false, code, reason: 'PRIVATE_CREDENTIAL_REASON'};await check('unknown', 'healthy', 'partial');
    }
    oauth = new Error('PRIVATE_OAUTH_READ');await check('unknown', 'healthy', 'partial');
    oauth = {configured: false, authorized: false};await check('unknown', 'healthy', 'partial');
    assert.equal(oauthReads, 8, 'Anonymous MCP entries never perform an OAuth token read');
    console.log('PASS MCP extension authorization projection: canonical nullable credential scopes, actor/definition organization guards retained, independent health/token failures, safe unavailable status, anonymous auth and private DTOs.');
  } finally {loader._load = originalLoad;}
}
main().catch(error => {console.error(error);process.exitCode = 1;});
