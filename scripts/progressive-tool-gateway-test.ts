import assert from 'node:assert/strict';

import { Type } from 'typebox';

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

  console.log('progressive-tool-gateway-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
