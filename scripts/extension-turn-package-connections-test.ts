import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module from 'node:module';
import { z } from 'zod';
import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import { isAgentWorkflowError } from '../app/lib/agents/workflow-contracts';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';
import {
  agentExtensionConfigurationInputSchema,
  chatExtensionSelectionInputSchema,
  chatExtensionSelectionSchema,
  extensionPackageConnectionSchema,
  type ExtensionPackageConnection,
  type ExtensionSelectionEntry,
  type StandaloneExtensionInput,
} from '../app/lib/capabilities/extensions/contracts';
import { parseStoredStandaloneExtensionBinding } from '../app/lib/capabilities/extensions/stored-contracts';

// Real public and private codecs plus the actual accepted-turn WeakMap are used.
// The source service below is a controlled authority boundary, not native proof.
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const pin = { resourceRef: `canvas-resource:${id(1)}`, publishedRevisionRef: `canvas-package-revision:${id(2)}`,
  checksum: 'a'.repeat(64) };
const plugin: ExtensionSelectionEntry = { selection: { kind: 'plugin', package: pin,
  skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null };
const child: ExtensionSelectionEntry = { selection: { kind: 'skill', package: pin,
  origin: 'plugin_child', relativeRoot: 'skills/brief' }, requirement: 'optional', toolCap: null };
const mcp: ExtensionSelectionEntry = { selection: { kind: 'mcp', source: 'mcp', target: {
  kind: 'shared', connectionRef: `canvas-connection:${id(3)}`, bindingRevision: 7 } }, requirement: 'optional', toolCap: [] };
const account: StandaloneExtensionInput = { selection: { kind: 'composio', source: 'composio', toolkit: 'canva',
  target: { kind: 'personal', profileId: 'profile-alice', accountBinding: 'account', accountId: 'account-alice',
    connectionRef: 'composio-personal:profile-alice:account-alice' } }, requirement: 'required', toolCap: ['READ'],
  accountSelectionRef: `cmp_personal_account_${'r'.repeat(50)}` };
const noAuth: ExtensionSelectionEntry = { selection: { kind: 'composio', source: 'composio', toolkit: 'duckduckgo',
  target: { kind: 'personal', profileId: 'profile-alice', accountBinding: 'no_auth' } }, requirement: 'optional', toolCap: null };
assert(mcp.selection.kind === 'mcp' && account.selection.kind === 'composio' && noAuth.selection.kind === 'composio');
const mcpSelection = mcp.selection;
assert(mcpSelection.target.kind === 'shared');
const mcpTarget = mcpSelection.target;
const mcpMapping: ExtensionPackageConnection = { package: pin, declarationPath: '.canvas-plugin/plugin.json',
  capabilityId: 'design', alternativeKey: 'mcp:canva', connectionSelection: mcp.selection };
const composioMapping: ExtensionPackageConnection = { ...mcpMapping, alternativeKey: 'composio:canva',
  connectionSelection: account.selection };
const envelope = (selections: unknown[], packageConnections?: unknown[]) => ({ version: 1, origin: 'turn_reference', selections,
  ...(packageConnections === undefined ? {} : { packageConnections }) });
const sharedEnvelope = () => envelope([plugin, mcp], [mcpMapping]);
const accepts = (value: unknown) => assert(chatExtensionSelectionSchema.safeParse(value).success);
const rejects = (value: unknown, message: string) => {
  assert.equal(chatExtensionSelectionSchema.safeParse(value).success, false, message);
  assert.equal(chatExtensionSelectionInputSchema.safeParse(value).success, false, message);
};

const context: AgentExecutionContext = { userId: 'alice', sessionId: 'session-alice', agentId: 'agent-alice',
  organizationId: 'org-alice', workspaceId: 'workspace-alice', workspaceType: 'personal', workspaceName: null,
  workspaceRoot: '/owned-fixture/alice', workspaceRootRelativePath: null, projectId: null, customerId: null,
  canWrite: true, canDelete: false, canShare: false, legacy: false };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actorKey = (actor: AgentManagementActor) => JSON.stringify([actor.userId, actor.sessionId, actor.sourceAgentId,
  actor.organizationId, actor.workspaceId, actor.projectId]);
const sourceRecords = new WeakMap<object, { actor: string; binding: ReturnType<typeof parseStoredStandaloneExtensionBinding> }>();
let sourceCalls = 0;
const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => {
  if (name === 'server-only') return {};
  if (name === './standalone-preparation' || /\/extensions\/standalone-preparation(?:\.ts)?$/u.test(name)) return {
    prepareStandaloneExtensionSelection: async (actor: AgentManagementActor, input: StandaloneExtensionInput) => {
      sourceCalls++;
      assert.equal(actor.userId, context.userId);
      const selection = input.selection;
      let target: unknown;
      if (selection.target.kind === 'shared') {
        target = { ...selection.target, source: selection.source };
      } else {
        assert.equal(selection.kind, 'composio');
        if (selection.kind !== 'composio') throw new Error('Unexpected controlled source');
        if (selection.target.accountBinding === 'account') assert.equal(input.accountSelectionRef, account.accountSelectionRef,
          'Only the selected entry supplies the sealed source receipt.');
        const binding = { source: 'composio', ownerUserId: actor.userId, profileId: selection.target.profileId,
          toolkit: selection.toolkit, mode: 'managed', accountBinding: selection.target.accountBinding,
          connectedAccountId: selection.target.accountBinding === 'account' ? selection.target.accountId : null };
        target = { kind: 'personal', source: 'composio', ownerUserId: actor.userId, personalBinding: binding,
          providerRef: createIntegrationProviderRef({ source: 'composio', profileId: binding.profileId, toolkit: binding.toolkit,
            scope: { type: 'user', ownerUserId: actor.userId, resourceId: `profile:${binding.profileId}:${binding.toolkit}` } }),
          boundProviderRef: `composio:v1:personal:${hash(binding)}`, bindingFingerprint: 'b'.repeat(64) };
      }
      const binding = parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: `fixed:${hash(selection)}`,
        mode: 'fixed', entry: { selection, target, requirement: input.requirement, toolCap: input.toolCap } });
      const proof = Object.freeze({ kind: 'prepared_standalone_extension', source: selection.source });
      sourceRecords.set(proof, { actor: actorKey(actor), binding });
      return proof;
    },
    revalidatePreparedStandaloneExtensionSelection: async (proof: object, actor: AgentManagementActor) => {
      const record = sourceRecords.get(proof);
      assert(record && record.actor === actorKey(actor));
    },
    getPreparedStandaloneExtensionBinding: (proof: object, actor: AgentManagementActor) => {
      const record = sourceRecords.get(proof);
      assert(record && record.actor === actorKey(actor));
      return record.binding;
    },
  };
  return originalLoad.call(loader, name, parent, main);
};

