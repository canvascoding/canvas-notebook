import assert from 'node:assert/strict';
import Module from 'node:module';
import type { McpServerConfig } from '../app/lib/mcp/config';

const actor = { userId: 'alice', workspaceId: 'personal-alice' };
const origin = 'https://current.example';
const connection = (id: string): McpServerConfig => ({ connectionId: id, ownerUserId: actor.userId, organizationId: 'org-a', authVersion: 7,
  displayName: 'Same MCP name', url: `${origin}/mcp?token=PRIVATE_CONNECTION_TOKEN`, auth: 'none', enabled: true });

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
  let cacheReads = 0, refreshCalls = 0, networkCalls = 0;
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
    ['@/app/lib/mcp/server-definitions', {listMcpServerDefinitions: async () => [
      {id: 'definition-one', organizationId: 'org-a', name: 'Approved MCP', enabled: true, revision: 3, config: {url: `${origin}/approved`}},
      {id: 'disabled-definition', organizationId: 'org-a', name: 'Disabled MCP', enabled: false, revision: 1, config: {url: `${origin}/disabled`}},
    ]}],
    ['@/app/lib/integration-tools/connections/store', {listSharedIntegrationConnections: async () => [{
      resource: {connectionRef: 'canvas-connection:shared-one', displayName: 'Readable shared MCP', status: 'active',
        ownership: {type: 'organization', organizationId: 'org-a'}}, ownershipLabel: 'Organization',
      access: {canRead: true, canUse: false, canManage: false},
    }]}],
    ['@/app/lib/mcp/shared-connections', {resolveSharedMcpBackend: async (input: unknown, ref: string, operation: string) => {
      assert.equal(input, actor); assert.equal(ref, 'canvas-connection:shared-one'); assert.equal(operation, 'inspect');
      return {connection: {...connection('PRIVATE_SHARED_BACKEND_ID'), ownerUserId: undefined}, authorization: {
        resource: {metadataRevision: 2, grantsRevision: 4, bindingRevision: 6}}};
    }}],
    ['@/app/lib/mcp/icons', {
      readCachedMcpServerIcons: async () => { cacheReads += 1; throw new Error('No catalogue cache reads required.'); },
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
    assert.equal(first.items.length, 10, 'Foreign/unreadable connections and disabled definitions are omitted.');
    const item = (id: string) => first.items.find(value => value.id === `mcp-personal:${id}`)!;
    for (const name of names.filter(name => !['stdio', 'foreign', 'unreadable'].includes(name))) {
      const icon = item(name).icon!;
      const url = new URL(icon.url, 'https://canvas.test');
      assert.equal(decodeURIComponent(url.pathname.split('/').at(-1)!), `mcp-personal:${name}`);
      assert.match(url.searchParams.get('binding')!, /^[a-f0-9]{64}$/u);
      assert.equal(url.searchParams.get('workspaceId'), actor.workspaceId);
      assert(icon.sourceKey.includes(`mcp-personal:${name}`));
    }
    assert.equal(item('stdio').icon, undefined);
    assert(first.items.find(value => value.id === 'mcp-definition:definition-one')?.icon);
    const shared = first.items.find(value => value.id === 'canvas-connection:shared-one')!;
    assert(shared.icon, 'Read-only shared metadata gets an icon without use or management rights.');
    assert.equal(shared.access.canUse, false); assert.equal(shared.access.canManage, false);
    assert(!statusNames.includes('foreign')); assert(!statusNames.includes('unreadable'));
    for (const privateValue of ['PRIVATE_CONNECTION_TOKEN', 'PRIVATE_SHARED_BACKEND_ID', 'PRIVATE_EXPLICIT_KEY', 'PRIVATE_ACCESS_REASON', origin, 'logos.example']) {
      assert(!JSON.stringify(first).includes(privateValue));
    }
    const initialBinding = item('cached').icon?.sourceKey;
    connections.cached!.url = 'https://changed.example/mcp';
    assert.notEqual((await readMcpExtensions(actor)).items.find(value => value.id === 'mcp-personal:cached')?.icon?.sourceKey, initialBinding,
      'A target change replaces the source binding even when connection identity and name are unchanged.');
    assert.equal(cacheReads, 0); assert.equal(refreshCalls, 0); assert.equal(networkCalls, 0);
    console.log('PASS MCP catalogue projection: exact lazy personal/shared/definition image references, source changes, read-only access, no private URL/backend data and zero image discovery during search. Dependency fixtures only; no browser/provider evidence.');
  } finally { loader._load = originalLoad; globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
