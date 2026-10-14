import assert from 'node:assert/strict';
import type { IntegrationProviderDescriptor } from '../app/lib/integration-tools/contracts';
import type { AgentStandaloneRuntimeSelection } from '../app/lib/capabilities/extensions/standalone-runtime';
import {
  projectAgentExtensionProviderContext,
  type AgentExtensionProviderContextChoice,
} from '../app/lib/agents/extension-provider-context-projection';

// Pure callback/order/aggregation contract only. Synthetic metadata grants no
// source authority; the separate SQL fixture checks genuine Actor/ACL/batches.
async function main() {
  const descriptor = (ref: string, source: 'mcp' | 'composio' = 'mcp'): IntegrationProviderDescriptor => ({
    providerRef: ref, source, displayName: ref, scope: { type: 'user', ownerUserId: 'metadata-only', resourceId: ref },
    state: 'unknown', configured: true, requiresAuth: 'unknown', authorized: 'unknown', health: 'unknown', canExecute: false,
    checkedAt: null, statusSource: 'configuration', pluginRefs: [], skillRefs: [], matchReasons: [], nextActions: [],
  });
  const summary = (slot: string, required = false, selected = true): AgentStandaloneRuntimeSelection => ({
    configurationId: slot, slotRef: slot, source: 'mcp', required, origin: selected ? 'fixed' : 'missing', state: selected ? 'selected' : 'missing',
  });
  const calls: string[] = [];
  const choice = (label: string, ref = label, toolCap: readonly string[] | null = null): AgentExtensionProviderContextChoice => ({
    resolve: async () => { calls.push(label); return { descriptor: descriptor(ref), toolCap }; },
  });
  const failure = (label: string): AgentExtensionProviderContextChoice => ({ resolve: async () => { calls.push(label); throw new Error('Metadata unavailable'); } });

  const missingPackage = await projectAgentExtensionProviderContext({ revisionSeed: 'missing-package', capabilities: [
    { required: false, choice: choice('unresolved-package') }, { required: true, choice: null },
  ], standalone: [{ summary: summary('unresolved-standalone'), choice: choice('unresolved-standalone') }] });
  assert.deepEqual(calls, []);
  assert(missingPackage.projection.unavailable);
  assert.deepEqual(missingPackage.projection.standaloneSelections, [summary('unresolved-standalone')]);
  assert.deepEqual(missingPackage.projection.selectedProviders, []);

  const missingStandalone = await projectAgentExtensionProviderContext({ revisionSeed: 'missing-standalone', capabilities: [
    { required: true, choice: choice('package-before-missing-standalone') },
  ], standalone: [{ summary: summary('required-missing', true, false), choice: null },
    { summary: summary('unresolved-standalone'), choice: choice('unresolved-standalone') }] });
  assert.deepEqual(calls, ['package-before-missing-standalone']);
  assert(missingStandalone.projection.unavailable);
  assert.deepEqual(missingStandalone.requiredProviders, []);
  assert.equal(missingStandalone.projection.standaloneSelections[1].providerRef, undefined);

  calls.length = 0;
  const failedPackage = await projectAgentExtensionProviderContext({ revisionSeed: 'failed-package', capabilities: [
    { required: false, choice: failure('optional-outage') }, { required: true, choice: failure('required-outage') },
    { required: false, choice: choice('never-later-package') },
  ], standalone: [{ summary: summary('never-standalone'), choice: choice('never-standalone') }] });
  assert.deepEqual(calls, ['optional-outage', 'required-outage']);
  assert(failedPackage.projection.unavailable);

  calls.length = 0;
  const merged = await projectAgentExtensionProviderContext({ revisionSeed: 'union', capabilities: [
    { required: false, choice: failure('optional-outage') }, { required: true, choice: choice('package-reader', 'same-ref', ['READ']) },
  ], standalone: [{ summary: summary('writer', true), choice: choice('standalone-writer', 'same-ref', ['WRITE', 'READ']) },
    { summary: summary('empty'), choice: choice('empty', 'empty-ref', []) }] });
  assert.deepEqual(calls, ['optional-outage', 'package-reader', 'standalone-writer', 'empty']);
  assert.equal(merged.projection.unavailable, false);
  assert.deepEqual(merged.requiredProviders, [{ source: 'mcp', providerRef: 'same-ref' }]);
  assert.deepEqual(merged.projection.selectedProviders.map(value => value.providerRef), ['same-ref', 'empty-ref']);
  assert.deepEqual(merged.projection.policy.providerToolRules?.find(value => value.providerRef === 'same-ref')?.allowedToolNames, ['READ', 'WRITE']);
  assert(!merged.projection.policy.providerToolRules?.find(value => value.providerRef === 'empty-ref')?.allowedOperations?.includes('call'));
  assert.equal(merged.projection.standaloneSelections[0].providerRef, 'same-ref');
  assert(Object.isFrozen(merged.projection.selectedProviders[0].nextActions));

  const unrestricted = await projectAgentExtensionProviderContext({ revisionSeed: 'unrestricted', capabilities: [
    { required: true, choice: choice('read', 'same-ref', ['READ']) },
  ], standalone: [{ summary: summary('unrestricted'), choice: choice('unrestricted', 'same-ref', null) }] });
  assert.equal(unrestricted.projection.policy.providerToolRules?.[0].allowedToolNames, null);

  calls.length = 0;
  const failedStandalone = await projectAgentExtensionProviderContext({ revisionSeed: 'failed-standalone', capabilities: [], standalone: [
    { summary: summary('required-fails', true), choice: failure('required-standalone-outage') },
    { summary: summary('later-still-inspected'), choice: choice('later-still-inspected') },
  ] });
  assert.deepEqual(calls, ['required-standalone-outage', 'later-still-inspected']);
  assert(failedStandalone.projection.unavailable);
  assert.equal(failedStandalone.projection.standaloneSelections[0].state, 'unavailable');
  assert.equal(failedStandalone.projection.standaloneSelections[1].providerRef, 'later-still-inspected');
  assert.deepEqual(failedStandalone.projection.policy.providerToolRules, []);

  const staleHealth = { ...descriptor('health-is-metadata'), health: 'healthy' as const, canExecute: true };
  const copied = await projectAgentExtensionProviderContext({ revisionSeed: 'unknown-health', capabilities: [
    { required: true, choice: { resolve: async () => ({ descriptor: staleHealth, toolCap: ['READ'] }) } },
  ], standalone: [] });
  assert.equal(copied.projection.selectedProviders[0].health, 'unknown');
  assert.equal(copied.projection.selectedProviders[0].canExecute, false);
  staleHealth.displayName = 'Changed after projection';
  assert.equal(copied.projection.selectedProviders[0].displayName, 'health-is-metadata');
  assert(!Object.isFrozen(staleHealth), 'The metadata projection must not freeze a caller-owned provider object.');

  const collision = await projectAgentExtensionProviderContext({ revisionSeed: 'source-collision', capabilities: [
    { required: false, choice: choice('exact-mcp', 'same-ref') },
    { required: true, choice: { resolve: async () => ({ descriptor: descriptor('same-ref', 'composio'), toolCap: null }) } },
  ], standalone: [] });
  assert(collision.projection.unavailable);
  assert.deepEqual(collision.projection.selectedProviders, []);
  console.log('PASS neutral provider metadata projection: lazy callback/required skip order, optional outages, exact-ref cap union, unknown health and immutable non-authority output.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
