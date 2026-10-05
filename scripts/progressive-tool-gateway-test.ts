import assert from 'node:assert/strict';

import { Type } from 'typebox';
import { buildEffectiveToolManifest } from '../app/lib/pi/effective-tool-manifest';
import { filterToolsForWorkspacePermissions } from '../app/lib/pi/workspace-tool-policy';

import {
  PROGRESSIVE_GATEWAY_DEFINITIONS,
  createProgressiveGatewayTool,
  getProgressiveGatewayCapabilityNames,
  withAllowedProgressiveGatewayOperations,
} from '../app/lib/pi/progressive-tool-gateway';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

async function main() {
  const studioGateway = PROGRESSIVE_GATEWAY_DEFINITIONS.find((definition) => definition.name === 'studio');
  assert.ok(studioGateway);
  assert.equal(studioGateway.operations.includes('studio_generate_image'), false);
  assert.equal(studioGateway.operations.includes('studio_generate_video'), false);
  assert.equal(studioGateway.operations.includes('studio_generate_sound'), true);

  const calls: Array<{ name: string; params: unknown }> = [];
  const operations = [
    {
      name: 'example_read',
      label: 'Reading example',
      description: 'Reads an example record.',
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_toolCallId: string, params: unknown) => {
        calls.push({ name: 'example_read', params });
        return { content: [{ type: 'text' as const, text: 'read ok' }], details: { id: (params as { id: string }).id } };
      },
    },
    {
      name: 'example_delete',
      label: 'Deleting example',
      description: 'Deletes an example record.',
      parameters: Type.Object({ id: Type.String(), confirm: Type.Literal(true) }),
      execute: async (_toolCallId: string, params: unknown) => {
        calls.push({ name: 'example_delete', params });
        return { content: [{ type: 'text' as const, text: 'delete ok' }], details: {} };
      },
    },
  ];

  const gateway = createProgressiveGatewayTool({
    name: 'example_gateway',
    label: 'Example gateway',
    description: 'Test gateway.',
    operations: ['example_read', 'example_delete'],
  }, operations);

  assert.deepEqual(getProgressiveGatewayCapabilityNames([gateway]), ['example_read', 'example_delete']);

  const restricted = withAllowedProgressiveGatewayOperations(gateway, new Set(['example_read']));
  assert.ok(restricted);

  const search = await restricted.execute('search', { action: 'search' });
  assert.match(getText(search), /example_read/);
  assert.doesNotMatch(getText(search), /example_delete/);
  assert.doesNotMatch(getText(search), /Input schema/);

  const describe = await restricted.execute('describe', { action: 'describe', operation: 'example_read' });
  assert.match(getText(describe), /Input schema/);
  assert.match(getText(describe), /"id"/);

  const denied = await restricted.execute('denied', { action: 'describe', operation: 'example_delete' });
  assert.match(getText(denied), /not available/);

  const invalid = await restricted.execute('invalid', { action: 'call', operation: 'example_read', arguments: {} });
  assert.match(getText(invalid), /Invalid arguments/);
  assert.equal(calls.length, 0);

  const called = await restricted.execute('call', { action: 'call', operation: 'example_read', arguments: { id: 'record-1' } });
  assert.equal(getText(called), 'read ok');
  assert.deepEqual(calls, [{ name: 'example_read', params: { id: 'record-1' } }]);
  assert.deepEqual((called.details as { gateway: string; operation: string }).gateway, 'example_gateway');
  assert.deepEqual((called.details as { gateway: string; operation: string }).operation, 'example_read');

  const unmatched = await restricted.execute('unmatched', { action: 'search', query: 'unknown app' });
  assert.match(getText(unmatched), /example_read/);
  assert.doesNotMatch(getText(unmatched), /example_delete/);
  assert.equal((unmatched.details as { fallback: boolean }).fallback, true);
  assert.deepEqual(getProgressiveGatewayCapabilityNames([restricted]), ['example_read']);
  assert.deepEqual(buildEffectiveToolManifest([restricted]).gateways[0]?.allowedOperationNames, ['example_read']);

  // A later workspace filter must not restore operations disabled in agent settings.
  const filteredAgain = filterToolsForWorkspacePermissions([restricted], { canWrite: false, canDelete: false, canShare: false });
  assert.equal(filteredAgain.length, 1);
  assert.match(getText(await filteredAgain[0].execute('still-denied', { action: 'call', operation: 'example_delete', arguments: { id: 'record-1', confirm: true } })), /not available/);
  assert.deepEqual(getProgressiveGatewayCapabilityNames(filteredAgain), ['example_read']);
  const widened = withAllowedProgressiveGatewayOperations(restricted, ['example_read', 'example_delete']);
  assert.ok(widened);
  assert.deepEqual(getProgressiveGatewayCapabilityNames([widened]), ['example_read']);

  const composioDefinition = PROGRESSIVE_GATEWAY_DEFINITIONS.find((definition) => definition.name === 'composio');
  assert.ok(composioDefinition);
  const externalCalls: Array<{ name: string; params: unknown }> = [];
  const composio = createProgressiveGatewayTool(composioDefinition, composioDefinition.operations.map((name) => ({
    name,
    label: name,
    // App names live in the provider catalog, not these generic operation descriptions.
    description: name === 'COMPOSIO_SEARCH_TOOLS' ? 'Discover external app tools.' : 'Work with external apps.',
    parameters: name === 'COMPOSIO_SEARCH_TOOLS'
      ? Type.Object({ query: Type.Optional(Type.String()), toolkits: Type.Optional(Type.Array(Type.String())) })
      : Type.Object({}),
    execute: async (_toolCallId: string, params: unknown) => {
      externalCalls.push({ name, params });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ tools: [{ slug: 'CANVA_LIST_DESIGNS', toolkit: 'canva' }] }) }], details: {} };
    },
  })));

  for (const query of ['Canva', 'Canva Designs suchen', 'Figma', 'Instagram']) {
    const discovery = await composio.execute('app-search', { action: 'search', query });
    assert.match(getText(discovery), /COMPOSIO_SEARCH_TOOLS/);
    assert.match(getText(discovery), /toolkits/);
    assert.match(getText(discovery), /connection status/);
    assert.doesNotMatch(getText(discovery), /No permitted operations/);
    assert.equal((discovery.details as { fallback: boolean }).fallback, true);
  }
  assert.equal(externalCalls.length, 0);
  const appSchema = await composio.execute('app-schema', { action: 'describe', operation: 'COMPOSIO_SEARCH_TOOLS' });
  assert.match(getText(appSchema), /"toolkits"/);
  const appTools = await composio.execute('app-tools', { action: 'call', operation: 'COMPOSIO_SEARCH_TOOLS', arguments: { toolkits: ['canva'] } });
  assert.match(getText(appTools), /CANVA_LIST_DESIGNS/);
  assert.deepEqual(externalCalls, [{ name: 'COMPOSIO_SEARCH_TOOLS', params: { toolkits: ['canva'] } }]);

  const statusOnly = withAllowedProgressiveGatewayOperations(composio, ['COMPOSIO_MANAGE_CONNECTIONS']);
  assert.ok(statusOnly);
  assert.doesNotMatch(statusOnly.description, /COMPOSIO_SEARCH_TOOLS|composio_execute/);
  assert.deepEqual(buildEffectiveToolManifest([statusOnly]).gateways[0]?.allowedOperationNames, ['COMPOSIO_MANAGE_CONNECTIONS']);
  const statusSearch = await statusOnly.execute('status-search', { action: 'search', query: 'Canva' });
  assert.match(getText(statusSearch), /COMPOSIO_MANAGE_CONNECTIONS/);
  assert.doesNotMatch(getText(statusSearch), /COMPOSIO_SEARCH_TOOLS|composio_execute/);
  assert.equal(withAllowedProgressiveGatewayOperations(composio, []), null);

  console.log('progressive-tool-gateway-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
