import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module from 'node:module';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import { isAgentWorkflowError } from '../app/lib/agents/workflow-contracts';
import type { AuthorizedAgentWorkflowPackageSelections } from '../app/lib/capabilities/packages/runtime-bindings';
import { parseStoredStandaloneExtensionBinding } from '../app/lib/capabilities/extensions/stored-contracts';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';

const testEnvironment = { CANVAS_MCP_DIRECT_ENABLED: 'false', BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
const previousEnvironment = Object.fromEntries(Object.keys(testEnvironment).map(key => [key, process.env[key]]));
Object.assign(process.env, testEnvironment);

// Real intake, durable codecs and turn holder; current SQL/source services are
// controlled test boundaries. Native persisted-session/source proof is separate.
const intake: AgentExecutionContext = { userId: 'alice', sessionId: 'session-alice', agentId: 'agent-alice',
  agentTurnId: 'previous-turn', workspaceId: 'workspace-alice', workspaceType: 'personal', workspaceName: 'Personal',
  workspaceRoot: '/owned-fixture/alice', workspaceRootRelativePath: 'alice', organizationId: 'org-alice',
  projectId: null, customerId: null, canWrite: true, canDelete: false, canShare: false, legacy: false };
const connectionId = '11111111-1111-4111-8111-111111111111';
const sharedRef = 'canvas-connection:22222222-2222-4222-8222-222222222222';
const receipt = `cmp_personal_account_${'r'.repeat(50)}`;
const mcp = { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${connectionId}` } }, requirement: 'optional', toolCap: null } as const;
const composio = { selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: 'profile-alice',
  accountBinding: 'account', accountId: 'account-alice', connectionRef: 'composio-personal:profile-alice:account-alice' } },
  requirement: 'required', toolCap: ['READ'], accountSelectionRef: receipt } as const;
const shared = { selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: {
  kind: 'shared', connectionRef: sharedRef, bindingRevision: 7 } }, requirement: 'required', toolCap: [] } as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actorKey = (context: AgentExecutionContext) => JSON.stringify([context.userId, context.sessionId, context.agentId, context.organizationId,
  context.workspaceId, context.projectId, context.customerId, context.turnExtensions ?? null]);
const packageProofs = new WeakMap<object, string>();
const intakeProofs = new WeakMap<object, ReturnType<typeof parseStoredStandaloneExtensionBinding>>();
const sharedProofs = new WeakSet<object>();
let sessionAvailable = true, actorAvailable = true, personalAvailable = true, canUse = true;
let currentBindingRevision = 7, currentSource = 'composio', currentToolkit = 'canva', profileMode = 'managed';
let sessionReads = 0, actorReads = 0, personalReads = 0, sharedReads = 0, sharedRevalidations = 0, closes = 0;
let afterPersonalRead: (() => void) | undefined;

function issuePackage(context: AgentExecutionContext): AuthorizedAgentWorkflowPackageSelections {
  const value = Object.freeze({ fingerprint: hash(actorKey(context)), workflowVersion: null, workflowRevision: 0, packages: [] });
  packageProofs.set(value, actorKey(context));
  return value as unknown as AuthorizedAgentWorkflowPackageSelections;
}

function fixed(value: typeof mcp | typeof composio | typeof shared) {
  const selection = value.selection;
  let target: unknown;
  if (selection.target.kind === 'shared') target = { kind: 'shared', source: selection.source, connectionRef: selection.target.connectionRef,
    bindingRevision: selection.target.bindingRevision };
  else {
    const binding = selection.kind === 'mcp'
      ? { source: 'mcp', ownerUserId: 'alice', connectionId, serverDefinitionId: null }
      : { source: 'composio', ownerUserId: 'alice', profileId: 'profile-alice', toolkit: 'canva', mode: 'managed',
        accountBinding: 'account', connectedAccountId: 'account-alice' };
    const scope = { type: 'user' as const, ownerUserId: 'alice', resourceId: selection.kind === 'mcp' ? connectionId : 'profile:profile-alice:canva' };
    const providerRef = selection.kind === 'mcp' ? createIntegrationProviderRef({ source: 'mcp', connectionId, scope })
      : createIntegrationProviderRef({ source: 'composio', profileId: 'profile-alice', toolkit: 'canva', scope });
    target = { kind: 'personal', source: selection.source, ownerUserId: 'alice', personalBinding: binding,
      providerRef, boundProviderRef: `${selection.source}:v1:personal:${hash(binding)}`, bindingFingerprint: 'a'.repeat(64) };
  }
  return parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: `fixed:${hash(selection)}`, mode: 'fixed',
    entry: { selection, target, requirement: value.requirement, toolCap: value.toolCap } });
}

const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
const original = loader._load;
loader._load = (name, parent, main) => {
  if (name === 'server-only') return {};
  // New private delegation imports reach model catalogue construction, but this
  // controlled source fixture never starts a model or changes its authority stubs.
  if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
    getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
  };
  if (name === '@/app/lib/db' || /\/lib\/db(?:\/index|\.ts)?$/u.test(name)) return {
    openDb: async () => ({ close: async () => { closes++; } }),
  };
  if (name === '@/app/lib/pi/session-workspace-context' || /\/pi\/session-workspace-context(?:\.ts)?$/u.test(name)) return {
    readStoredAgentWorkspaceOnConnection: async (_database: unknown, request: { userId: string; sessionId: string; agentId: string; workspaceId: string; permissions: string[] }) => {
      sessionReads++;
      assert.deepEqual(request.permissions, ['canRead', 'canRunAgent']);
      if (!sessionAvailable || request.userId !== intake.userId || request.sessionId !== intake.sessionId
        || request.agentId !== intake.agentId || request.workspaceId !== intake.workspaceId) throw new Error('controlled session denied');
      return { workspaceId: intake.workspaceId, workspaceType: intake.workspaceType, organizationId: intake.organizationId,
        projectId: intake.projectId, customerId: intake.customerId, rootPath: intake.workspaceRoot, rootRelativePath: intake.workspaceRootRelativePath,
        legacy: false, permissions: { canWrite: true, canDelete: false, canCreatePublicLinks: false } };
    },
  };
  if (name === '@/app/lib/agents/actor-context' || /\/agents\/actor-context(?:\.ts)?$/u.test(name)) return {
    resolveVerifiedAgentActorContextOnConnection: async (actor: AgentManagementActor) => {
      actorReads++;
      if (!actorAvailable) throw new Error('controlled SQL actor denied');
      assert.equal(actor.userId, intake.userId);
      return { userId: intake.userId, organizationId: intake.organizationId,
        context: { workspaceId: intake.workspaceId, projectId: intake.projectId } };
    },
  };
  if (name === '@/app/lib/capabilities/packages/runtime-bindings' || /\/packages\/runtime-bindings(?:\.ts)?$/u.test(name)) return {
    isAuthorizedAgentWorkflowPackageSelections: (value: object, context: AgentExecutionContext) => packageProofs.get(value) === actorKey(context),
  };
  if (name === './standalone-preparation' || /\/extensions\/standalone-preparation(?:\.ts)?$/u.test(name)) return {
    prepareStandaloneExtensionSelection: async (actor: AgentManagementActor, value: typeof mcp | typeof composio | typeof shared) => {
      assert.equal(actor.userId, intake.userId);
      if (value.selection.kind === 'composio' && value.selection.target.kind === 'personal') assert.equal((value as typeof composio).accountSelectionRef, receipt);
      const proof = Object.freeze({ kind: 'prepared_standalone_extension', source: value.selection.source });
      intakeProofs.set(proof, fixed(value));
      return proof;
    },
    revalidatePreparedStandaloneExtensionSelection: async (proof: object) => { assert(intakeProofs.has(proof)); },
    getPreparedStandaloneExtensionBinding: (proof: object) => { const value = intakeProofs.get(proof); assert(value); return value; },
  };
  if (name === '@/app/lib/integration-tools/workflow-personal-bindings' || /\/integration-tools\/workflow-personal-bindings(?:\.ts)?$/u.test(name)) return {
    verifyStoredPersonalWorkflowProviderTarget: async ({ actor, target }: { actor: AgentManagementActor; target: {
      binding: { ownerUserId: string; source: string; mode?: string; connectedAccountId?: string }; boundProviderRef: string } }, options: { checkProviderReadiness: boolean }) => {
      personalReads++;
      assert.equal(options.checkProviderReadiness, false, 'Source verification must not probe live providers/accounts.');
      assert.equal(actor.sourceAgentId, intake.agentId);
      assert.equal(actor.sessionId, intake.sessionId);
      assert.equal(target.binding.ownerUserId, actor.userId);
      if (!personalAvailable || target.binding.source === 'composio' && target.binding.mode !== profileMode) throw new Error('controlled private identity changed');
      if (target.binding.source === 'composio') assert.equal(target.binding.connectedAccountId, 'account-alice', 'No account/default substitution.');
      afterPersonalRead?.();
      return Object.freeze({ kind: 'prepared_personal_workflow_provider_target', source: target.binding.source, boundProviderRef: target.boundProviderRef });
    },
  };
  if (name === '@/app/lib/integration-tools/connections/store' || /\/integration-tools\/connections\/store(?:\.ts)?$/u.test(name)) return {
    authorizeIntegrationConnection: async (actor: { userId: string; agentId: string; sessionId: string }, ref: string, operation: string) => {
      sharedReads++;
      assert.equal(operation, 'use');
      assert.equal(actor.agentId, intake.agentId);
      assert.equal(actor.sessionId, intake.sessionId);
      assert.equal(ref, sharedRef);
      const value = { access: { canRead: true, canUse, canManage: false }, resource: { status: 'active', source: currentSource,
        bindingRevision: currentBindingRevision }, backend: { source: currentSource, toolkit: currentToolkit, accountBinding: 'account' },
      authorizationRevision: hash([canUse, currentBindingRevision, currentSource, currentToolkit]) };
      sharedProofs.add(value);
      return value;
    },
    revalidateAuthorizedIntegrationConnection: async (value: { authorizationRevision: string }, operation: string) => {
      sharedRevalidations++;
      assert(sharedProofs.has(value));
      assert.equal(operation, 'use');
      if (!canUse || value.authorizationRevision !== hash([canUse, currentBindingRevision, currentSource, currentToolkit])) throw new Error('controlled shared grant changed');
      return value;
    },
  };
  return original.call(loader, name, parent, main);
};

async function main() {
  const intakeApi = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
  const api = await import('../app/lib/capabilities/extensions/turn-runtime');
  const { reissueAcceptedTurnRuntimeSelection: reissue, readAcceptedTurnRuntimeSelection: read } = api;
  const accepted = await intakeApi.prepareAcceptedTurnExtensionSelection(intake,
    { version: 1, origin: 'turn_reference', selections: [mcp, composio, shared] });
  const stored = intakeApi.readAcceptedTurnExtensionSelection(accepted, intake);
  const context: AgentExecutionContext = { ...intake, agentTurnId: 'current-server-turn', turnExtensions: stored.publicSelection };
  const packageSelection = issuePackage(context);
  const source = await reissue(context, accepted, intake, { packageSelection });
  assert.deepEqual(Object.keys(source).sort(), ['fingerprint', 'kind']);
  assert.equal(source.kind, 'accepted_turn_runtime_selection');
  assert.equal(sessionReads, 2);
  assert.equal(actorReads, 2);
  assert.equal(closes, 2);
  assert.equal(personalReads, 4);
  assert.equal(sharedReads, 1);
  assert.equal(sharedRevalidations, 1);
  const value = read(source, context, packageSelection);
  assert.deepEqual(value.publicSelection, stored.publicSelection);
  assert.equal(value.privateFixedBindings.length, 3);
  assert.equal(value.privateFixedBindings[2].entry.target.kind, 'shared');
  assert.deepEqual(value.privateFixedBindings[2].entry.toolCap, []);
  assert.doesNotMatch(JSON.stringify(value), /accountSelectionRef|cmp_personal_account_/u);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.privateFixedBindings));
  const reads = sessionReads + actorReads + personalReads + sharedReads;
  assert.equal(read(source, context, packageSelection), value);
  assert.equal(sessionReads + actorReads + personalReads + sharedReads, reads, 'Private metadata access is not cached execution authorization.');
  assert.throws(() => read(structuredClone(source), context, packageSelection));
  assert.throws(() => read(source, context, { ...packageSelection }));
  assert.throws(() => read(source, { ...context, agentTurnId: 'different-turn' }, packageSelection));
  assert.throws(() => read(source, { ...context, sessionId: 'different-session' }, packageSelection));
  assert.equal(read(source, context, issuePackage(context)), value,
    'Fresh Describe/Call policy frames retain the exact accepted intent; current source/cap authorization is still required downstream.');
  await assert.rejects(reissue(context, structuredClone(accepted), intake, { packageSelection }));
  await assert.rejects(reissue(context, stored as unknown as typeof accepted, intake, { packageSelection }), 'A client-encoded private DTO cannot enter the runtime authority path.');
  await assert.rejects(reissue({ ...context, turnExtensions: { version: 1, origin: 'turn_reference', selections: [] } }, accepted, intake, { packageSelection }));
  await assert.rejects(reissue({ ...context, workspaceId: 'other-workspace' }, accepted, intake, { packageSelection }));
  await assert.rejects(reissue(context, accepted, intake, { packageSelection: { ...packageSelection } }));
  const wrongProject = { ...context, projectId: 'contradictory-project' };
  await assert.rejects(reissue(wrongProject, accepted, intake, { packageSelection: issuePackage(wrongProject) }));
  const denied = () => reissue(context, accepted, intake, { packageSelection });
  sessionAvailable = false;
  await assert.rejects(denied(), /session denied/u);
  sessionAvailable = true;
  actorAvailable = false;
  await assert.rejects(denied(), /SQL actor denied/u);
  actorAvailable = true;
  personalAvailable = false;
  await assert.rejects(denied(), /private identity changed/u);
  personalAvailable = true;
  profileMode = 'local';
  await assert.rejects(denied(), /private identity changed/u);
  profileMode = 'managed';
  afterPersonalRead = () => { personalAvailable = false; };
  await assert.rejects(denied(), /private identity changed/u, 'An earlier profile/source is rechecked after the complete metadata batch.');
  afterPersonalRead = undefined;
  personalAvailable = true;
  currentBindingRevision = 8;
  await assert.rejects(denied(), error => isAgentWorkflowError(error) && error.code === 'AGENT_EXTENSION_CONTEXT_DENIED');
  currentBindingRevision = 7;
  currentSource = 'mcp';
  await assert.rejects(denied());
  currentSource = 'composio';
  currentToolkit = 'slack';
  await assert.rejects(denied());
  currentToolkit = 'canva';
  canUse = false;
  await assert.rejects(denied(), 'Read-only access cannot reissue a connection for use.');
  canUse = true;
  afterPersonalRead = () => { context.agentTurnId = 'late-other-turn'; };
  await assert.rejects(denied(), error => isAgentWorkflowError(error) && error.code === 'AGENT_EXTENSION_CONTEXT_DENIED');
  context.agentTurnId = 'current-server-turn';
  afterPersonalRead = () => { sessionAvailable = false; };
  await assert.rejects(denied(), /session denied/u, 'A revoked session is checked again after source I/O.');
  sessionAvailable = true;
  afterPersonalRead = undefined;
  assert.ok(!Object.keys(api).some(name => /parse|fromDto|rehydrate/iu.test(name)), 'No syntax-only DTO admission is exported.');
  assert.equal(closes, sessionReads, 'Every current-session check closes its owned connection, including failures.');
  console.log('PASS accepted turn runtime: actual issued intake provenance, controlled current SQL/source checks, immutable exact frame and no DTO authority promotion.');
}

void main().finally(() => {
  loader._load = original;
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
