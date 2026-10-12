import assert from 'node:assert/strict';
import type { AgentWorkflowManagement, AgentWorkflowManagementPackageVersion } from '../app/lib/agents/workflow-management-contracts';
import { AgentWorkflowClientError } from '../app/components/agents/agent-workflow-client';
import { AgentWorkflowManagementClientError, agentWorkflowManagementContextKey, readAgentWorkflowManagement,
  readAgentWorkflowManagementOptions, readAgentWorkflowPackageVersions, saveAgentWorkflowManagement } from '../app/components/agents/agent-workflow-management-client';
import { applyWorkflowPackageVersion, buildAgentWorkflowConfigurationPayload, createAgentWorkflowManagementDraft,
  deriveActiveWorkflowDeclarations, isAgentWorkflowManagementDraftDirty, setWorkflowCapabilitySelection } from '../app/components/agents/agent-workflow-management-draft';

async function main() {
  const resourceRef = 'canvas-resource:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const publishedRevisionRef = 'canvas-package-revision:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const connectionRef = 'canvas-connection:cccccccc-cccc-cccc-cccc-cccccccccccc';
  const checksum = 'a'.repeat(64), retained = { kind: 'retained' as const, retainedBindingRef: `agent-workflow-retain:v1:${'b'.repeat(64)}` };
  const context = { agentId: 'fixture-agent', workspaceId: 'fixture-workspace', projectId: 'fixture-project', organizationId: 'fixture-org', actorId: 'fixture-actor' };
  const snapshot: AgentWorkflowManagement = { schemaVersion: 1, view: 'management', agentId: context.agentId, revision: 7, workflowRevision: 4,
    access: { canUse: false, canEdit: true, canManage: false }, profile: { agentId: context.agentId, name: 'Workflow', iconId: null, scopeType: 'user', enabledTools: null },
    workflowVersion: 1, configurationState: 'available', unavailablePackageCount: 0, unavailableConnectionCount: 0,
    configuration: { version: 1, packages: [{ resourceRef, publishedRevisionRef, checksum, skillSelection: { kind: 'plugin' }, declarations: [
      { declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'design', required: true,
        selection: { mode: 'fixed', alternativeKey: 'composio:canva', toolCap: null, target: retained } }] },
      { declarationPath: 'skills/review/agents/canvas.yaml', capabilities: [{ capabilityId: 'send', required: false,
        selection: { mode: 'selectable', allowedChoices: [{ choiceId: 'central', alternativeKey: 'mcp:review', toolCap: null,
          target: { kind: 'shared', source: 'mcp', connectionRef, bindingRevision: 3, mcpMapping: { kind: 'manager_confirmation' } } }], defaultChoiceId: 'central' } }] },
    ] }] } };
  const version: AgentWorkflowManagementPackageVersion = { schemaVersion: 1, view: 'package-version', agentId: context.agentId, revision: 7, workflowRevision: 4,
    resourceRef, publishedRevisionRef, checksum, kind: 'plugin', name: 'design', version: '1.0.0', skillRoots: [{ name: 'review', relativeRoot: 'skills/review' }], declarations: [
      { declarationPath: '.canvas-plugin/plugin.json', workflow: { version: 1, integrationCapabilities: [{ id: 'design', application: 'canva', required: true,
        alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: ['DESIGN_LIST'] }] }] } },
      { declarationPath: 'skills/review/agents/canvas.yaml', workflow: { version: 1, integrationCapabilities: [{ id: 'send', application: 'slack', required: false,
        alternatives: [{ source: 'mcp', connector: 'review', requiredTools: ['send_message'] }] }] } },
    ] };
  const original = JSON.stringify(snapshot), initial = createAgentWorkflowManagementDraft(snapshot);
  assert.equal(isAgentWorkflowManagementDraftDirty(initial), false);
  assert.deepEqual(buildAgentWorkflowConfigurationPayload(initial), { valid: false, issues: ['no_changes'] });
  let draft = applyWorkflowPackageVersion(initial, version, { kind: 'plugin' });
  const slot = { resourceRef, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'design' };
  draft = setWorkflowCapabilitySelection(draft, slot, { mode: 'fixed', alternativeKey: 'composio:canva', toolCap: ['DESIGN_LIST'], target: retained });
  const built = buildAgentWorkflowConfigurationPayload(draft);
  assert(built.valid); assert.equal(built.input.expectedRevision, 7); assert.equal(built.input.expectedWorkflowRevision, 4);
  assert.deepEqual(built.input.workflow?.packages[0].declarations[0].capabilities[0].selection, { mode: 'fixed', alternativeKey: 'composio:canva', toolCap: ['DESIGN_LIST'], target: retained });
  assert(!Object.hasOwn(built.input, 'enabledTools'), 'Workflow editor must not overwrite independent native tools.');
  assert.equal(JSON.stringify(snapshot), original, 'Pure helpers never mutate the server snapshot.');
  const switched = setWorkflowCapabilitySelection(draft, slot, { mode: 'selectable', allowedChoices: [{ choiceId: 'new', alternativeKey: 'composio:canva', toolCap: null, target: retained }] });
  assert.equal(switched.packages[0].declarations[0].capabilities[0].selection?.mode, 'selectable');
  const switchedSelection = switched.packages[0].declarations[0].capabilities[0].selection;
  assert(switchedSelection?.mode === 'selectable'); assert.equal(switchedSelection.allowedChoices[0].target, null, 'Mode/choice relocation invalidates old retention.');
  assert.equal(buildAgentWorkflowConfigurationPayload(switched).valid, false);
  const differentPin = applyWorkflowPackageVersion(draft, { ...version, publishedRevisionRef: 'canvas-package-revision:dddddddd-dddd-dddd-dddd-dddddddddddd' }, { kind: 'plugin' });
  assert.equal(differentPin.packages[0].declarations[0].capabilities[0].selection, null);
  assert.equal(buildAgentWorkflowConfigurationPayload(differentPin).valid, false, 'New versions must have explicit required targets.');
  const differentDigest = applyWorkflowPackageVersion(draft, { ...version, checksum: 'c'.repeat(64) }, { kind: 'plugin' });
  assert.equal(differentDigest.packages[0].declarations[0].capabilities[0].selection, null, 'Checksum belongs to exact pin identity.');
  const child = applyWorkflowPackageVersion(draft, version, { kind: 'skills', relativeRoots: ['skills/review'] });
  assert.deepEqual(child.packages[0].declarations.map(item => item.declarationPath), ['skills/review/agents/canvas.yaml']);
  assert.equal(buildAgentWorkflowConfigurationPayload(child).valid, true, 'Child-only selection must not require parent capabilities.');
  const definitionBacked = setWorkflowCapabilitySelection(child, { resourceRef, declarationPath: 'skills/review/agents/canvas.yaml', capabilityId: 'send' },
    { mode: 'fixed', alternativeKey: 'mcp:review', toolCap: null, target: { kind: 'shared', source: 'mcp', connectionRef, bindingRevision: 3 } });
  assert.equal(buildAgentWorkflowConfigurationPayload(definitionBacked).valid, true, 'A definition-backed option may omit confirmation; actual current definition authority remains server-side.');
  const malformedApproval = structuredClone(definitionBacked);
  const malformedSelection = malformedApproval.packages[0].declarations[0].capabilities[0].selection;
  assert(malformedSelection?.mode === 'fixed' && malformedSelection.target?.kind === 'shared');
  Object.assign(malformedSelection.target, { mcpMapping: { kind: 'implicit_confirmation' } });
  assert.equal(buildAgentWorkflowConfigurationPayload(malformedApproval).valid, false, 'An explicit malformed mapping is never accepted.');
  assert.deepEqual(deriveActiveWorkflowDeclarations({ ...version, kind: 'skill', skillRoots: [{ name: 'standalone', relativeRoot: '' }],
    declarations: [{ declarationPath: 'agents/canvas.yaml', workflow: { version: 1, integrationCapabilities: [] } }] }, { kind: 'skills', relativeRoots: [''] })
    .map(item => item.declarationPath), ['agents/canvas.yaml']);
  const excludedRequired = setWorkflowCapabilitySelection(draft, slot, { mode: 'fixed', alternativeKey: 'composio:canva', toolCap: [], target: retained });
  assert.equal(buildAgentWorkflowConfigurationPayload(excludedRequired).valid, false, 'Required existence never expands a tool ceiling.');
  const empty = { ...initial, workflowIntent: 'replace' as const, packages: [] };
  const emptyResult = buildAgentWorkflowConfigurationPayload(empty); assert(emptyResult.valid); assert.deepEqual(emptyResult.input.workflow, { version: 1, packages: [] });
  const clearResult = buildAgentWorkflowConfigurationPayload({ ...initial, workflowIntent: 'clear' }); assert(clearResult.valid); assert.equal(clearResult.input.workflow, null);
  assert.equal(buildAgentWorkflowConfigurationPayload({ ...draft, base: { ...snapshot, configurationState: 'blocked', configuration: null } }).valid, false);
  const blocked = createAgentWorkflowManagementDraft({ ...snapshot, configurationState: 'blocked', configuration: null });
  assert.equal(buildAgentWorkflowConfigurationPayload(blocked).valid, false, 'Blocked config is never treated as an editable empty baseline.');
  assert.equal(buildAgentWorkflowConfigurationPayload({ ...blocked, workflowIntent: 'clear' }).valid, true, 'Explicit reset is distinct from an implicit empty baseline.');
  assert.deepEqual(applyWorkflowPackageVersion(initial, { ...version, revision: 8 }, { kind: 'plugin' }), initial, 'Late version DTO cannot rewrite a current draft.');

  const fetchOriginal = globalThis.fetch, requests: Array<{ url: URL; init?: RequestInit }> = [];
  let reply: unknown = snapshot, status = 200;
  globalThis.fetch = async (input, init) => { requests.push({ url: new URL(String(input), 'http://fixture.invalid'), init });
    return new Response(JSON.stringify(status === 200 ? { success: true, data: reply } : { success: false, code: 'AGENT_WORKFLOW_REVISION_CONFLICT', error: 'private-body' }), { status, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const captured = { ...context }, pending = readAgentWorkflowManagement(captured); captured.workspaceId = 'other-workspace';
    assert.deepEqual(await pending, snapshot);
    assert.equal(requests[0].url.searchParams.get('workspaceId'), context.workspaceId);
    assert.equal(requests[0].url.searchParams.get('organizationId'), context.organizationId); assert.equal(requests[0].url.searchParams.get('projectId'), context.projectId);
    assert.equal(requests[0].url.searchParams.has('actorId'), false, 'Local actor delivery key is never an authority field sent to the API.');
    assert.notEqual(agentWorkflowManagementContextKey(context), agentWorkflowManagementContextKey({ ...context, actorId: 'other-actor' }));
    assert.notEqual(agentWorkflowManagementContextKey(context), agentWorkflowManagementContextKey({ ...context, projectId: 'other-project' }));
    reply = { ...snapshot, agentId: 'other-agent' };
    await assert.rejects(() => readAgentWorkflowManagement(context), { code: 'WORKFLOW_REPLY_INVALID' });
    reply = { ...version, revision: 8 };
    await assert.rejects(() => readAgentWorkflowManagementOptions(context, { view: 'package-version', agentId: context.agentId, expectedRevision: 7,
      expectedWorkflowRevision: 4, resourceRef, publishedRevisionRef }), { code: 'WORKFLOW_REPLY_INVALID' });
    reply = { ...version, publishedRevisionRef: 'canvas-package-revision:dddddddd-dddd-dddd-dddd-dddddddddddd' };
    await assert.rejects(() => readAgentWorkflowManagementOptions(context, { view: 'package-version', agentId: context.agentId, expectedRevision: 7,
      expectedWorkflowRevision: 4, resourceRef, publishedRevisionRef }), { code: 'WORKFLOW_REPLY_INVALID' });
    const count = requests.length;
    await assert.rejects(() => readAgentWorkflowManagementOptions(context, { view: 'management', agentId: 'other-agent' }), { code: 'WORKFLOW_CLIENT_INVALID' });
    assert.equal(requests.length, count, 'Mismatched context is rejected before transport.');
    const history = { resourceRef, revisionRef: publishedRevisionRef, checksum, name: 'design', kind: 'plugin', version: '1.0.0',
      publishedAt: 1, publishedByUserId: null, baseRevisionRef: null, fileCount: 4, totalBytes: 100 };
    reply = { versions: [{ ...history, untrustedField: 'discarded' }] };
    assert.deepEqual(await readAgentWorkflowPackageVersions(context, resourceRef), [history]);
    assert.equal(requests.at(-1)!.url.searchParams.get('workspaceId'), context.workspaceId);
    assert(!requests.at(-1)!.url.searchParams.has('actorId'));
    reply = { versions: [{ ...history, resourceRef: 'canvas-resource:eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }] };
    await assert.rejects(() => readAgentWorkflowPackageVersions(context, resourceRef), { code: 'WORKFLOW_REPLY_INVALID' });
    const beforeConflict = requests.length;
    status = 409;
    await assert.rejects(() => saveAgentWorkflowManagement(context, built.input), failure => failure instanceof AgentWorkflowClientError && failure.status === 409 && !failure.message.includes('private-body'));
    assert.equal(requests.length, beforeConflict + 1, 'Conflict makes one request and never retries.');
    status = 200; reply = { agent: { agentId: context.agentId, revision: 8, workflowRevision: 5 }, workflow: { agentId: context.agentId, revision: 8, workflowRevision: 5 } };
    await saveAgentWorkflowManagement(context, built.input);
    const written = requests.at(-1)!; assert.equal(written.url.pathname, '/api/agents');
    assert.deepEqual(JSON.parse(String(written.init?.body)), built.input); assert.equal(written.url.searchParams.get('projectId'), context.projectId);
    reply = { agent: { agentId: context.agentId, revision: 8, workflowRevision: 4 }, workflow: { agentId: context.agentId, revision: 8, workflowRevision: 4 } };
    await saveAgentWorkflowManagement(context, { agentId: context.agentId, expectedRevision: 7, expectedWorkflowRevision: 4, enabledTools: ['__none__'] });
    assert(!Object.hasOwn(JSON.parse(String(requests.at(-1)!.init?.body)), 'workflow'), 'Native-only edit leaves workflow untouched.');
    reply = { agent: { agentId: context.agentId, revision: 8, workflowRevision: 5 }, workflow: { agentId: context.agentId, revision: 9, workflowRevision: 6 } };
    await assert.rejects(() => saveAgentWorkflowManagement(context, built.input), failure => failure instanceof AgentWorkflowManagementClientError && failure.mutationCompleted === true);
    const abort = new AbortController(); abort.abort();
    globalThis.fetch = async (_input, init) => { assert.equal(init?.signal, abort.signal); throw new DOMException('Aborted', 'AbortError'); };
    await assert.rejects(() => readAgentWorkflowManagement(context, abort.signal), { name: 'AbortError' });
  } finally { globalThis.fetch = fetchOriginal; }
  console.log('agent-workflow-management-client-test: PASS (pure exact pin/root/declaration drafts, nullable targets, unchanged/invalidated retention, null tool ceilings, captured context and response CAS, single-request conflicts, native-only omission; controlled HTTP transport only, no authority/SDK/database/browser claims)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
