import assert from 'node:assert/strict';
import { AGENT_FORM_DRAFT_TTL_MS, clearAgentFormDraft, readAgentFormDraft, writeAgentFormDraft } from '../app/components/agents/agent-form-draft-storage';
import { isAgentWorkflowDescriptor } from '../app/components/agents/agent-workflow-descriptor';
import { agentWorkflowChoiceSelection } from '../app/components/agents/agent-workflow-choice-input';
import { readAgentWorkflow, retainWorkflowDrafts, saveAgentWorkflowChoice, workflowSelectionValue } from '../app/components/agents/agent-workflow-client';
import { readAgentExtensionManagement, saveAgentWorkflowManagement } from '../app/components/agents/agent-workflow-management-client';
import type { AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import type { StandaloneExtensionSelection } from '../app/lib/capabilities/extensions/contracts';

const selection: StandaloneExtensionSelection = { kind: 'composio', source: 'composio', toolkit: 'canva',
  target: { kind: 'personal', profileId: 'profile', accountBinding: 'account', accountId: 'second', connectionRef: 'composio-personal:profile:second' } };
const receipt = `cmp_personal_account_${'b'.repeat(43)}`;
const configuration = { version: 1 as const, origin: 'agent_configuration' as const, mode: 'fixed' as const,
  selections: [], workflow: null, standalone: [] };
const context = { agentId: 'ui-client-agent', actorId: 'actor-a', workspaceId: 'workspace-a', organizationId: 'organization-a', projectId: 'project-a' };
function descriptor(): AgentWorkflowDescriptor {
  return { agentId: context.agentId, revision: 4, workflowVersion: 2, workflowRevision: 2, preferenceRevision: 3,
    access: { canUse: true, canEdit: false, canManage: false }, packages: [], standalone: [{
      capabilityKey: `agent-extension:${'c'.repeat(43)}`, source: 'composio', toolkit: 'canva', required: true,
      selectionMode: 'selectable', selectionOrigin: 'stale', selectedChoiceId: null, choices: [],
      personalPolicy: { source: 'composio', toolkit: 'canva', toolCap: ['LIST_DESIGNS'] },
    }] };
}
async function main() {
  const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const scope = { ...context, target: { kind: 'existing' as const, agentId: context.agentId, expectedRevision: 4, expectedWorkflowRevision: 2 } };
  const now = 1_000_000, fields = { name: 'Marketing 🧩', modelOverrideEnabled: true,
    modelDraft: { providerInstallationId: 'provider', providerId: 'openai', modelId: 'model', thinkingLevel: 'max' as const },
    toolsOverrideEnabled: true, customEnabledTools: ['__none__'], fileDrafts: { 'AGENTS.md': 'Plan\nÄnderung 🧩' },
    accountSelectionRef: receipt, extensions: { accountSelectionRef: receipt }, apiKey: 'do-not-persist' };
  assert(writeAgentFormDraft(scope, fields, { storage, now }));
  const restored = readAgentFormDraft(scope, { storage, now }); assert.equal(restored.state, 'ready');
  if (restored.state !== 'ready') throw new Error('Missing form draft');
  assert.equal(restored.fields.modelDraft?.thinkingLevel, 'max'); assert.deepEqual(restored.fields.fileDrafts, fields.fileDrafts);
  assert(!JSON.stringify([...data.values()]).includes(receipt)); assert(!JSON.stringify([...data.values()]).includes('do-not-persist'));
  for (const changed of [{ actorId: 'actor-b' }, { workspaceId: 'workspace-b' }, { organizationId: 'organization-b' }, { projectId: 'project-b' }]) {
    assert.equal(readAgentFormDraft({ ...scope, ...changed }, { storage, now }).state, 'none');
  }
  assert.equal(readAgentFormDraft({ ...scope, target: { ...scope.target, expectedRevision: 5 } }, { storage, now }).state, 'conflict');
  assert.equal(readAgentFormDraft(scope, { storage, now: now + AGENT_FORM_DRAFT_TTL_MS }).state, 'expired'); assert.equal(data.size, 0);
  assert(!writeAgentFormDraft({ ...scope, actorId: null }, fields, { storage, now }));
  assert(!writeAgentFormDraft(scope, { ...fields, fileDrafts: { 'AGENTS.md': 'x'.repeat(65_537) } }, { storage, now }));
  assert(writeAgentFormDraft(scope, fields, { storage, now }));
  const key = [...data.keys()][0]; data.set(key, '{broken'); assert.equal(readAgentFormDraft(scope, { storage, now }).state, 'invalid');
  assert.equal(data.size, 0);
  assert(writeAgentFormDraft(scope, fields, { storage, now: now + 400_000 })); assert.equal(readAgentFormDraft(scope, { storage, now }).state, 'invalid');
  assert(writeAgentFormDraft(scope, fields, { storage, now }));
  clearAgentFormDraft({ ...scope, actorId: 'actor-b' }, { storage }); assert.equal(data.size, 1);
  clearAgentFormDraft(scope, { storage }); assert.equal(data.size, 0);
  const deniedStorage = { ...storage, setItem: () => { throw new Error('disabled'); } };
  assert(!writeAgentFormDraft(scope, fields, { storage: deniedStorage, now }));

  const view = descriptor(); assert(isAgentWorkflowDescriptor(view, context.agentId));
  assert(!isAgentWorkflowDescriptor({ ...view, workflowVersion: 1 }, context.agentId));
  assert(!isAgentWorkflowDescriptor({ ...view, standalone: [{ ...view.standalone![0], personalPolicy: { source: 'mcp', serverDefinitionIds: ['invented'], toolCap: null } }] }, context.agentId));
  assert(!isAgentWorkflowDescriptor({ ...view, standalone: [view.standalone![0], view.standalone![0]] }, context.agentId));
  const slot = view.standalone![0]; assert.equal(workflowSelectionValue(slot), 'unavailable');
  assert.deepEqual(retainWorkflowDrafts({}, view), { [slot.capabilityKey]: 'unavailable' });
  const input = agentWorkflowChoiceSelection(slot, { selection, accountSelectionRef: receipt, label: 'Second account' });
  assert.deepEqual(input, { standaloneSelection: { selection, requirement: 'required', toolCap: ['LIST_DESIGNS'], accountSelectionRef: receipt } });
  assert.throws(() => agentWorkflowChoiceSelection({ ...slot, personalPolicy: undefined }, { selection, accountSelectionRef: receipt, label: 'Second' }));
  assert.throws(() => agentWorkflowChoiceSelection(slot, { selection, choiceId: 'unlisted', label: 'Spoofed' }));

  const fetchOriginal = globalThis.fetch, requests: Array<{ url: URL; body: Record<string, unknown> | null }> = [];
  let reply: unknown = view;
  globalThis.fetch = async (url, init) => { requests.push({ url: new URL(String(url), 'http://test.invalid'),
    body: init?.body ? JSON.parse(String(init.body)) : null }); return Response.json({ success: true, data: reply }); };
  try {
    assert.deepEqual(await readAgentWorkflow(context.agentId, context), view);
    assert(!requests.at(-1)!.url.searchParams.has('actorId')); assert.equal(requests.at(-1)!.url.searchParams.get('projectId'), context.projectId);
    reply = { ...view, preferenceRevision: 4 };
    await saveAgentWorkflowChoice({ agentId: context.agentId, context, capabilityKey: slot.capabilityKey,
      expectedWorkflowRevision: 2, expectedPreferenceRevision: 3, ...input });
    assert.deepEqual(requests.at(-1)!.body?.standaloneSelection, 'standaloneSelection' in input ? input.standaloneSelection : undefined);
    reply = { agent: { agentId: context.agentId, revision: 4, workflowRevision: 2 }, access: { canUse: false, canEdit: true, canManage: false },
      extensions: { agentId: context.agentId, revision: 4, workflowRevision: 2, configurationState: 'available', configuration, readiness: [] } };
    assert.deepEqual((await readAgentExtensionManagement(context)).extensions.configuration, configuration);
    assert.equal(requests.at(-1)!.url.searchParams.get('purpose'), 'configure');
    reply = { agent: { agentId: context.agentId, revision: 5, workflowRevision: 3 }, workflow: { agentId: context.agentId, revision: 5, workflowRevision: 3 } };
    await saveAgentWorkflowManagement(context, { agentId: context.agentId, expectedRevision: 4, expectedWorkflowRevision: 2, extensions: configuration });
    assert.deepEqual(requests.at(-1)!.body?.extensions, configuration); assert(!Object.hasOwn(requests.at(-1)!.body!, 'workflow'));
    const count = requests.length;
    await assert.rejects(() => saveAgentWorkflowManagement(context, { agentId: context.agentId, expectedRevision: 4,
      expectedWorkflowRevision: 2, extensions: configuration, workflow: null })); assert.equal(requests.length, count);
  } finally { globalThis.fetch = fetchOriginal; }
  console.log('agent-extension-ui-clients-test: PASS (scoped draft recovery/max thinking/CAS/expiry/receipt exclusion; full V2 descriptor, standalone choice and genuine configure-inspect/complete-update DTOs; controlled HTTP, no authority/browser/provider claim)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
