import assert from 'node:assert/strict';
import { assertNativeCentralAgentUnchanged, captureNativeCentralAgentSnapshot, projectNativeCentralAgentSnapshot } from './helpers/chat-extension-native-agent-snapshot';

const agentId = 'native-snapshot-agent', workspaceId = 'personal-snapshot-owner';
const response = () => ({ success: true, contractVersion: 2, workspaceId, checkedAt: 1,
  data: { agent: { id: 42, agentId, name: 'Exact Native Agent', revision: 4, workflowVersion: 2, workflowRevision: 3,
    enabledTools: ['read', 'mcp'], defaultProvider: 'owned-sdk', defaultModel: 'controlled-model', updatedAt: '2026-10-15T10:00:00Z' },
  bindings: [{ id: 'binding-original', agentId, resourceType: 'connection', scopeType: 'user', resourceId: 'standalone-canva', name: 'Canva',
    version: 'unversioned', requirement: 'optional', revision: 2 }],
  extensions: { agentId, revision: 4, workflowRevision: 3, configurationState: 'available', configuration: {
    version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null,
    standalone: [{ mode: 'selectable', configurationId: 'canva-slot', source: 'composio', toolkit: 'canva', requirement: 'optional', allowedChoices: [],
      personalPolicy: { source: 'composio', toolkit: 'canva', toolCap: null as string[] | null } }] },
    readiness: [{ readiness: 'personal-connection-required' }], standaloneSummaries: [{ label: 'Choose your connection' }] },
  preferenceRevision: 0, access: { canUse: true, canEdit: true } } });

const original = response(), baseline = captureNativeCentralAgentSnapshot(original, { agentId, workspaceId });
const saved = response(); saved.checkedAt = 2; saved.data.preferenceRevision = 1;
saved.data.extensions.readiness = [{ readiness: 'available' }]; saved.data.extensions.standaloneSummaries = [{ label: 'Own exact account' }];
assertNativeCentralAgentUnchanged(baseline, captureNativeCentralAgentSnapshot(saved, { agentId, workspaceId }));
assert.deepEqual(projectNativeCentralAgentSnapshot(saved.data), baseline, 'The actual Parent inspect projection must equal the Normal-API baseline.');
assert.equal(original.data.preferenceRevision, 0);
assert.equal(original.data.extensions.readiness[0].readiness, 'personal-connection-required');

let rejected = 0;
function changed(label: string, mutate: (value: ReturnType<typeof response>) => void) {
  const value = response(); mutate(value);
  assert.throws(() => assertNativeCentralAgentUnchanged(baseline, captureNativeCentralAgentSnapshot(value, { agentId, workspaceId })), label);
  rejected++;
}
changed('Agent revision changes must fail even with otherwise equal configuration.', value => { value.data.agent.revision++; value.data.extensions.revision++; });
changed('Workflow revision changes must fail even with otherwise equal configuration.', value => { value.data.agent.workflowRevision++; value.data.extensions.workflowRevision++; });
changed('Binding revision changes must fail.', value => { value.data.bindings[0].revision++; });
changed('Binding replacement with the same policy must fail.', value => { value.data.bindings[0].id = 'binding-replaced'; });
changed('Personal-policy changes must fail without any revision bump.', value => { value.data.extensions.configuration.standalone[0].personalPolicy.toolkit = 'shopify'; });
changed('A valid central tool cap change must fail without any revision bump.', value => { value.data.extensions.configuration.standalone[0].personalPolicy.toolCap = ['DESIGN_CREATE']; });
changed('A valid standalone requirement change must fail without any revision bump.', value => { value.data.extensions.configuration.standalone[0].requirement = 'required'; });
changed('Native-tool changes must fail without any revision bump.', value => { value.data.agent.enabledTools.push('write'); });
changed('Model changes must fail without any revision bump.', value => { value.data.agent.defaultModel = 'another-model'; });
changed('Even an otherwise equal central profile rewrite must fail.', value => { value.data.agent.updatedAt = '2026-10-15T10:01:00Z'; });
changed('Mismatched Agent/descriptor revisions must fail.', value => { value.data.extensions.revision++; });
changed('Blocked configuration cannot become an empty success snapshot.', value => { value.data.extensions.configurationState = 'blocked'; });
assert.throws(() => captureNativeCentralAgentSnapshot(response(), { agentId: 'other-agent', workspaceId }));
assert.throws(() => captureNativeCentralAgentSnapshot(response(), { agentId, workspaceId: 'other-workspace' }));
assert.throws(() => captureNativeCentralAgentSnapshot({ ...response(), contractVersion: 1 }, { agentId, workspaceId }));
assert.throws(() => assertNativeCentralAgentUnchanged(baseline, { ...baseline, preferenceRevision: 1 }), 'Persisted snapshots must not silently accept unrelated fields.');
const independent = captureNativeCentralAgentSnapshot(response(), { agentId, workspaceId });
const caller = response(), detached = captureNativeCentralAgentSnapshot(caller, { agentId, workspaceId });
caller.data.agent.name = 'Mutated after capture'; caller.data.extensions.configuration.standalone[0].personalPolicy.toolkit = 'shopify';
caller.data.agent.enabledTools.push('write');
assert.deepEqual(detached, independent, 'Caller mutations must not rewrite the saved before snapshot.');
console.log(`PASS Native central Agent snapshot: Normal-API/Parent identity, personal preference/readiness changes allowed, ${rejected} central changes rejected, exact scope/version and detached baseline.`);
