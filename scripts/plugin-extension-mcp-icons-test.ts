import assert from 'node:assert/strict';
import Module from 'node:module';
import type { McpServerConfig } from '../app/lib/mcp/config';
import type { McpServerIconMetadata } from '../app/lib/mcp/icons';

const actor = { userId: 'alice', workspaceId: 'personal-alice' };
const origin = 'https://current.example';
const fetchedAt = new Date(Date.now() - 1000).toISOString();
const connection = (id: string): McpServerConfig => ({ connectionId: id, ownerUserId: actor.userId, organizationId: 'org-a', authVersion: 7,
  displayName: 'Same MCP name', url: `${origin}/mcp?token=PRIVATE_CONNECTION_TOKEN`, auth: 'none', enabled: true });
const metadata = (serverName: string): McpServerIconMetadata => ({ serverName, origin, iconUrl: 'https://logos.example/cached.svg?token=PRIVATE_IMAGE_TOKEN#private',
  fetchedAt, fileName: 'cached.svg', contentType: 'image/svg+xml' });

async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown;
    _resolveFilename: (name: string, parent: NodeModule | null) => string };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  class McpAccessError extends Error { constructor(readonly status: number) { super('PRIVATE_ACCESS_REASON'); } }
  const names = ['explicit', 'cached', 'wrong-origin', 'wrong-name', 'future', 'invalid-time', 'zero-time', 'stdio', 'foreign', 'unreadable'];
  const connections = Object.fromEntries(names.map(name => [name, connection(name)]));
  connections.explicit!.iconUrl = 'https://logos.example/explicit.svg?key=PRIVATE_EXPLICIT_KEY#private';
  connections.stdio = { ...connections.stdio!, url: undefined, command: 'fixture-command' };
  connections.foreign!.ownerUserId = 'bob';
  const cached: Record<string, McpServerIconMetadata> = Object.fromEntries(names.map(name => [name, metadata(name)]));
  cached['wrong-origin']!.origin = 'https://previous.example';
  cached['wrong-name']!.serverName = 'other-private-server';
  cached.future!.fetchedAt = new Date(Date.now() + 60_000).toISOString();
  cached['invalid-time']!.fetchedAt = 'PRIVATE_INVALID_TIMESTAMP';
  cached['zero-time']!.fetchedAt = new Date(0).toISOString();
  let failCache = false, cacheReads = 0, refreshCalls = 0, networkCalls = 0;
  const statusNames: string[] = [];
  const forbidRefresh = () => { refreshCalls += 1; throw new Error('Catalogue metadata must not discover or refresh icons.'); };
  const fixtures = new Map<string, unknown>([
    ['@/app/lib/mcp/access', {
      McpAccessError, requireMcpUserAccess: async (scope: {userId: string}) => { assert.equal(scope.userId, actor.userId); return {userId: actor.userId, organizationId: 'org-a', canManageDefinitions: false}; },
      assertMcpConnectionAccess: async (name: string, scope: {userId: string}, options: {allowDisabled: boolean}) => {
        assert.equal(scope.userId, actor.userId); assert.equal(options.allowDisabled, true);
        if (name === 'unreadable') throw new McpAccessError(403);
        return {connection: connections[name]};
      },
    }],
    ['@/app/lib/mcp/config', {readMcpConfig: async () => ({mcpServers: connections})}],
    ['@/app/lib/mcp/connection-status', {readMcpConnectionStatus: async (name: string) => { statusNames.push(name); return {lastCheckedAt: null, reachability: 'unknown'}; }}],
    ['@/app/lib/mcp/oauth', {getMcpOAuthStatus: async () => ({configured: false, authorized: false})}],
    ['@/app/lib/mcp/server-definitions', {listMcpServerDefinitions: async () => []}],
    ['@/app/lib/integration-tools/connections/store', {listSharedIntegrationConnections: async () => []}],
    ['@/app/lib/mcp/icons', {
      readCachedMcpServerIcons: async (scope: {userId: string; organizationId?: string}) => { cacheReads += 1; assert.equal(scope.userId, actor.userId);
        assert.equal(scope.organizationId, 'org-a'); if (failCache) throw new Error('PRIVATE_CACHE_PATH'); return cached; },
      getMcpServerIconMetadata: forbidRefresh, readMcpServerIconFile: forbidRefresh, refreshMcpServerIcon: forbidRefresh, refreshMcpServerIcons: forbidRefresh,
    }],
  ]);
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    let resolved = name;
    try { resolved = loader._resolveFilename(name, parent); } catch { /* Alias lookup still matches. */ }
    const key = resolved.replace(`${process.cwd()}/`, '@/').replace(/\.(?:ts|tsx|js)$/u, '');
    return fixtures.has(name) ? fixtures.get(name) : fixtures.has(key) ? fixtures.get(key) : originalLoad(name, parent, isMain);
  };
  globalThis.fetch = async () => { networkCalls += 1; throw new Error('No image/provider discovery in catalogue reads.'); };
  try {
    const { readMcpExtensions } = await import('../app/lib/plugins/plugin-extension-integrations');
    const first = await readMcpExtensions(actor);
    assert.equal(first.coverage.status, 'complete');
    assert.equal(first.items.length, 8, 'Foreign and unreadable personal connections are omitted.');
    const item = (id: string) => first.items.find(value => value.id === `mcp-personal:${id}`)!;
    assert.equal(item('explicit').icon?.url, 'https://logos.example/explicit.svg', 'Explicit HTTPS image takes priority over cached metadata.');
    assert.equal(item('cached').icon?.url, 'https://logos.example/cached.svg');
    assert(item('cached').icon?.sourceKey.startsWith(`mcp-personal:cached:7:${fetchedAt}:`), 'Current connection identity/authVersion and canonical fetchedAt bind cached public metadata.');
    for (const name of ['wrong-origin', 'wrong-name', 'future', 'invalid-time', 'zero-time', 'stdio']) assert.equal(item(name).icon, undefined, name);
    assert(!statusNames.includes('foreign')); assert(!statusNames.includes('unreadable'));
    for (const privateValue of ['PRIVATE_CONNECTION_TOKEN', 'PRIVATE_IMAGE_TOKEN', 'PRIVATE_EXPLICIT_KEY', 'PRIVATE_INVALID_TIMESTAMP', 'PRIVATE_ACCESS_REASON', 'other-private-server']) {
      assert(!JSON.stringify(first).includes(privateValue));
    }
    failCache = true;
    const unavailableCache = await readMcpExtensions(actor);
    assert.equal(unavailableCache.coverage.status, 'complete', 'Optional cached icon failures do not invent MCP source failure.');
    assert.equal(unavailableCache.items.length, 8);
    assert.equal(unavailableCache.items.find(value => value.id === 'mcp-personal:explicit')?.icon?.url, 'https://logos.example/explicit.svg');
    assert.equal(unavailableCache.items.find(value => value.id === 'mcp-personal:cached')?.icon, undefined);
    assert(!JSON.stringify(unavailableCache).includes('PRIVATE_CACHE_PATH'));
    assert.equal(cacheReads, 2); assert.equal(refreshCalls, 0); assert.equal(networkCalls, 0);
    console.log('PASS actual MCP extension projection: sanitized explicit/cached public icons, current name/origin/identity/time binding, private access fences, optional cache failure, and zero icon refresh/discovery. Dependency fixtures only; no browser/provider evidence.');
  } finally { loader._load = originalLoad; globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
