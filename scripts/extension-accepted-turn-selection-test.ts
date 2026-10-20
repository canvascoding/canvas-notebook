import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module from 'node:module';
import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import { isAgentWorkflowError } from '../app/lib/agents/workflow-contracts';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';
import { chatExtensionSelectionInputSchema, type StandaloneExtensionInput } from '../app/lib/capabilities/extensions/contracts';
import { parseStoredStandaloneExtensionBinding, type StoredStandaloneExtensionBinding } from '../app/lib/capabilities/extensions/stored-contracts';

// Actual accepted-turn/codecs are exercised; existing source/SQL authority is a
// controlled boundary here. This script is not native source-authority proof.
const uuid = '11111111-1111-4111-8111-111111111111';
const secondUuid = '22222222-2222-4222-8222-222222222222';
const thirdUuid = '33333333-3333-4333-8333-333333333333';
const receipt = `cmp_personal_account_${'r'.repeat(50)}`;
const context: AgentExecutionContext = {
  userId: 'alice', sessionId: 'session-alice', agentTurnId: 'turn-1', agentId: 'agent-alice',
  organizationId: 'org-alice', workspaceId: 'workspace-alice', workspaceType: 'personal', workspaceName: 'Personal',
  workspaceRoot: '/owned-fixture/alice', workspaceRootRelativePath: 'alice', projectId: null, customerId: null,
  canWrite: true, canDelete: false, canShare: false, legacy: false,
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actorKey = (actor: AgentManagementActor) => JSON.stringify([actor.userId, actor.source, actor.sourceAgentId,
  actor.sessionId, actor.organizationId, actor.workspaceId, actor.projectId]);
const personalMcp = { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${uuid}` } },
  requirement: 'optional', toolCap: null };
const personalComposio = { selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: {
  kind: 'personal', profileId: 'profile-alice', accountBinding: 'account', accountId: 'account-alice',
  connectionRef: 'composio-personal:profile-alice:account-alice' } }, requirement: 'required', toolCap: ['READ'], accountSelectionRef: receipt };
const noAuth = { selection: { kind: 'composio', source: 'composio', toolkit: 'duckduckgo', target: {
  kind: 'personal', profileId: 'profile-alice', accountBinding: 'no_auth' } }, requirement: 'optional', toolCap: [] };
const sharedMcp = { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared',
  connectionRef: `canvas-connection:${secondUuid}`, bindingRevision: 7 } }, requirement: 'required', toolCap: ['READ', 'WRITE'] };
const plugin = { selection: { kind: 'plugin', package: { resourceRef: `canvas-resource:${thirdUuid}`,
  publishedRevisionRef: `canvas-package-revision:${uuid}`, checksum: 'a'.repeat(64) }, skillSelection: { kind: 'subset', relativeRoots: ['brief'] } },
  requirement: 'optional', toolCap: null };
const envelope = (selections: unknown[]) => ({ version: 1, origin: 'turn_reference', selections });

let sourceAvailable = true;
let receiptValid = true;
let fixtureTime = 0;
let fixtureOwner = 'alice';
let preparationCalls = 0;
let revalidationCalls = 0;
let getterCalls = 0;
let afterPrepare: ((index: number) => void) | undefined;
const records = new WeakMap<object, { actor: string; binding: StoredStandaloneExtensionBinding; expiresAt: number }>();
const observedInputs: StandaloneExtensionInput[] = [];

function makeBinding(input: StandaloneExtensionInput): StoredStandaloneExtensionBinding {
  const selection = input.selection;
  let target: unknown;
  if (selection.target.kind === 'shared') {
    target = { kind: 'shared', source: selection.source, connectionRef: selection.target.connectionRef,
      bindingRevision: selection.target.bindingRevision };
  } else if (selection.kind === 'mcp') {
    const binding = { source: 'mcp', ownerUserId: fixtureOwner,
      connectionId: selection.target.connectionRef.slice('mcp-personal:'.length), serverDefinitionId: null };
    target = { kind: 'personal', source: 'mcp', ownerUserId: fixtureOwner, personalBinding: binding,
      providerRef: createIntegrationProviderRef({ source: 'mcp', connectionId: binding.connectionId,
        scope: { type: 'user', ownerUserId: fixtureOwner, resourceId: binding.connectionId } }),
      boundProviderRef: `mcp:v1:personal:${hash(binding)}`, bindingFingerprint: 'b'.repeat(64) };
  } else {
    const binding = { source: 'composio', ownerUserId: fixtureOwner, profileId: selection.target.profileId,
      toolkit: selection.toolkit, mode: 'managed', accountBinding: selection.target.accountBinding,
      connectedAccountId: selection.target.accountBinding === 'account' ? 'account-alice' : null };
    target = { kind: 'personal', source: 'composio', ownerUserId: fixtureOwner, personalBinding: binding,
      providerRef: createIntegrationProviderRef({ source: 'composio', profileId: binding.profileId, toolkit: binding.toolkit,
        scope: { type: 'user', ownerUserId: fixtureOwner, resourceId: `profile:${binding.profileId}:${binding.toolkit}` } }),
      boundProviderRef: `composio:v1:personal:${hash(binding)}`, bindingFingerprint: 'c'.repeat(64) };
  }
  return parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: `fixed:${hash(selection)}`,
    mode: 'fixed', entry: { selection, target, requirement: input.requirement, toolCap: input.toolCap } });
}

function current(proof: object, actor: AgentManagementActor) {
  const value = records.get(proof);
  assert(value && value.actor === actorKey(actor), 'The controlled source boundary requires its own issued actor proof.');
  if (!sourceAvailable || value.expiresAt <= fixtureTime) throw new Error('controlled source revoked or intake proof expired');
  return value;
}

const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => {
  if (name === 'server-only') return {};
  if (name === './standalone-preparation' || /\/extensions\/standalone-preparation(?:\.ts)?$/u.test(name)) return {
    prepareStandaloneExtensionSelection: async (actor: AgentManagementActor, value: StandaloneExtensionInput) => {
      assert.equal(actor.sourceAgentId, context.agentId);
      assert.equal(actor.sessionId, context.sessionId);
      assert.equal(actor.workspaceId, context.workspaceId);
      assert.equal(actor.organizationId, context.organizationId);
      assert.equal(actor.projectId, context.projectId);
      assert.equal(actor.source, 'system');
      if (!sourceAvailable) throw new Error('controlled source revoked');
      if (value.selection.kind === 'composio' && value.selection.target.kind === 'personal'
        && value.selection.target.accountBinding === 'account' && (!receiptValid || value.accountSelectionRef !== receipt)) {
        throw new Error('controlled explicit account receipt rejected');
      }
      const proof = Object.freeze({ kind: 'prepared_standalone_extension', source: value.selection.source });
      const binding = makeBinding(value);
      records.set(proof, { actor: actorKey(actor), binding, expiresAt: fixtureTime + 300_000 });
      observedInputs.push(structuredClone(value));
      preparationCalls++;
      afterPrepare?.(preparationCalls);
      return proof;
    },
    revalidatePreparedStandaloneExtensionSelection: async (proof: object, actor: AgentManagementActor) => {
      revalidationCalls++;
      return current(proof, actor).binding;
    },
    getPreparedStandaloneExtensionBinding: (proof: object, actor: AgentManagementActor) => {
      getterCalls++;
      return current(proof, actor).binding;
    },
  };
  return originalLoad.call(loader, name, parent, main);
};

async function main() {
  const api = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
  const { prepareAcceptedTurnExtensionSelection: prepare, readAcceptedTurnExtensionSelection: read,
    parseStoredAcceptedTurnExtensionSelection: parse } = api;
  const input = envelope([plugin, personalMcp, personalComposio, noAuth, sharedMcp]);
  const handle = await prepare(context, input);
  const data = read(handle, context);
  assert.deepEqual(Object.keys(handle).sort(), ['fingerprint', 'kind']);
  assert.match(handle.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(preparationCalls, 4);
  assert.equal(revalidationCalls, 4, 'Every source is revalidated after the whole intake batch.');
  assert.equal(getterCalls, 4);
  assert.equal(data.publicSelection.selections.length, 5);
  assert.equal(data.privateFixedBindings.length, 4);
  assert.equal(observedInputs[1].accountSelectionRef, receipt, 'The source service consumes the original explicit account receipt.');
  const encoded = JSON.stringify(data);
  assert.doesNotMatch(encoded, /accountSelectionRef|cmp_personal_account_|credential|endpoint|accessToken/u);
  assert.ok(Object.isFrozen(data) && Object.isFrozen(data.publicSelection.selections)
    && Object.isFrozen(data.privateFixedBindings[1].entry.target));
  assert.deepEqual(data.privateFixedBindings.map(binding => binding.entry.toolCap), [null, ['READ'], [], ['READ', 'WRITE']]);
  assert.deepEqual(parse(JSON.parse(encoded)), data, 'The durable receipt-free exact intent round-trips.');
  assert.throws(() => read(structuredClone(handle), context), error => isAgentWorkflowError(error) && error.code === 'AGENT_EXTENSION_CONTEXT_DENIED');
  assert.throws(() => read({ ...handle }, context));
  assert.throws(() => read(parse(JSON.parse(encoded)) as unknown as typeof handle, context), 'Stored syntax alone cannot become accepted proof.');
  assert.ok(!Object.keys(api).some(name => /rehydrat/iu.test(name)), 'No unvalidated rehydration authority is exported.');
  const changes: Array<Partial<AgentExecutionContext>> = [
    { userId: 'bob' }, { sessionId: 'other-session' }, { agentTurnId: 'other-turn' }, { agentId: 'other-agent' },
    { organizationId: 'other-org' }, { workspaceId: 'other-workspace' }, { workspaceType: 'team' },
    { workspaceRoot: '/other-root' }, { workspaceRootRelativePath: 'other-relative' }, { projectId: 'other-project' },
    { customerId: 'other-customer' }, { canWrite: false }, { canDelete: true }, { canShare: true }, { legacy: true },
    { turnExtensions: { version: 1, origin: 'turn_reference', selections: [] } },
  ];
  for (const change of changes) assert.throws(() => read(handle, { ...context, ...change }), error => isAgentWorkflowError(error)
    && error.code === 'AGENT_EXTENSION_CONTEXT_DENIED', `Changing ${Object.keys(change)[0]} closes accepted metadata access.`);
  const readCalls = preparationCalls + revalidationCalls + getterCalls;
  fixtureTime += 600_000;
  assert.equal(read(handle, context), data, 'Accepted identity does not expire with the consumed five-minute intake receipt.');
  assert.equal(preparationCalls + revalidationCalls + getterCalls, readCalls, 'The getter grants nothing and never refreshes source authority.');
  fixtureTime = 0;
  (input.selections[1] as typeof personalMcp).toolCap = ['MUTATED'] as unknown as null;
  assert.equal(data.privateFixedBindings[0].entry.toolCap, null, 'Accepted data is a deep copy of its intake.');
  assert.throws(() => { data.privateFixedBindings[0].entry.toolCap = ['MUTATED']; });

  const corrupt = (mutate: (value: typeof data) => void) => {
    const copied = structuredClone(data);
    mutate(copied);
    assert.throws(() => parse(copied), error => isAgentWorkflowError(error) && error.code === 'AGENT_TURN_SELECTION_CORRUPT');
  };
  corrupt(value => { value.privateFixedBindings.pop(); });
  corrupt(value => { value.privateFixedBindings.push(value.privateFixedBindings[0]); });
  corrupt(value => { value.privateFixedBindings[1].entry.requirement = 'optional'; });
  corrupt(value => { value.privateFixedBindings[1].entry.toolCap = []; });
  corrupt(value => { value.privateFixedBindings[0].entry.toolCap = []; });
  corrupt(value => { value.privateFixedBindings.reverse(); });
  corrupt(value => { Object.assign(value.publicSelection.selections[2], { accountSelectionRef: receipt }); });
  corrupt(value => { Object.assign(value.privateFixedBindings[0].entry.target, { endpoint: 'https://private.invalid', token: 'private' }); });
  corrupt(value => { Object.assign(value.privateFixedBindings[1].entry.selection, { toolkit: 'slack' }); });
  corrupt(value => { Object.assign(value, { actor: 'alice' }); });
  assert.throws(() => parse({ ...data, padding: '界'.repeat(400_000) }), error => isAgentWorkflowError(error)
    && error.code === 'AGENT_TURN_SELECTION_CORRUPT', 'Aggregate UTF-8 bounds apply before unknown-field parsing.');
  const largeCap = Array.from({ length: 256 }, (_value, index) => `${'界'.repeat(220)}${String(index).padStart(3, '0')}`);
  const largeInputs = chatExtensionSelectionInputSchema.parse(envelope(Array.from({ length: 5 }, (_value, index) => ({
    selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared', bindingRevision: 1,
      connectionRef: `canvas-connection:00000000-0000-4000-8000-${String(index).padStart(12, '0')}` } },
    requirement: 'optional', toolCap: largeCap,
  }))));
  const aggregate = { version: 1, kind: 'accepted_turn_extension_selection', publicSelection: largeInputs,
    privateFixedBindings: largeInputs.selections.map(entry => makeBinding(entry as StandaloneExtensionInput)) };
  assert.ok(Buffer.byteLength(JSON.stringify(largeInputs), 'utf8') < 1_048_576);
  assert.ok(Buffer.byteLength(JSON.stringify(aggregate), 'utf8') > 1_048_576);
  assert.throws(() => parse(aggregate), error => isAgentWorkflowError(error) && error.code === 'AGENT_TURN_SELECTION_CORRUPT',
    'Otherwise valid per-entry/public shapes cannot bypass the aggregate durable DTO byte limit.');
  let getterExecuted = false;
  const malicious = Object.defineProperty({}, 'version', { enumerable: true, get: () => { getterExecuted = true; return 1; } });
  assert.throws(() => parse(malicious));
  assert.equal(getterExecuted, false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => parse(cycle));

  async function invalid(value: unknown) {
    const before = preparationCalls;
    await assert.rejects(prepare(context, value), error => isAgentWorkflowError(error) && error.code === 'AGENT_TURN_SELECTION_INVALID');
    assert.equal(preparationCalls, before, 'Invalid public intake never reaches source authority.');
  }
  await invalid(envelope([{ ...personalComposio, accountSelectionRef: undefined }]));
  await invalid(envelope([{ ...noAuth, accountSelectionRef: receipt }]));
  await invalid(envelope([{ ...sharedMcp, accountSelectionRef: receipt }]));
  await invalid(envelope([personalMcp, personalMcp]));
  await invalid(envelope(Array.from({ length: 6 }, (_value, index) => ({ ...personalMcp,
    selection: { ...personalMcp.selection, target: { kind: 'personal', connectionRef: `mcp-personal:00000000-0000-4000-8000-${String(index).padStart(12, '0')}` } } }))));
  await invalid({ ...envelope([]), padding: '界'.repeat(400_000) });
  await invalid(malicious);
  assert.equal(getterExecuted, false);

  receiptValid = false;
  await assert.rejects(prepare(context, envelope([personalComposio])), /receipt rejected/u);
  receiptValid = true;
  fixtureOwner = 'bob';
  await assert.rejects(prepare(context, envelope([personalMcp])), error => isAgentWorkflowError(error)
    && error.code === 'AGENT_EXTENSION_CONTEXT_DENIED', 'The actor cannot accept another owner’s materialized private target.');
  fixtureOwner = 'alice';
  const beforeBatch = preparationCalls;
  afterPrepare = index => { if (index === beforeBatch + 2) sourceAvailable = false; };
  await assert.rejects(prepare(context, envelope([personalMcp, sharedMcp])), /source revoked/u);
  sourceAvailable = true;
  const beforeExpired = preparationCalls;
  afterPrepare = index => { if (index === beforeExpired + 1) fixtureTime = 300_000; };
  await assert.rejects(prepare(context, envelope([personalMcp])), /intake proof expired/u);
  fixtureTime = 0;
  afterPrepare = () => { context.projectId = 'late-project'; };
  await assert.rejects(prepare(context, envelope([personalMcp])), error => isAgentWorkflowError(error)
    && error.code === 'AGENT_EXTENSION_CONTEXT_DENIED', 'A changed full namespace cannot receive the prepared selection.');
  context.projectId = null;
  afterPrepare = undefined;
  await assert.rejects(prepare({ ...context, sessionId: '' }, envelope([])), error => isAgentWorkflowError(error)
    && error.code === 'AGENT_EXTENSION_CONTEXT_DENIED');
  const first = await prepare(context, envelope([{ ...personalMcp, toolCap: null }]));
  const second = await prepare(context, envelope([{ ...personalMcp, toolCap: [] }]));
  assert.notEqual(first.fingerprint, second.fingerprint, 'Unrestricted and explicit no-actions are distinct accepted identities.');
  assert.deepEqual(read(second, context).privateFixedBindings[0].entry.toolCap, []);
  assert.deepEqual(chatExtensionSelectionInputSchema.parse(envelope([])).selections, []);
  console.log('PASS accepted turn selection: strict durable consistency, receipt removal after controlled source authority, opaque actor proof and byte bounds.');
}

void main().finally(() => { loader._load = originalLoad; }).catch(error => { console.error(error); process.exitCode = 1; });