async function main() {
  const { prepareAcceptedTurnExtensionSelection: prepare, readAcceptedTurnExtensionSelection: read,
    parseStoredAcceptedTurnExtensionSelection: parse } = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
  accepts(sharedEnvelope());
  accepts(envelope([child, mcp], [mcpMapping]));
  accepts(envelope([plugin, noAuth], [{ ...composioMapping, alternativeKey: 'composio:duckduckgo',
    connectionSelection: noAuth.selection }]));
  assert.equal(Object.hasOwn(chatExtensionSelectionSchema.parse(envelope([plugin, mcp])), 'packageConnections'), false,
    'Absent mappings do not become default bindings or an empty default array.');
  assert.deepEqual(chatExtensionSelectionSchema.parse(envelope([plugin, mcp], [])).packageConnections, []);
  const maximum = Array.from({ length: 128 }, (_, index) => ({ ...mcpMapping, capabilityId: `capability-${index}` }));
  accepts(envelope([plugin, mcp], maximum));
  rejects(envelope([plugin, mcp], [...maximum, { ...mcpMapping, capabilityId: 'overflow' }]), 'Mapping count is bounded at 128.');
  rejects(envelope([plugin, mcp], [mcpMapping, mcpMapping]), 'Duplicate exact declaration slot is rejected.');
  rejects(envelope([plugin, mcp, { selection: account.selection, requirement: account.requirement, toolCap: account.toolCap }],
    [mcpMapping, composioMapping]),
    'Different alternatives cannot bind the same package declaration slot twice.');
  rejects(envelope([plugin], [mcpMapping]), 'A mapping cannot introduce an unselected connection.');
  rejects(envelope([mcp], [mcpMapping]), 'A mapping cannot introduce an unselected package.');
  for (const packagePin of [{ ...pin, checksum: 'c'.repeat(64) }, { ...pin, publishedRevisionRef: `canvas-package-revision:${id(4)}` },
    { ...pin, resourceRef: `canvas-resource:${id(4)}` }]) {
    rejects(envelope([plugin, mcp], [{ ...mcpMapping, package: packagePin }]), 'Every immutable pin field must match the selected package.');
  }
  rejects(envelope([plugin, mcp], [{ ...mcpMapping, connectionSelection: { ...mcpSelection,
    target: { ...mcpTarget, bindingRevision: 8 } } }]), 'Same shared ref with a different binding revision is not selected.');
  rejects(envelope([plugin, mcp], [{ ...mcpMapping, connectionSelection: { ...mcpSelection,
    target: { ...mcpTarget, connectionRef: `canvas-connection:${id(5)}` } } }]), 'Same display source cannot substitute another connection.');
  rejects(envelope([plugin, noAuth], [{ ...composioMapping, connectionSelection: noAuth.selection }]), 'Exact Composio toolkit must match its alternative.');
  rejects(envelope([plugin, mcp], [{ ...mcpMapping, alternativeKey: 'composio:canva' }]), 'Alternative cannot switch source.');
  for (const declarationPath of ['', '/', '../plugin.json', 'skills/../canvas.yaml', 'skills//canvas.yaml', './canvas.yaml',
    'C:/canvas.yaml', 'https://example.invalid/icon', 'skills\\canvas.yaml', 'skills/\u200bcanvas.yaml', 'x'.repeat(1_025)]) {
    rejects(envelope([plugin, mcp], [{ ...mcpMapping, declarationPath }]), 'Declaration paths are bounded safe nonempty relative paths.');
  }
  for (const alternativeKey of ['mcp:', 'mcp:canva/server', 'mcp:canva:other', 'mcp:canva tool', 'mcp:canva\u200b',
    'composio:Canva', 'composio:', 'other:canva', `mcp:${'x'.repeat(129)}`]) {
    rejects(envelope([plugin, mcp], [{ ...mcpMapping, alternativeKey }]), 'Alternative uses the current bounded connector/toolkit grammar.');
  }
  for (const capabilityId of ['', ' design', 'design\u200b', 'x'.repeat(257)]) {
    rejects(envelope([plugin, mcp], [{ ...mcpMapping, capabilityId }]), 'Capability IDs are bounded exact identifiers.');
  }
  for (const extra of [{ accountSelectionRef: account.accountSelectionRef }, { providerRef: 'mcp:v1:invented' }, { endpoint: 'https://private.invalid' }]) {
    rejects(envelope([plugin, mcp], [{ ...mcpMapping, ...extra }]), 'Mapping cannot carry receipts, provider references or endpoints.');
    rejects(envelope([plugin, mcp], [{ ...mcpMapping, connectionSelection: { ...mcp.selection, ...extra } }]),
      'Strict selected identity cannot copy private intake metadata.');
  }
  assert.equal(agentExtensionConfigurationInputSchema.safeParse({ version: 1, origin: 'agent_configuration', mode: 'legacy_inherit',
    packageConnections: [] }).success, false, 'This additive contract does not extend Agent configuration.');
  z.toJSONSchema(chatExtensionSelectionInputSchema, { target: 'draft-7', io: 'input' });

  const profileId = '界'.repeat(128), accountId = '語'.repeat(128);
  const largeAccount: ExtensionSelectionEntry = { selection: { kind: 'composio', source: 'composio', toolkit: 'canva',
    target: { kind: 'personal', profileId, accountId, accountBinding: 'account', connectionRef: `composio-personal:${profileId}:${accountId}` } },
    requirement: 'optional', toolCap: Array.from({ length: 256 }, (_, index) => `${'界'.repeat(230)}${String(index).padStart(3, '0')}`) };
  const largeSelections = [plugin, largeAccount, ...Array.from({ length: 3 }, (_, index) => ({ ...mcp,
    selection: { ...mcpSelection, target: { ...mcpTarget, connectionRef: `canvas-connection:${id(20 + index)}` } },
    toolCap: largeAccount.toolCap }))];
  const boundedEntries = envelope(largeSelections);
  accepts(boundedEntries);
  const largeMappings = Array.from({ length: 128 }, (_, index) => ({ ...composioMapping,
    declarationPath: `skills/${'界'.repeat(1_000)}/canvas.yaml`, capabilityId: `capability-${index}`, connectionSelection: largeAccount.selection }));
  assert(largeMappings.every(mapping => extensionPackageConnectionSchema.safeParse(mapping).success), 'Each large mapping remains valid individually.');
  const aggregate = envelope(largeSelections, largeMappings);
  assert(Buffer.byteLength(JSON.stringify(boundedEntries), 'utf8') < 1_048_576);
  assert(Buffer.byteLength(JSON.stringify(aggregate), 'utf8') > 1_048_576);
  assert.equal(chatExtensionSelectionSchema.safeParse(aggregate).success, false, 'Mapping bytes count toward the entire UTF-8 turn envelope.');

  const input = envelope([plugin, account], [composioMapping]);
  assert(chatExtensionSelectionInputSchema.safeParse(input).success);
  const handle = await prepare(context, input);
  const data = read(handle, context);
  assert.equal(sourceCalls, 1, 'Mapping neither duplicates source admission nor substitutes declaration validation.');
  assert.deepEqual(data.publicSelection.packageConnections, [composioMapping]);
  assert.doesNotMatch(JSON.stringify(data), /accountSelectionRef|cmp_personal_account_/u);
  assert.ok(Object.isFrozen(data.publicSelection.packageConnections)
    && Object.isFrozen(data.publicSelection.packageConnections![0].connectionSelection.target));
  assert.deepEqual(parse(JSON.parse(JSON.stringify(data))), data, 'Accepted and stored round-trip preserves the exact public mapping.');
  const prior = JSON.stringify(data.publicSelection.packageConnections);
  (input.packageConnections![0] as ExtensionPackageConnection).capabilityId = 'changed-client';
  assert.equal(JSON.stringify(data.publicSelection.packageConnections), prior, 'Accepted mapping is a frozen deep copy.');
  const changed = await prepare(context, envelope([plugin, account], [{ ...composioMapping, capabilityId: 'different-slot' }]));
  assert.notEqual(handle.fingerprint, changed.fingerprint, 'Mapping is included in the opaque accepted fingerprint.');
  const empty = read(await prepare(context, envelope([plugin, mcp], [])), context);
  const absent = read(await prepare(context, envelope([plugin, mcp])), context);
  assert.deepEqual(empty.publicSelection.packageConnections, []);
  assert.equal(Object.hasOwn(absent.publicSelection, 'packageConnections'), false);
  assert.throws(() => read(structuredClone(handle), context), error => isAgentWorkflowError(error)
    && error.code === 'AGENT_EXTENSION_CONTEXT_DENIED', 'Mapping syntax cannot manufacture the issued WeakMap proof.');
  const corrupt = structuredClone(data);
  corrupt.publicSelection.packageConnections![0].connectionSelection = mcpSelection;
  assert.throws(() => parse(corrupt), error => isAgentWorkflowError(error) && error.code === 'AGENT_TURN_SELECTION_CORRUPT');
  const before = sourceCalls;
  await assert.rejects(prepare(context, envelope([plugin, mcp], [{ ...mcpMapping, connectionSelection: {
    ...mcpSelection, target: { ...mcpTarget, bindingRevision: 8 } } }])), error => isAgentWorkflowError(error)
    && error.code === 'AGENT_TURN_SELECTION_INVALID');
  assert.equal(sourceCalls, before, 'An out-of-scope mapping never reaches source authority.');
  let getterExecuted = false;
  const getterMapping = Object.defineProperty({ ...mcpMapping }, 'capabilityId', { enumerable: true,
    get: () => { getterExecuted = true; return 'design'; } });
  await assert.rejects(prepare(context, envelope([plugin, mcp], [getterMapping])));
  assert.equal(getterExecuted, false, 'The actual bounded JSON intake rejects mapping getters before evaluation.');
  const cycle: Record<string, unknown> = { ...mcpMapping };
  cycle.extra = cycle;
  await assert.rejects(prepare(context, envelope([plugin, mcp], [cycle])));
  assert.equal(sourceCalls, before);
  assert(extensionPackageConnectionSchema.safeParse(mcpMapping).success, 'Standalone mapping parser is syntax only; held declarations remain the compiler’s responsibility.');
  console.log('PASS turn package connections: exact selected pins/connection revisions, bounded strict slots, receipt-free frozen acceptance and fingerprints. Source authority is controlled, not native proof.');
}

void main().finally(() => { loader._load = originalLoad; }).catch(error => { console.error(error); process.exitCode = 1; });
