import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module from 'node:module';
import type { AgentWorkflowInternalSnapshot, StoredAgentWorkflowPackage } from '../app/lib/agents/workflow-contracts';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { IntegrationExecutionContext, IntegrationProviderDescriptor } from '../app/lib/integration-tools/contracts';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';
import { createStandaloneExtensionSlotRef } from '../app/lib/capabilities/extensions/standalone-reference';
import { parseStoredStandaloneExtensionBinding } from '../app/lib/capabilities/extensions/stored-contracts';
import type { StoredStandaloneExtensionBinding } from '../app/lib/capabilities/extensions/stored-contracts';
import type { HeldAcceptedTurnRuntimeSelection } from '../app/lib/capabilities/extensions/turn-runtime';
import type { HeldAgentWorkflowPackageTurnFocus } from '../app/lib/agents/workflow-runtime';
import { extensionSelectionIdentity } from '../app/lib/capabilities/extensions/contracts';

// Control-flow regression around the actual codecs/projection/provenance code.
// SQL/provider authority boundaries are controlled here; a separate native
// PostgreSQL reader test checks the real agent/session/grants and source stores.
const context = { userId: 'alice', sessionId: 'session-alice', agentId: 'standalone-agent', workspaceId: 'team',
  workspaceType: 'team', workspaceName: 'Team', organizationId: 'org', projectId: null, customerId: null,
  workspaceRoot: '/fixture/team', workspaceRootRelativePath: 'team', canWrite: true, canDelete: true, canShare: false,
  legacy: false } as AgentExecutionContext;
const key = (value: AgentExecutionContext) => JSON.stringify([value.userId, value.organizationId, value.workspaceId, value.agentId, value.sessionId, value.projectId]);
const execution = (): IntegrationExecutionContext => ({ actorUserId: context.userId, organizationId: context.organizationId,
  workspaceId: context.workspaceId, agentId: context.agentId, sessionId: context.sessionId, policyRevision: 'unit-actual-call' });
