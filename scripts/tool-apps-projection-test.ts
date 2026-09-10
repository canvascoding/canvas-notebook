import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ChatMessage } from '../app/lib/chat/types';
import { buildToolBatchProjection } from '../app/lib/chat/run-collapse';
import { projectAgentMessageForLoadedContext } from '../app/lib/pi/message-projection';
import { projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';
import { AUTOMATION_APP_URI, readToolAppInvocation } from '../app/lib/tool-apps/types';
import { ToolAppSlotPool } from '../app/lib/tool-apps/slot-pool';
import { createProgressiveGatewayTool } from '../app/lib/pi/progressive-tool-gateway';

const descriptor = { kind: 'builtin', version: 1, resourceUri: AUTOMATION_APP_URI,
  operation: 'create_automation_job', toolCallId: 'create-1', entityId: 'job-00000000-0000-0000-0000-000000000001' };
const raw = { role: 'toolResult', toolName: 'automation_manage', toolCallId: 'create-1',
  content: [{ type: 'text', text: `Automation created. ${'x'.repeat(250_000)}` }],
  details: { action: 'call', operation: descriptor.operation, job: { id: descriptor.entityId, prompt: 'x'.repeat(50_000) }, toolApp: descriptor },
  timestamp: 1,
} as unknown as AgentMessage;
const persisted = projectAgentMessageForPersistence(raw);
const display = projectAgentMessageForLoadedContext(persisted, 'display');
assert.deepEqual(readToolAppInvocation(display), { kind: 'builtin', descriptor });
assert.ok(JSON.stringify(display).length < 30_000, 'UI binding must not bypass data limits');
const context = projectAgentMessageForLoadedContext(persisted, 'context');
assert.ok(!JSON.stringify(context).includes('toolApp'));
assert.ok(!JSON.stringify(context).includes(AUTOMATION_APP_URI));
assert.equal(readToolAppInvocation(context), null);
assert.equal(readToolAppInvocation({ ...raw, isError: true }), null);
assert.equal(readToolAppInvocation({ ...raw, details: { ...(raw as unknown as { details: Record<string, unknown> }).details, toolApp: { ...descriptor, version: 2 } } }), null);

const result = (id: string): ChatMessage => ({ id, role: 'toolResult', content: 'created', status: 'sent', toolCallId: 'create-1', piMessage: display });
const assistant = (id: string): ChatMessage => ({ id, role: 'assistant', content: '', status: 'sent', piMessage: {
  role: 'assistant', content: [{ type: 'toolCall', id: 'create-1', name: 'automations', arguments: {} }],
} as AgentMessage });
for (const messages of [[result('old'), result('saved')], [assistant('live'), result('old'), assistant('synced'), result('saved')]]) {
  const projection = buildToolBatchProjection(messages);
  const calls = [...projection.batchesByAnchorId.values()].flatMap((batch) => batch.calls);
  assert.equal(calls.length, 1, 'duplicate result and assistant events must produce one card');
  assert.equal(calls[0].message?.id, 'saved');
}

const pool = new ToolAppSlotPool(2);
const mounted: number[] = [];
const release1 = pool.acquire(() => mounted.push(1));
const release2 = pool.acquire(() => mounted.push(2));
const release3 = pool.acquire(() => mounted.push(3));
assert.deepEqual(mounted, [1, 2]);
release1();
assert.deepEqual(mounted, [1, 2, 3]);
release1();
release2(); release3();
const release4 = pool.acquire(() => mounted.push(4));
assert.deepEqual(mounted, [1, 2, 3, 4]);
release4();
console.log('tool apps projection and frame budget tests passed');

async function verifyGateway() {
  const { Type } = await import('typebox');
  const gateway = createProgressiveGatewayTool({ name: 'automation_manage', label: 'Automations', description: 'Automation gateway', operations: ['create_automation_job'] }, [{
    name: 'create_automation_job', label: 'Create', description: 'Create an automation', parameters: Type.Object({}),
    execute: async (toolCallId) => ({ content: [{ type: 'text', text: 'Created' }], details: {
      toolApp: { ...descriptor, toolCallId }, job: { id: descriptor.entityId },
    } }),
  }]);
  const result = await gateway.execute('actual-gateway-call', { action: 'call', operation: 'create_automation_job', arguments: {} });
  const message = { role: 'toolResult', toolName: gateway.name, toolCallId: 'actual-gateway-call', ...result };
  assert.equal(readToolAppInvocation(message)?.kind, 'builtin');
  assert.equal(readToolAppInvocation({ ...message, toolName: 'unrelated_gateway' }), null);
  console.log('actual automation_manage gateway widget contract passed');
}
void verifyGateway().catch((error) => { console.error(error); process.exitCode = 1; });
