import assert from 'node:assert/strict';
import { CapabilityPackageError } from '../app/lib/capabilities/packages/contracts';
import { capabilityPackageMcpConfigCompatibility, inspectCapabilityPackageMcpMatches } from '../app/lib/capabilities/packages/mcp-template-matches';
import type { CapabilityPackageMcpTemplate } from '../app/lib/capabilities/packages/presentation-contracts';
import type { PluginExtensionItem } from '../app/lib/plugins/plugin-extension-contracts';

const actor = { userId: 'member', workspaceId: 'readable-workspace' };
const resourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111';
const sharedRef = 'canvas-connection:22222222-2222-4222-8222-222222222222';
const ownRef = 'mcp-personal:33333333-3333-4333-8333-333333333333';
const template: CapabilityPackageMcpTemplate = { resourceRef, declaredBy: { kind: 'plugin', name: 'design' },
  source: { resourceRef, version: '1', checksum: 'a'.repeat(64), artifactRevision: 1 }, connector: { name: 'Canva MCP' },
  config: { url: 'https://mcp.fixture.invalid/provider', transport: 'http', auth: 'oauth' }, redactedFields: [] };
function item(id: string, displayName: string, manage = false): Extract<PluginExtensionItem, { kind: 'mcp' }> {
  return { id, kind: 'mcp', name: displayName, displayName, description: '', source: 'mcp', stock: 'installed',
    access: { canRead: true, canUse: true, canManage: manage }, mcp: { transport: 'http', template: false,
      ...(id.startsWith('canvas-connection:') ? { connectionRef: id } : { serverId: id.slice('mcp-personal:'.length) }) }, connections: [] };
}
async function main() {
  const matching = { url: 'https://mcp.fixture.invalid:443/provider', auth: 'oauth', headersFromEnv: { Authorization: 'PRIVATE_CREDENTIAL_KEY' } };
  assert.equal(capabilityPackageMcpConfigCompatibility(template, matching), 'endpoint', 'Standard-port normalization preserves the exact endpoint');
  const manifestOAuth = { ...template, connector: { ...template.connector, oauth: true }, config: { url: template.config!.url, transport: 'http' } };
  assert.equal(capabilityPackageMcpConfigCompatibility(manifestOAuth, matching), 'endpoint', 'OAuth declared only by the manifest matches the same OAuth connection that setup would create.');
  assert.equal(capabilityPackageMcpConfigCompatibility(manifestOAuth, { ...matching, auth: 'none' }), null, 'A no-auth connection cannot satisfy the manifest OAuth requirement at the same endpoint.');
  for (const wrong of [
    { ...matching, url: 'https://another.fixture.invalid/provider' }, { ...matching, url: 'https://mcp.fixture.invalid/other' },
    { ...matching, url: 'https://mcp.fixture.invalid/provider?account=other' }, { ...matching, auth: 'none' },
    { ...matching, command: 'private-server' },
  ]) assert.equal(capabilityPackageMcpConfigCompatibility(template, wrong), null, 'Same display names cannot make a different endpoint/auth process compatible');
  assert.equal(capabilityPackageMcpConfigCompatibility({ ...template, redactedFields: ['url'] }, matching), null);
  const stdio = { ...template, config: { command: 'npx', args: ['@provider/mcp'], transport: 'stdio' }, redactedFields: [] };
  assert.equal(capabilityPackageMcpConfigCompatibility(stdio, { command: 'npx', args: ['@provider/mcp'] }), 'stdio');
  assert.equal(capabilityPackageMcpConfigCompatibility(stdio, { command: 'npx', args: ['@other/mcp'] }), null);
  assert.equal(capabilityPackageMcpConfigCompatibility({ ...stdio, redactedFields: ['args.0'] }, { command: 'npx', args: ['@provider/mcp'] }), null);
  assert.equal(capabilityPackageMcpConfigCompatibility(stdio, { command: 'npx', args: ['@provider/mcp'], cwd: '/private/path' }), null);
  let templateReads = 0, catalogReads = 0, revoked = false, failOther = false, changed = false, endpointRotated = false;
  const configs = new Map<string, Record<string, unknown>>([[sharedRef, matching], [ownRef, { ...matching, url: 'https://wrong.fixture.invalid' }]]);
  const dependencies = {
    template: async (current: typeof actor, ref: string, query: unknown) => {
      assert.deepEqual(current, actor); assert.equal(ref, resourceRef); assert.deepEqual(query, { connector: 'Canva MCP', expectedChecksum: template.source.checksum });
      if (++templateReads > 1 && revoked) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Access revoked', 403);
      return structuredClone(changed && templateReads > 1 ? { ...template, source: { ...template.source, artifactRevision: 2 } } : template);
    },
    catalog: async (current: typeof actor) => {
      assert.deepEqual(current, actor); catalogReads += 1;
      return { items: [item(ownRef, 'Canva MCP'), ...(revoked && catalogReads > 1 ? [] : [item(sharedRef, 'Unrelated display label')])], coverage: { status: 'complete' } };
    },
    config: async (current: typeof actor, row: Extract<PluginExtensionItem, { kind: 'mcp' }>) => {
      assert.deepEqual(current, actor);
      if (failOther && row.id === ownRef) throw new Error('PRIVATE_BACKEND_PATH_OR_SECRET');
      return endpointRotated && catalogReads > 1 && row.id === sharedRef ? { ...matching, url: 'https://changed.fixture.invalid' } : configs.get(row.id)!;
    },
  };
  const query = { connector: 'Canva MCP', expectedChecksum: template.source.checksum };
  const read = () => { templateReads = 0; catalogReads = 0; return inspectCapabilityPackageMcpMatches(actor, resourceRef, query, { dependencies }); };
  let result = await read();
  assert.deepEqual(result.matches, [{ connectionRef: sharedRef, compatibility: 'endpoint' }], 'A readable Use-only shared resource matches by endpoint independently of labels/Manage');
  assert.equal(result.coverage, 'complete');
  assert(!JSON.stringify(result).includes('PRIVATE_CREDENTIAL_KEY')); assert(!JSON.stringify(result).includes('mcp.fixture.invalid'));
  failOther = true; result = await read(); assert.equal(result.coverage, 'partial'); assert.equal(result.matches.length, 1);
  assert(!JSON.stringify(result).includes('PRIVATE_BACKEND')); failOther = false;
  endpointRotated = true; result = await read(); assert.equal(result.matches.length, 0, 'A configuration change during inspection cannot publish a stale match'); endpointRotated = false;
  changed = true; await assert.rejects(read(), (error: unknown) => error instanceof CapabilityPackageError && error.code === 'PACKAGE_SOURCE_CHANGED'); changed = false;
  revoked = true; await assert.rejects(read(), (error: unknown) => error instanceof CapabilityPackageError && error.status === 403);
  console.log('PASS exact package MCP matches: endpoint/auth/portable process identity, same-name isolation, Use-only metadata, safe partial failure and late package/configuration fences.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