const uuid = '11111111-1111-4111-8111-111111111111';
const secondUuid = '22222222-2222-4222-8222-222222222222';
const definitionId = '33333333-3333-4333-8333-333333333333';
const sharedRef = `canvas-connection:${uuid}`;
const secondRef = `canvas-connection:${secondUuid}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicShared = (source: 'mcp' | 'composio', ref = sharedRef) => source === 'mcp'
  ? { kind: 'mcp', source, target: { kind: 'shared', connectionRef: ref, bindingRevision: 2 } }
  : { kind: 'composio', source, toolkit: 'canva', target: { kind: 'shared', connectionRef: ref, bindingRevision: 2 } };
const sharedTarget = (source: 'mcp' | 'composio', ref = sharedRef) => ({ kind: 'shared', source, connectionRef: ref, bindingRevision: 2 });
const fixed = (source: 'mcp' | 'composio' = 'mcp', cap: string[] | null = null, requirement = 'required', ref = sharedRef, id = 'fixed-slot') =>
  parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: id, mode: 'fixed', entry: {
    selection: publicShared(source, ref), target: sharedTarget(source, ref), requirement, toolCap: cap } });
const selectable = () => parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: 'choice-slot',
  mode: 'selectable', source: 'mcp', requirement: 'required', defaultChoiceId: 'a', allowedChoices: [
    { choiceId: 'a', selection: publicShared('mcp'), target: sharedTarget('mcp'), toolCap: ['READ'] },
    { choiceId: 'b', selection: publicShared('mcp', secondRef), target: sharedTarget('mcp', secondRef), toolCap: [] },
  ], personalPolicy: { source: 'mcp', serverDefinitionIds: [definitionId], toolCap: ['OWN_READ'] } });
function personal(noAuth = false) {
  const binding = { source: 'composio' as const, ownerUserId: 'alice', profileId: 'profile-alice', toolkit: 'canva', mode: 'managed' as const,
    accountBinding: noAuth ? 'no_auth' as const : 'account' as const, connectedAccountId: noAuth ? null : 'ca-alice' };
  const target = { kind: 'personal' as const, source: 'composio' as const, ownerUserId: 'alice', personalBinding: binding,
    providerRef: createIntegrationProviderRef({ source: 'composio', profileId: binding.profileId, toolkit: 'canva',
      scope: { type: 'user', ownerUserId: 'alice', resourceId: 'profile:profile-alice:canva' } }),
    boundProviderRef: `composio:v1:personal:${hash(binding)}`, bindingFingerprint: 'a'.repeat(64) };
  const selection = noAuth ? { kind: 'composio', source: 'composio', toolkit: 'canva', target: {
    kind: 'personal', profileId: 'profile-alice', accountBinding: 'no_auth' } }
    : { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: 'profile-alice',
      accountBinding: 'account', accountId: 'ca-alice', connectionRef: 'composio-personal:profile-alice:ca-alice' } };
  return parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: 'personal-slot', mode: 'fixed',
    entry: { selection, target, toolCap: null, requirement: 'required' } });
}
function snapshot(configurations = [fixed()], scopeType = 'user'): AgentWorkflowInternalSnapshot {
  return { agent: { agentId: context.agentId, scopeType, revision: 5 }, workflowVersion: 2, workflowRevision: 3,
    preferenceRevision: 1, choices: {}, access: { canUse: true, canEdit: false, canManage: false }, bindings: configurations.map(config => {
      const source = config.mode === 'fixed' ? config.entry.selection.source : config.source;
      const toolkit = config.mode === 'fixed' ? config.entry.selection.kind === 'composio' ? config.entry.selection.toolkit : undefined : config.toolkit;
      return { resourceType: 'connection', configuration: null, standaloneConfiguration: config, extensionFormatVersion: 2,
        resourceId: createStandaloneExtensionSlotRef({ configurationId: config.configurationId, source, ...(toolkit ? { toolkit } : {}) }) };
    }) } as unknown as AgentWorkflowInternalSnapshot;
}
type Selection = { workflowVersion: 1 | 2 | null; workflowRevision: number; fingerprint: string;
  packages: unknown[]; snapshot: AgentWorkflowInternalSnapshot };
const issued = new WeakMap<object, string>();
const issuedTurns = new WeakMap<object, { namespace: string; privateFixedBindings: StoredStandaloneExtensionBinding[] }>();
// The aggregate package issuer is a controlled boundary in this slot test.
// Root's aggregate/native suite verifies its actual source compilation proof.
const issuedPackageFocus = new WeakMap<object, { selection: object; turn: object; namespace: string; identities: readonly string[] }>();
const turnKey = () => JSON.stringify([key(context), context.agentTurnId ?? null, context.turnExtensions ?? null]);
function issueTurn(bindings: StoredStandaloneExtensionBinding[]): HeldAcceptedTurnRuntimeSelection {
  if (bindings.some(binding => binding.mode !== 'fixed')) throw new Error('fixed turn fixture');
  context.agentTurnId = 'actual-controlled-turn';
  context.turnExtensions = { version: 1, origin: 'turn_reference', selections: bindings.map(binding => {
    if (binding.mode !== 'fixed') throw new Error('fixed turn fixture');
    return { selection: binding.entry.selection, requirement: binding.entry.requirement, toolCap: binding.entry.toolCap };
  }) };
  const handle = Object.freeze({ kind: 'accepted_turn_runtime_selection' as const, fingerprint: hash(context.turnExtensions) });
  issuedTurns.set(handle, { namespace: turnKey(), privateFixedBindings: bindings });
  return handle;
}
function issuePackageFocus(selection: object, turn: HeldAcceptedTurnRuntimeSelection,
  identities: readonly string[]): HeldAgentWorkflowPackageTurnFocus {
  const handle = Object.freeze({ kind: 'workflow_package_turn_focus' as const });
  issuedPackageFocus.set(handle, { selection, turn, namespace: turnKey(), identities: Object.freeze([...identities]) });
  return handle;
}
let currentSelection: Selection;
function issueSelection(value: AgentWorkflowInternalSnapshot, packages: unknown[] = []): Selection {
  const selection = { workflowVersion: value.workflowVersion, workflowRevision: value.workflowRevision, fingerprint: 'unit-source-fingerprint', packages, snapshot: value };
  issued.set(selection, key(context)); currentSelection = selection; return selection;
}
let source: 'mcp' | 'composio' = 'mcp', bindingRevision = 2, canUse = true, readable = true;
let allowed: string[] | null = ['READ', 'WRITE'], runtimeExecutable = true;
let metadataReads = 0, providerResolutions = 0, toolEnumerations = 0, personalReads = 0;
const authorizations = new WeakSet<object>();
type Actor = { userId: string; organizationId?: string | null; workspaceId?: string | null; agentId?: string | null;
  sessionId?: string | null; policyRevision?: string };
function sharedAuthorization(actor: Actor, reference: string, operation = 'inspect') {
  metadataReads += 1;
  if (!readable || reference !== sharedRef && reference !== secondRef) throw new Error('denied fixture source');
  const value = { actor, operation, resource: { connectionRef: reference, source, status: 'active', bindingRevision, application: source === 'composio' ? 'canva' : null,
    displayName: 'Actual configured source', ownership: { type: 'organization', organizationId: 'org' }, metadataRevision: 1, grantsRevision: 1,
    allowedToolNames: allowed }, backend: source === 'mcp' ? { source, connectionId: uuid }
    : { source, profileId: 'private-shared-profile', toolkit: 'canva', mode: 'managed', accountBinding: 'no_auth', connectedAccountId: null },
    access: { canRead: true, canUse, canManage: false }, allowedToolNames: allowed, authorizationRevision: hash([source, bindingRevision, allowed, canUse]) };
  authorizations.add(value); return value;
}
const personalProofs = new WeakMap<object, { binding: Record<string, unknown>;
  boundProviderRef: string; baseProviderRef: string; bindingFingerprint: string; descriptor: IntegrationProviderDescriptor }>();
const attachments = new WeakMap<object, Map<string, IntegrationProviderDescriptor>>();
const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
const original = loader._load;
loader._load = (name, parent, isMain) => {
  if (name === 'server-only') return {};
  if (name === '@/app/lib/agents/workflow-runtime' || /\/agents\/workflow-runtime(?:\.ts)?$/u.test(name)) {
    const actual = original(name, parent, isMain) as Record<string, unknown>;
    return { ...actual, readAgentWorkflowPackageTurnFocus: (handle: object, actualContext: AgentExecutionContext, selection: object, turn: object) => {
      const focus = issuedPackageFocus.get(handle);
      if (!focus || focus.selection !== selection || focus.turn !== turn || focus.namespace !== turnKey() || actualContext !== context) {
        throw Object.assign(new Error('controlled package focus proof denied'), { code: 'provider_denied' });
      }
      return focus.identities;
    } };
  }
  if (name === './turn-runtime' || /\/extensions\/turn-runtime(?:\.ts)?$/u.test(name)) return {
    readAcceptedTurnRuntimeSelection: (handle: object, actualContext: AgentExecutionContext, selection: object) => {
      const turn = issuedTurns.get(handle);
      if (!turn || turn.namespace !== turnKey() || actualContext !== context || issued.get(selection) !== key(context)) {
        throw Object.assign(new Error('controlled issued turn denied'), { code: 'provider_denied' });
      }
      return { publicSelection: context.turnExtensions, privateFixedBindings: turn.privateFixedBindings };
    },
  };
  if (name === '@/app/lib/capabilities/packages/runtime-bindings' || /\/capabilities\/packages\/runtime-bindings(?:\.ts)?$/u.test(name)) return {
    isAuthorizedAgentWorkflowPackageSelections: (value: object, actualContext: AgentExecutionContext) => issued.get(value) === key(actualContext),
    getAuthorizedAgentWorkflowPackageSelections: async () => currentSelection,
    // Controlled held metadata for this existing projection fixture. Actual
    // published parent/child declarations are covered by the native suite.
    getAuthorizedAgentWorkflowPackageMetadata: (selection: Selection, actualContext: AgentExecutionContext) => {
      assert.equal(issued.get(selection), key(actualContext));
      return selection.packages.map(value => {
        const pkg = value as StoredAgentWorkflowPackage;
        return { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum,
          declarations: pkg.declarations.map(declaration => ({ declarationPath: declaration.declarationPath,
            capabilities: declaration.capabilities.map(capability => ({ id: capability.capabilityId, application: capability.application,
              required: capability.required, alternatives: capability.alternatives })) })) };
      });
    },
  };
  if (name === './workflow-runtime-mode' || name === '@/app/lib/agents/workflow-runtime-mode' || /\/agents\/workflow-runtime-mode(?:\.ts)?$/u.test(name)) return {
    getRuntimeAgentWorkflowMode: async () => currentSelection.workflowVersion,
    agentWorkflowRuntimeActor: (actualContext: AgentExecutionContext) => ({ userId: actualContext.userId, sourceAgentId: actualContext.agentId,
      sessionId: actualContext.sessionId, organizationId: actualContext.organizationId, workspaceId: actualContext.workspaceId, projectId: actualContext.projectId }),
  };
  if (name === '@/app/lib/integration-tools/connections/store' || name === './store' || /\/integration-tools\/connections\/store(?:\.ts)?$/u.test(name)) return {
    isAuthorizedIntegrationConnection: (value: object) => authorizations.has(value),
    authorizeIntegrationConnection: async (actor: Actor, ref: string, operation: string) => sharedAuthorization(actor, ref, operation),
    revalidateAuthorizedIntegrationConnection: async (value: ReturnType<typeof sharedAuthorization>, operation: string) => {
      assert(authorizations.has(value)); const actual = sharedAuthorization(value.actor, value.resource.connectionRef, operation);
      if (actual.authorizationRevision !== value.authorizationRevision) throw new Error('binding changed'); return actual;
    },
    getIntegrationConnectionRecord: async (ref: string) => sharedAuthorization({ userId: 'alice' }, ref),
  };
  if (name === './workflow-configuration' || /\/agents\/workflow-configuration(?:\.ts)?$/u.test(name)) return {
    getSelectedAgentWorkflowCapability: (_snapshot: unknown, _pkg: unknown, _declaration: unknown, capability: {selection: unknown}) => capability.selection,
  };
  if (name === '@/app/lib/integration-tools/workflow-personal-bindings' || /\/integration-tools\/workflow-personal-bindings(?:\.ts)?$/u.test(name)) return {
    verifyStoredPersonalWorkflowProviderTarget: async ({ actor, target }: { actor: Actor; target: {
      binding: Record<string, unknown>; baseProviderRef: string; boundProviderRef: string; bindingFingerprint: string } }, options: {checkProviderReadiness: boolean}) => {
      personalReads += 1; assert.equal(options.checkProviderReadiness, false); assert.equal(target.binding.ownerUserId, actor.userId);
      const proof = Object.freeze({ kind: 'prepared_personal_workflow_provider_target', source: target.binding.source, boundProviderRef: target.boundProviderRef });
      const descriptor = { providerRef: target.boundProviderRef, source: target.binding.source, application: target.binding.toolkit, displayName: 'Owned profile',
        scope: { type: 'user', ownerUserId: actor.userId, resourceId: target.boundProviderRef }, configured: true, state: 'unknown', requiresAuth: 'unknown',
        authorized: 'unknown', health: 'unknown', canExecute: false, checkedAt: null, statusSource: 'configuration',
        pluginRefs: [], skillRefs: [], nextActions: [], matchReasons: [] } as IntegrationProviderDescriptor;
      personalProofs.set(proof, { ...target, descriptor }); return proof;
    },
    getPreparedPersonalWorkflowProviderTarget: (proof: object) => { const value = personalProofs.get(proof); assert(value); return value; },
    attachPersonalWorkflowProviderTargets: (actualContext: object, proofs: object[]) => {
      const values = new Map<string, IntegrationProviderDescriptor>();
      for (const proof of proofs) { const value = personalProofs.get(proof); assert(value); values.set(value.boundProviderRef, value.descriptor); }
      attachments.set(actualContext, values);
    },
  };
  if (name === '@/app/lib/integration-tools/workflow-personal-provenance' || /\/integration-tools\/workflow-personal-provenance(?:\.ts)?$/u.test(name)) return {
    getAttachedPersonalWorkflowProviderDescriptor: (actualContext: object, ref: string) => attachments.get(actualContext)?.get(ref) ?? null,
  };
  if (name === '@/app/lib/integration-tools/adapters/mcp-runtime' || name === '@/app/lib/integration-tools/adapters/composio-runtime'
    || /\/integration-tools\/adapters\/(?:mcp|composio)-runtime(?:\.ts)?$/u.test(name)) return {
    mcpIntegrationToolAdapter: adapter, composioIntegrationToolAdapter: adapter,
  };
  return original(name, parent, isMain);
};
const adapter = {
  resolveProvider: async (actualContext: IntegrationExecutionContext, ref: string) => {
    providerResolutions += 1;
    const authorization = sharedAuthorization({ userId: actualContext.actorUserId, organizationId: actualContext.organizationId,
      workspaceId: actualContext.workspaceId, agentId: actualContext.agentId, sessionId: actualContext.sessionId, policyRevision: actualContext.policyRevision }, sharedRef);
    const {createSharedIntegrationPolicyDescriptor} = await import('../app/lib/integration-tools/connections/provider-policy');
    const descriptor = await createSharedIntegrationPolicyDescriptor(actualContext, authorization as unknown as Parameters<typeof createSharedIntegrationPolicyDescriptor>[1]);
    assert.equal(descriptor.providerRef, ref); descriptor.canExecute = runtimeExecutable;
    return {provider: descriptor};
  },
  listTools: async () => { toolEnumerations += 1; throw new Error('Standalone readiness cannot enumerate tools.'); },
};

async function main() {
  try {
    const standalone = await import('../app/lib/capabilities/extensions/standalone-runtime');
    const runtime = await import('../app/lib/agents/workflow-runtime');
    const {intersectIntegrationPolicies,integrationPolicyAllowedToolNames} = await import('../app/lib/integration-tools/policy');
    const config = selectable(), own = snapshot([config]);
    const slotRef = createStandaloneExtensionSlotRef({configurationId: config.configurationId, source: 'mcp'});
    assert.equal(standalone.selectAgentStandaloneExtension(config, own, 'alice').origin, 'default');
    own.choices[slotRef] = {workflowRevision: 2, choiceId: 'b'};
    assert.equal(standalone.selectAgentStandaloneExtension(config, own, 'alice').choice, null, 'A stale choice never falls back to the configured default.');
    own.choices[slotRef] = {workflowRevision: 3, choiceId: 'missing'};
    assert.equal(standalone.selectAgentStandaloneExtension(config, own, 'alice').origin, 'stale');
    own.choices[slotRef] = {workflowRevision: 3, choiceId: 'b'};
    assert.deepEqual(standalone.selectAgentStandaloneExtension(config, own, 'alice').choice?.toolCap, []);
    const fixedSelection = standalone.selectAgentStandaloneExtension(fixed(), own, 'alice');
    assert.equal(fixedSelection.origin, 'fixed'); assert.equal(fixedSelection.choice?.toolCap, null);
    assert.notEqual(fixedSelection.slotRef, slotRef);
    assert(Object.isFrozen(fixedSelection));
    const person = personal(true);
    assert(standalone.selectAgentStandaloneExtension(person, snapshot([person]), 'alice').choice);
    assert.equal(standalone.selectAgentStandaloneExtension(person, snapshot([person]), 'bob').choice, null, 'No account from another user is substituted.');
    assert.equal(standalone.selectAgentStandaloneExtension(person, snapshot([person], 'organization'), 'alice').choice, null, 'Organization configuration cannot embed the creator’s private account.');
    if (person.mode !== 'fixed' || person.entry.target.kind !== 'personal') throw new Error('personal fixture');
    const ownPolicy = parseStoredStandaloneExtensionBinding({version: 1,kind: 'standalone',configurationId:'own-canva-policy',mode:'selectable',source:'composio',toolkit:'canva',
      requirement:'required',allowedChoices:[],personalPolicy:{source:'composio',toolkit:'canva',toolCap:[]}});
    const ownPolicySnapshot = snapshot([ownPolicy], 'organization');
    const ownSlot = createStandaloneExtensionSlotRef({configurationId: ownPolicy.configurationId,source:'composio',toolkit:'canva'});
    ownPolicySnapshot.choices[ownSlot] = {workflowRevision:3,personalTarget:person.entry.target,standaloneSelection:person.entry.selection};
    assert.equal(standalone.selectAgentStandaloneExtension(ownPolicy, ownPolicySnapshot, 'alice').origin,'user');
    assert.deepEqual(standalone.selectAgentStandaloneExtension(ownPolicy, ownPolicySnapshot, 'alice').choice?.toolCap,[]);
    ownPolicySnapshot.choices[ownSlot] = {workflowRevision:3,personalTarget:person.entry.target};
    assert.equal(standalone.selectAgentStandaloneExtension(ownPolicy, ownPolicySnapshot, 'alice').choice,null,'Private preferences also require the exact public identity.');
    ownPolicySnapshot.choices[ownSlot] = {workflowRevision:3,personalTarget:person.entry.target,
      standaloneSelection:{kind:'composio',source:'composio',toolkit:'canva',target:{kind:'personal',profileId:'profile-alice',
        accountBinding:'account',accountId:'ca-other',connectionRef:'composio-personal:profile-alice:ca-other'}}};
    assert.equal(standalone.selectAgentStandaloneExtension(ownPolicy,ownPolicySnapshot,'alice').choice,null,
      'A different account cannot replace an explicitly stored no-auth choice.');
    const approvedBinding={source:'mcp' as const,ownerUserId:'alice',connectionId:uuid,serverDefinitionId:definitionId};
    const approvedTarget={kind:'personal' as const,source:'mcp' as const,ownerUserId:'alice',personalBinding:approvedBinding,
      providerRef:createIntegrationProviderRef({source:'mcp',connectionId:uuid,scope:{type:'user',ownerUserId:'alice',resourceId:uuid}}),
      boundProviderRef:`mcp:v1:personal:${hash(approvedBinding)}`,bindingFingerprint:'b'.repeat(64)};
    const approvedSnapshot=snapshot([config],'organization');
    approvedSnapshot.choices[slotRef]={workflowRevision:3,personalTarget:approvedTarget,
      standaloneSelection:{kind:'mcp',source:'mcp',target:{kind:'personal',connectionRef:`mcp-personal:${uuid}`}}};
    assert.equal(standalone.selectAgentStandaloneExtension(config,approvedSnapshot,'alice').origin,'user');
    assert.deepEqual(standalone.selectAgentStandaloneExtension(config,approvedSnapshot,'alice').choice?.toolCap,['OWN_READ']);
    const unapprovedBinding={...approvedBinding,serverDefinitionId:secondUuid};
    approvedSnapshot.choices[slotRef].personalTarget={...approvedTarget,personalBinding:unapprovedBinding,
      boundProviderRef:`mcp:v1:personal:${hash(unapprovedBinding)}`};
    assert.equal(standalone.selectAgentStandaloneExtension(config,approvedSnapshot,'alice').choice,null,
      'An actual different MCP definition is outside the configured per-user approved set, without default fallback.');

    const selection = issueSelection(snapshot([fixed('mcp',[])]));
    let projection = await runtime.resolveAgentWorkflowRuntimeProjection(context,{packageSelection:selection as never}); assert(projection);
    assert.equal(providerResolutions,0); assert.equal(toolEnumerations,0);
    assert.deepEqual(projection.policy.providerToolRules?.[0].allowedToolNames,[]);
    assert(!projection.policy.providerToolRules?.[0].allowedOperations?.includes('call'));
    assert.equal(projection.selectedProviders[0].authorized,'unknown'); assert.equal(projection.selectedProviders[0].canExecute,false);
    assert.equal(projection.standaloneSelections[0].state,'selected'); assert.equal(projection.unavailable,false);
    assert(Object.isFrozen(projection.selectedProviders[0]));
    await assert.rejects(()=>runtime.resolveAgentWorkflowRuntimeProjection(context,{packageSelection:structuredClone(selection) as never}),{code:'provider_denied'});
    await assert.rejects(()=>runtime.resolveAgentWorkflowRuntimeProjection({...context,userId:'bob'},{packageSelection:selection as never}),{code:'provider_denied'});
    assert.throws(()=>runtime.attachAgentWorkflowRuntimeProjection(execution(),structuredClone(projection)),{code:'provider_denied'});
    const actualContext = execution(); runtime.attachAgentWorkflowRuntimeProjection(actualContext,projection);
    await runtime.assertAgentWorkflowRuntimeReady({context:actualContext,policy:projection.policy,projection});
    assert.equal(providerResolutions,1,'Actual-call readiness checks the exact provider even for a no-action cap.'); assert.equal(toolEnumerations,0);
    runtimeExecutable=false;
    await assert.rejects(()=>runtime.assertAgentWorkflowRuntimeReady({context:actualContext,policy:projection!.policy,projection}),{code:'provider_denied'});
    runtimeExecutable=true;
    const deniedCeiling=intersectIntegrationPolicies(projection.policy,{allowedSources:[],allowedProviderRefs:null,allowedApplications:null,allowedToolNames:null,allowedOperations:null});
    const priorProviderCalls=providerResolutions;
    await assert.rejects(()=>runtime.assertAgentWorkflowRuntimeReady({context:actualContext,policy:deniedCeiling,projection}),{code:'provider_denied'});
    assert.equal(providerResolutions,priorProviderCalls,'A denied source is not restored by readiness.');
    const compilationProbeBaseline=providerResolutions;

    bindingRevision=3;
    projection=await runtime.resolveAgentWorkflowRuntimeProjection(context,{packageSelection:selection as never}); assert(projection);
    assert.equal(projection.unavailable,true); assert.deepEqual(projection.policy.providerToolRules,[]);
    bindingRevision=2; canUse=false;
    projection=await runtime.resolveAgentWorkflowRuntimeProjection(context,{packageSelection:selection as never}); assert(projection);
    assert.equal(projection.unavailable,true,'Readability without Use never authorizes the selected connection.');
    canUse=true; source='composio';
    projection=await runtime.resolveAgentWorkflowRuntimeProjection(context,{packageSelection:selection as never}); assert(projection);
    assert.equal(projection.unavailable,true,'A replaced source never keeps an MCP selection available.');
    source='mcp';
    const stale=snapshot([selectable()]); stale.choices[slotRef]={workflowRevision:2,choiceId:'b'};
    const staleSelection=issueSelection(stale); const beforeReads=metadataReads;
    projection=await runtime.resolveAgentWorkflowRuntimeProjection(context,{packageSelection:staleSelection as never}); assert(projection);
    assert.equal(projection.unavailable,true); assert.equal(metadataReads,beforeReads,'Known missing required choices close external grants before unrelated source reads.');
    const optional=issueSelection(snapshot([fixed('mcp',['READ'],'optional')])); readable=false;
    projection=await runtime.resolveAgentWorkflowRuntimeProjection(context,{packageSelection:optional as never}); assert(projection);
    assert.equal(projection.unavailable,false); assert.equal(projection.standaloneSelections[0].state,'unavailable'); readable=true;

    source='composio'; allowed=['READ','WRITE'];
    const pkg={resourceRef:`canvas-resource:${uuid}`,selectedSkills:[],declarations:[{declarationPath:'.canvas-plugin/plugin.json',capabilities:[{
      capabilityId:'design',application:'canva',required:false,alternatives:[{source:'composio',toolkit:'canva'}],
      selection:{mode:'fixed',alternativeKey:'composio:canva',target:sharedTarget('composio'),toolCap:['READ']}}]}]};
    const combined=issueSelection(snapshot([fixed('composio',['WRITE'],'optional')]),[pkg]);
    projection=await runtime.resolveAgentWorkflowRuntimeProjection(context,{packageSelection:combined as never}); assert(projection);
    assert.deepEqual(projection.policy.providerToolRules?.[0].allowedToolNames,['READ','WRITE'],'Independent selected caps union only on the same exact provider.');
    const restrictive=intersectIntegrationPolicies(projection.policy,{allowedSources:null,allowedProviderRefs:null,allowedApplications:null,allowedToolNames:['READ'],allowedOperations:null});
    assert.deepEqual(integrationPolicyAllowedToolNames(restrictive,'composio',projection.policy.providerToolRules![0].providerRef),['READ'],
      'Effective policy caps continue to intersect the compiled same-provider union.');
    const ownSelection=issueSelection(snapshot([person]));
    projection=await runtime.resolveAgentWorkflowRuntimeProjection(context,{packageSelection:ownSelection as never}); assert(projection);
    assert.equal(personalReads,1); assert.equal(projection.selectedProviders[0].state,'unknown');
    assert(!JSON.stringify(projection).includes('bindingFingerprint')); assert(!JSON.stringify(projection).includes('private-shared-profile'));
    assert.equal(toolEnumerations,0); assert.equal(providerResolutions,compilationProbeBaseline,
      'Subsequent source/account/configuration projections also perform no live provider resolution.');

    source = 'mcp'; allowed = ['READ', 'WRITE'];
    const focusConfig = parseStoredStandaloneExtensionBinding({ ...selectable(), allowedChoices: [
      { choiceId: 'a', selection: publicShared('mcp'), target: sharedTarget('mcp'), toolCap: ['READ'] },
      { choiceId: 'b', selection: publicShared('mcp', secondRef), target: sharedTarget('mcp', secondRef), toolCap: ['WRITE'] },
    ] });
    const focusSnapshot = snapshot([focusConfig]);
    focusSnapshot.choices[slotRef] = { workflowRevision: 3, choiceId: 'a' };
    const unchangedPreferences = JSON.stringify(focusSnapshot.choices);
    const turnB = issueTurn([fixed('mcp', ['WRITE', 'OTHER'], 'optional', secondRef, 'turn-slot')]);
    const focusSelection = issueSelection(focusSnapshot);
    let turnProjection = await standalone.resolveAgentStandaloneRuntimeProviders(context, focusSelection as never, { turnSource: turnB });
    assert.equal(turnProjection.providers.length, 1);
    assert.equal(turnProjection.selections[0].origin, 'turn');
    assert.equal(turnProjection.selections[0].required, true, 'A turn cannot downgrade a permanent required slot.');
    assert.equal(turnProjection.selections[0].selection?.target.kind, 'shared');
    assert.deepEqual(turnProjection.providers[0].toolCap, ['WRITE'], 'Turn and exact stored B cap intersect.');
    assert.equal(JSON.stringify(focusSnapshot.choices), unchangedPreferences, 'Temporary B never changes the saved A preference.');
    if (turnProjection.selections[0].selection?.target.kind !== 'shared') throw new Error('exact B fixture');
    assert.equal(turnProjection.selections[0].selection.target.connectionRef, secondRef);
    assert.equal(turnProjection.providers[0].descriptor.scope.resourceId, secondRef, 'Actual authorized routing uses B, not the permanent A account.');
    allowed = ['READ'];
    turnProjection = await standalone.resolveAgentStandaloneRuntimeProviders(context, focusSelection as never, { turnSource: turnB });
    assert.deepEqual(turnProjection.providers[0].toolCap, [], 'Current source grant intersects the temporary slot cap.');
    allowed = ['READ', 'WRITE'];
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, focusSelection as never,
      { turnSource: structuredClone(turnB) }), { code: 'provider_denied' });
    const onlyA = issueSelection(snapshot([fixed('mcp', ['READ'])]));
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, onlyA as never, { turnSource: turnB }), { code: 'provider_denied' });
    const noConfigured = issueSelection(snapshot([]));
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, noConfigured as never, { turnSource: turnB }), { code: 'provider_denied' });
    const focusedBIdentity = extensionSelectionIdentity(publicShared('mcp', secondRef) as never);
    const packageFocus = issuePackageFocus(noConfigured, turnB, [focusedBIdentity]);
    const beforePackageReads = metadataReads;
    const handledByPackage = await standalone.resolveAgentStandaloneRuntimeProviders(context, noConfigured as never,
      { turnSource: turnB, packageFocus });
    assert.equal(handledByPackage.providers.length, 0, 'An actually paired package focus is compiled by the aggregate, not as a new standalone slot.');
    assert.equal(metadataReads, beforePackageReads, 'The slot resolver does not resolve a package-handled target again.');
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, noConfigured as never,
      { turnSource: turnB, packageFocus: structuredClone(packageFocus) }), { code: 'provider_denied' });
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, noConfigured as never,
      { packageFocus }), { code: 'provider_denied' });
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, focusSelection as never,
      { turnSource: turnB, packageFocus }), { code: 'provider_denied' }, 'A focus proof cannot be reused with another current package frame.');
    const clonedTurn = structuredClone(turnB);
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, noConfigured as never,
      { turnSource: clonedTurn, packageFocus }), { code: 'provider_denied' });
    const emptyFocus = issuePackageFocus(noConfigured, turnB, []);
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, noConfigured as never,
      { turnSource: turnB, packageFocus: emptyFocus }), { code: 'provider_denied' }, 'The exception skips only its actual verified identities.');

    const turnA = issueTurn([fixed('mcp', [], 'required', sharedRef, 'turn-a')]);
    const optionalA = issueSelection(snapshot([fixed('mcp', ['READ'], 'optional')]));
    turnProjection = await standalone.resolveAgentStandaloneRuntimeProviders(context, optionalA as never, { turnSource: turnA });
    assert.deepEqual(turnProjection.providers[0].toolCap, []);
    assert.equal(turnProjection.selections[0].required, true, 'A turn may add a readiness requirement without adding an action grant.');
    const legacySnapshot = snapshot([]);
    legacySnapshot.workflowVersion = null;
    const legacySelection = issueSelection(legacySnapshot);
    turnProjection = await standalone.resolveAgentStandaloneRuntimeProviders(context, legacySelection as never, { turnSource: turnA });
    assert.equal(turnProjection.providers.length, 1, 'A legacy/general turn compiles only its finite exact standalone intent.');
    assert.deepEqual(turnProjection.providers[0].toolCap, []);
    assert.equal((await standalone.resolveAgentStandaloneRuntimeProviders(context, legacySelection as never)).providers.length, 0,
      'A subsequent turn without intent does not keep the previous standalone selection.');

    const personalTurn = issueTurn([person]);
    const ownFrame = issueSelection(snapshot([ownPolicy], 'organization'));
    turnProjection = await standalone.resolveAgentStandaloneRuntimeProviders(context, ownFrame as never, { turnSource: personalTurn });
    assert.equal(turnProjection.providers.length, 1);
    assert.deepEqual(turnProjection.providers[0].toolCap, [], 'Explicit own no-auth choice remains within current per-user policy.');
    const creatorFrame = issueSelection(snapshot([person], 'organization'));
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, creatorFrame as never, { turnSource: personalTurn }), { code: 'provider_denied' });
    const ambiguousPolicy = parseStoredStandaloneExtensionBinding({ ...ownPolicy, configurationId: 'another-own-canva-policy' });
    const ambiguousFrame = issueSelection(snapshot([ownPolicy, ambiguousPolicy], 'organization'));
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, ambiguousFrame as never, { turnSource: personalTurn }), { code: 'provider_denied' },
      'An identity matching multiple personal-policy slots is never assigned to the first one.');
    const approvedTurn = parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: 'turn-approved-mcp', mode: 'fixed',
      entry: { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${uuid}` } },
        target: approvedTarget, requirement: 'optional', toolCap: ['OWN_READ', 'OTHER'] } });
    const turnApproved = issueTurn([approvedTurn]);
    const approvedFrame = issueSelection(snapshot([config], 'organization'));
    turnProjection = await standalone.resolveAgentStandaloneRuntimeProviders(context, approvedFrame as never, { turnSource: turnApproved });
    assert.deepEqual(turnProjection.providers[0].toolCap, ['OWN_READ']);
    const unapprovedTurn = parseStoredStandaloneExtensionBinding({ ...approvedTurn, entry: { ...(approvedTurn.mode === 'fixed' ? approvedTurn.entry : {}),
      target: { ...approvedTarget, personalBinding: unapprovedBinding, boundProviderRef: `mcp:v1:personal:${hash(unapprovedBinding)}` } } });
    const unapprovedSource = issueTurn([unapprovedTurn]);
    await assert.rejects(standalone.resolveAgentStandaloneRuntimeProviders(context, approvedFrame as never, { turnSource: unapprovedSource }), { code: 'provider_denied' });

    const beforeEligibility = [metadataReads, personalReads, providerResolutions, toolEnumerations];
    const incomingB = fixed('mcp', ['READ', 'WRITE'], 'optional', secondRef, 'incoming-b');
    assert(incomingB.mode === 'fixed' && approvedTurn.mode === 'fixed' && unapprovedTurn.mode === 'fixed' && person.mode === 'fixed');
    const eligibilitySnapshot = snapshot([config]);
    eligibilitySnapshot.choices[slotRef] = { workflowRevision: 3, choiceId: 'a' };
    const eligibilityFrame = issueSelection(eligibilitySnapshot);
    const eligibleB = standalone.getConfiguredStandaloneTurnFocus(context, eligibilityFrame as never, incomingB.entry);
    assert(eligibleB?.choice);
    assert.equal(eligibleB.slotRef, slotRef);
    assert.equal(eligibleB.choice.target.kind === 'shared' ? eligibleB.choice.target.connectionRef : null, secondRef);
    assert.deepEqual(eligibleB.choice.toolCap, [], 'The child allowed B cap intersects the actual parent cap without a provider probe.');
    assert.equal(eligibleB.required, true, 'The current child slot remains required when parent entry is optional.');
    assert.equal(eligibilitySnapshot.choices[slotRef].choiceId, 'a', 'Eligibility does not write the saved A preference.');
    const configuredAOnly = issueSelection(snapshot([fixed('mcp', ['READ'])]));
    assert.equal(standalone.getConfiguredStandaloneTurnFocus(context, configuredAOnly as never, incomingB.entry), null,
      'A fixed slot for A is not eligibility for B.');
    const incomingRequiredA = fixed('mcp', ['READ', 'WRITE'], 'required', sharedRef, 'incoming-a');
    assert(incomingRequiredA.mode === 'fixed');
    const optionalAFrame = issueSelection(snapshot([fixed('mcp', ['READ'], 'optional')]));
    const eligibleA = standalone.getConfiguredStandaloneTurnFocus(context, optionalAFrame as never, incomingRequiredA.entry);
    assert.equal(eligibleA?.required, true);
    assert.deepEqual(eligibleA?.choice?.toolCap, ['READ']);
    const privateMismatch = parseStoredStandaloneExtensionBinding({ ...person, entry: { ...person.entry,
      target: { ...person.entry.target, bindingFingerprint: 'f'.repeat(64) } } });
    assert(privateMismatch.mode === 'fixed');
    const personalFrame = issueSelection(snapshot([person]));
    assert.equal(standalone.getConfiguredStandaloneTurnFocus(context, personalFrame as never, privateMismatch.entry), null,
      'Same exact public profile cannot silently repair a differently stored private fingerprint.');
    const ownPolicyFrame = issueSelection(snapshot([ownPolicy], 'organization'));
    assert.deepEqual(standalone.getConfiguredStandaloneTurnFocus(context, ownPolicyFrame as never, person.entry)?.choice?.toolCap, [],
      'Current actor own no-auth source is eligible only within the child personal policy.');
    const approvedPolicyFrame = issueSelection(snapshot([config], 'organization'));
    assert.deepEqual(standalone.getConfiguredStandaloneTurnFocus(context, approvedPolicyFrame as never, approvedTurn.entry)?.choice?.toolCap,
      ['OWN_READ']);
    assert.equal(standalone.getConfiguredStandaloneTurnFocus(context, approvedPolicyFrame as never, unapprovedTurn.entry), null);
    const creatorOnlyFrame = issueSelection(snapshot([person], 'organization'));
    assert.equal(standalone.getConfiguredStandaloneTurnFocus(context, creatorOnlyFrame as never, person.entry), null,
      'Eligibility cannot share the creator personal account through an organization fixed slot.');
    const ambiguousEligibility = issueSelection(snapshot([ownPolicy, ambiguousPolicy], 'organization'));
    assert.equal(standalone.getConfiguredStandaloneTurnFocus(context, ambiguousEligibility as never, person.entry), null,
      'Multiple matching slots are not assigned to the first child slot.');
    const noSlots = issueSelection(snapshot([]));
    assert.equal(standalone.getConfiguredStandaloneTurnFocus(context, noSlots as never, incomingB.entry), null);
    assert.equal(standalone.getConfiguredStandaloneTurnFocus(context, legacySelection as never, incomingB.entry), null,
      'NULL inheritance alone is not fixed child-slot eligibility.');
    assert.throws(() => standalone.getConfiguredStandaloneTurnFocus(context, structuredClone(eligibilityFrame) as never, incomingB.entry),
      { code: 'provider_denied' });
    assert.throws(() => standalone.getConfiguredStandaloneTurnFocus({ ...context, userId: 'bob' }, eligibilityFrame as never, incomingB.entry),
      { code: 'provider_denied' });
    assert(Object.isFrozen(eligibleB) && Object.isFrozen(eligibleB.choice));
    assert.deepEqual([metadataReads, personalReads, providerResolutions, toolEnumerations], beforeEligibility,
      'The actual issued-frame eligibility helper performs no source/SQL/provider or tool discovery calls.');
    assert.equal(toolEnumerations, 0); assert.equal(providerResolutions, compilationProbeBaseline);
    console.log('PASS standalone runtime selection/projection control flow: exact slots, stale no-fallback, per-user policy, closed grants, same-provider caps, provenance and metadata-only compilation.');
  } finally { loader._load=original; }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
