import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentExtensionConfigurationInputSchema, EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';

// Schema boundaries only; generated references carry no source or use authority.
const sharedRefs = Array.from({ length: 129 }, () => `canvas-connection:${randomUUID()}`);
const sharedSlot = (connectionRef: string) => ({ mode: 'fixed' as const, entry: { selection: {
  kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'shared' as const, connectionRef, bindingRevision: 1 } },
requirement: 'optional' as const, toolCap: null } });
const envelope = (standalone: unknown[], selections: unknown[] = [], workflow: unknown = null) => ({
  version: 1, origin: 'agent_configuration', mode: 'fixed', selections, workflow, standalone,
});
assert.equal(EXTENSION_SELECTION_LIMITS.sharedConnections, 128);
assert(agentExtensionConfigurationInputSchema.safeParse(envelope(sharedRefs.slice(0, 128).map(sharedSlot))).success);
assert(!agentExtensionConfigurationInputSchema.safeParse(envelope(sharedRefs.map(sharedSlot))).success);
const pin = { resourceRef: `canvas-resource:${randomUUID()}`, publishedRevisionRef: `canvas-package-revision:${randomUUID()}`, checksum: 'c'.repeat(64) };
const plugin = { selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null };
const packageChoices = Array.from({ length: 3 }, (_, index) => ({ capabilityId: `cap-${index}`, selection: {
  mode: 'selectable', allowedChoices: sharedRefs.slice(index * 32, (index + 1) * 32).map((connectionRef, choiceIndex) => ({
    choiceId: `choice-${choiceIndex}`, alternativeKey: 'mcp:fixture', target: { kind: 'shared', source: 'mcp', connectionRef, bindingRevision: 1 }, toolCap: null,
  })),
} }));
const workflow = { version: 1, packages: [{ ...pin, skillSelection: { kind: 'plugin' },
  declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: packageChoices }] }] };
assert(agentExtensionConfigurationInputSchema.safeParse(envelope(sharedRefs.slice(96, 128).map(sharedSlot), [plugin], workflow)).success);
assert(!agentExtensionConfigurationInputSchema.safeParse(envelope(sharedRefs.slice(96).map(sharedSlot), [plugin], workflow)).success,
  'The shared bound covers every package alternative and standalone slot together.');
assert(agentExtensionConfigurationInputSchema.safeParse(envelope(sharedRefs.slice(0, 32).map(sharedSlot), [plugin], workflow)).success,
  'Reusing the same connection across a package and its explicit standalone selection counts its identity once.');
const personal = Array.from({ length: 256 }, () => ({ mode: 'fixed', entry: { selection: { kind: 'mcp', source: 'mcp',
  target: { kind: 'personal', connectionRef: `mcp-personal:${randomUUID()}` } }, requirement: 'optional', toolCap: null } }));
assert(agentExtensionConfigurationInputSchema.safeParse(envelope(personal)).success,
  'The shared-transaction bound does not reduce the separate 256-slot agent schema ceiling.');
assert(!agentExtensionConfigurationInputSchema.safeParse(envelope([...personal, ...personal.slice(0, 1)])).success);
console.log('PASS shared configuration schema budget: 128 distinct shared sources across packages/choices/slots, exact deduplication and independent 256 total agent ceiling; no authority or provider IO.');
