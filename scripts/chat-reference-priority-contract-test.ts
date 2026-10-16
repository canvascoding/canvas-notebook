import assert from 'node:assert/strict';
import { agentExtensionOptionsRequestSchema } from '../app/lib/agents/extension-options-contracts';
import { chatExtensionOptionsRequestSchema } from '../app/lib/chat/extension-options-contracts';

const chat = { operation: 'search', target: { kind: 'draft_turn', agentId: 'agent-a', workspaceId: 'workspace-a' } };
for (const phase of ['all', 'local', 'connected', 'remote']) {
  assert.equal(chatExtensionOptionsRequestSchema.parse({ ...chat, phase }).operation, 'search');
}
assert.equal(chatExtensionOptionsRequestSchema.safeParse({ ...chat, phase: 'unknown' }).success, false);
assert.equal(chatExtensionOptionsRequestSchema.safeParse({ ...chat, phase: 'connected', scope: 'team' }).success, false);
assert.equal(chatExtensionOptionsRequestSchema.safeParse({ ...chat, phase: 'connected', audience: 'own' }).success, false);
assert.equal(chatExtensionOptionsRequestSchema.safeParse({ ...chat, phase: 'connected', unexpected: true }).success, false);
const agent = { operation: 'search', target: { kind: 'prospective', scopeType: 'organization' } };
assert.equal(agentExtensionOptionsRequestSchema.safeParse({ ...agent, phase: 'local' }).success, true);
assert.equal(agentExtensionOptionsRequestSchema.safeParse({ ...agent, phase: 'connected' }).success, false);
assert.equal(chatExtensionOptionsRequestSchema.safeParse({ ...agent, phase: 'connected' }).success, false);
assert.equal(agentExtensionOptionsRequestSchema.safeParse({ ...chat, phase: 'local' }).success, false);
console.log('PASS Chat-only connected observation phase preserves strict target, scope and Agent catalog boundaries.');
