import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseStoredAgentWorkflowPackage } from '../app/lib/agents/workflow-contracts';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';
import {
  parseStoredStandaloneExtensionBinding,
  storedStandaloneExtensionBindingSchema,
} from '../app/lib/capabilities/extensions/stored-contracts';

const connectionId = '11111111-1111-4111-8111-111111111111';
const secondConnectionId = '22222222-2222-4222-8222-222222222222';
const definitionId = '33333333-3333-4333-8333-333333333333';
const sharedRef = `canvas-connection:${connectionId}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function personalMcp(id = connectionId, ownerUserId = 'alice') {
  const binding = { source: 'mcp' as const, ownerUserId, connectionId: id, serverDefinitionId: definitionId };
  return {
    kind: 'personal' as const,
    source: 'mcp' as const,
    ownerUserId,
    providerRef: createIntegrationProviderRef({ source: 'mcp', connectionId: id,
      scope: { type: 'user', ownerUserId, resourceId: id } }),
    boundProviderRef: `mcp:v1:personal:${hash(binding)}`,
    bindingFingerprint: 'a'.repeat(64),
    personalBinding: binding,
  };
}

function personalComposio(noAuth = false) {
  const binding = {
    source: 'composio' as const,
    ownerUserId: 'alice',
    profileId: 'profile-alice',
    toolkit: 'canva',
    mode: 'managed' as const,
    accountBinding: noAuth ? 'no_auth' as const : 'account' as const,
    connectedAccountId: noAuth ? null : 'ca_alice',
  };
  return {
    kind: 'personal' as const,
    source: 'composio' as const,
    ownerUserId: 'alice',
    providerRef: createIntegrationProviderRef({ source: 'composio', profileId: binding.profileId, toolkit: binding.toolkit,
      scope: { type: 'user', ownerUserId: 'alice', resourceId: `profile:${binding.profileId}:${binding.toolkit}` } }),
    boundProviderRef: `composio:v1:personal:${hash(binding)}`,
    bindingFingerprint: 'b'.repeat(64),
    personalBinding: binding,
  };
}

function fixedMcp(id = connectionId, ownerUserId = 'alice') {
  return {
    version: 1,
    kind: 'standalone',
    configurationId: 'own-mcp-slot',
    mode: 'fixed',
    entry: {
      selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${id}` } },
      requirement: 'required',
      toolCap: null,
      target: personalMcp(id, ownerUserId),
    },
  };
}

function fixedComposio(noAuth = false) {
  return {
    version: 1,
    kind: 'standalone',
    configurationId: 'own-composio-slot',
    mode: 'fixed',
    entry: {
      selection: {
        kind: 'composio', source: 'composio', toolkit: 'canva',
        target: noAuth ? { kind: 'personal', profileId: 'profile-alice', accountBinding: 'no_auth' }
          : { kind: 'personal', profileId: 'profile-alice', accountBinding: 'account', accountId: 'ca_alice',
            connectionRef: 'composio-personal:profile-alice:ca_alice' },
      },
      requirement: 'optional',
      toolCap: [],
      target: personalComposio(noAuth),
    },
  };
}

const shared = {
  version: 1,
  kind: 'standalone',
  configurationId: 'shared-composio-slot',
  mode: 'fixed',
  entry: {
    selection: { kind: 'composio', source: 'composio', toolkit: 'canva',
      target: { kind: 'shared', connectionRef: sharedRef, bindingRevision: 3 } },
    target: { kind: 'shared', source: 'composio', connectionRef: sharedRef, bindingRevision: 3 },
    requirement: 'optional',
    toolCap: ['READ'],
  },
};

function changed(value: unknown, fields: readonly (string | number)[], replacement: unknown): unknown {
  const copy = structuredClone(value);
  let current = copy as Record<string, unknown>;
  for (const field of fields.slice(0, -1)) current = current[field] as Record<string, unknown>;
  current[fields[fields.length - 1]] = replacement;
  return copy;
}

function invalid(value: unknown, message: string): void {
  assert.equal(storedStandaloneExtensionBindingSchema.safeParse(value).success, false, message);
  assert.throws(() => parseStoredStandaloneExtensionBinding(value), {
    code: 'AGENT_WORKFLOW_CORRUPT', status: 409,
  }, message);
}

for (const fixture of [fixedMcp(), fixedComposio(), fixedComposio(true), shared]) {
  assert.deepEqual(parseStoredStandaloneExtensionBinding(fixture), fixture);
}
const fixture = fixedMcp();
const frozen = parseStoredStandaloneExtensionBinding(fixture);
assert.equal(frozen.mode, 'fixed');
if (frozen.mode !== 'fixed') throw new Error('Expected the fixed fixture.');
assert.equal(frozen.entry.toolCap, null, 'Null preserves the caller’s full currently authorized tool scope.');
assert(Object.isFrozen(frozen));
assert(Object.isFrozen(frozen.entry));
assert(Object.isFrozen(frozen.entry.target));
assert(frozen.entry.target.kind === 'personal');
assert(Object.isFrozen(frozen.entry.target.personalBinding));
fixture.entry.target.personalBinding.ownerUserId = 'mutated-after-parse';
assert.equal(frozen.entry.target.personalBinding.ownerUserId, 'alice', 'The validated copy cannot alias caller-owned objects.');
const none = parseStoredStandaloneExtensionBinding(fixedComposio());
assert.equal(none.mode, 'fixed');
if (none.mode !== 'fixed') throw new Error('Expected the fixed fixture.');
assert.deepEqual(none.entry.toolCap, []);
assert(Object.isFrozen(none.entry.toolCap));

invalid(changed(fixedMcp(), ['entry', 'target', 'ownerUserId'], 'bob'), 'Contradictory private ownership is rejected.');
invalid(changed(fixedMcp(), ['entry', 'target', 'source'], 'composio'), 'Contradictory private sources are rejected.');
invalid(changed(fixedMcp(), ['entry', 'selection', 'target', 'connectionRef'], `mcp-personal:${secondConnectionId}`), 'MCP identity must match the actual UUID.');
invalid(changed(fixedMcp(), ['entry', 'target', 'personalBinding', 'connectionId'], 'server-display-name'), 'MCP names cannot replace UUIDs.');
invalid(changed(fixedMcp(), ['entry', 'target', 'personalBinding', 'serverDefinitionId'], 'definition-label'), 'Definition identity is a UUID or null.');
invalid(changed(fixedMcp(), ['entry', 'target', 'boundProviderRef'], `mcp:v1:personal:${'c'.repeat(64)}`), 'The bound hash must match the exact canonical private identity.');
invalid(changed(fixedMcp(), ['entry', 'target', 'providerRef'], personalMcp(secondConnectionId).providerRef), 'The base provider scope is regenerated from the exact identity.');
invalid(changed(fixedComposio(), ['entry', 'selection', 'toolkit'], 'slack'), 'The selected toolkit cannot contradict the durable target.');
invalid(changed(fixedComposio(), ['entry', 'selection', 'target', 'profileId'], 'profile-bob'), 'The selected profile is exact.');
invalid(changed(fixedComposio(), ['entry', 'selection', 'target', 'accountId'], 'ca_bob'), 'The selected account is exact.');
invalid(changed(fixedComposio(), ['entry', 'target', 'personalBinding', 'connectedAccountId'], null), 'Account bindings require an exact account.');
invalid(changed(fixedComposio(true), ['entry', 'target', 'personalBinding', 'connectedAccountId'], 'ca_alice'), 'No-auth bindings cannot retain a hidden account.');
invalid(changed(fixedComposio(true), ['entry', 'selection', 'target', 'accountId'], 'ca_alice'), 'No-auth public identities cannot carry accounts.');
invalid(changed(fixedComposio(), ['entry', 'target', 'personalBinding', 'mode'], 'other'), 'Only known provider modes are accepted.');
invalid(changed(fixedComposio(), ['entry', 'selection', 'toolkit'], 'Canva'), 'Toolkits are canonical, not labels.');
invalid(changed(shared, ['entry', 'target', 'connectionRef'], `canvas-connection:${secondConnectionId}`), 'Shared public and private references must match.');
invalid(changed(shared, ['entry', 'target', 'bindingRevision'], 4), 'Shared public and private source revisions must match.');
for (const badRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
  invalid(changed(shared, ['entry', 'target', 'bindingRevision'], badRevision), 'Source revisions must be safe positive integers.');
}
for (const [fields, value] of [
  [['accountSelectionRef'], 'cmp_personal_account_private_receipt'],
  [['entry', 'accountSelectionRef'], 'cmp_personal_account_private_receipt'],
  [['entry', 'target', 'accountSelectionRef'], 'cmp_personal_account_private_receipt'],
  [['entry', 'target', 'personalBinding', 'accessToken'], 'PRIVATE_TOKEN'],
  [['entry', 'target', 'headers'], { Authorization: 'PRIVATE_TOKEN' }],
  [['entry', 'selection', 'label'], 'Client selected label'],
  [['entry', 'target', 'verifiedMcpMapping'], { connector: 'Fake connector' }],
] as const) invalid(changed(fixedMcp(), fields, value), 'Receipts, labels and credentials never belong in stored bindings.');
invalid(changed(fixedMcp(), ['entry', 'accountSelectionRef'], undefined), 'Undefined receipt fields must not disappear during JSON copying.');
invalid(changed(fixedMcp(), ['entry', 'toolCap'], ['READ', 'READ']), 'Tool capabilities preserve exact unique names.');
invalid(changed(fixedMcp(), ['entry', 'toolCap'], ['READ\u0000']), 'Control characters cannot enter exact tool caps.');
invalid(changed(fixedMcp(), ['entry', 'requirement'], 'recommended'), 'Only explicit optional and required are accepted.');
invalid(changed(fixedMcp(), ['kind'], 'plugin'), 'Package data cannot masquerade as a standalone connection row.');
invalid(changed(fixedMcp(), ['version'], 2), 'Unknown private codec versions fail closed.');
invalid(changed(fixedMcp(), ['configurationId'], ' x '), 'Logical slots are bounded exact metadata.');

const selectable = {
  version: 1,
  kind: 'standalone',
  configurationId: 'personal-or-shared-canva',
  mode: 'selectable',
  source: 'composio',
  toolkit: 'canva',
  requirement: 'required',
  allowedChoices: [
    { choiceId: 'shared', selection: shared.entry.selection, target: shared.entry.target, toolCap: ['READ'] },
    { choiceId: 'personal', selection: fixedComposio().entry.selection, target: personalComposio(), toolCap: [] },
  ],
  defaultChoiceId: 'shared',
  personalPolicy: { source: 'composio', toolkit: 'canva', toolCap: null },
};
assert.deepEqual(parseStoredStandaloneExtensionBinding(selectable), selectable);
const parsedSelectable = parseStoredStandaloneExtensionBinding(selectable);
assert.equal(parsedSelectable.mode, 'selectable');
if (parsedSelectable.mode !== 'selectable') throw new Error('Expected selectable fixture.');
assert(Object.isFrozen(parsedSelectable.allowedChoices));
assert(Object.isFrozen(parsedSelectable.allowedChoices[0]));
assert(Object.isFrozen(parsedSelectable.personalPolicy));
invalid(changed(selectable, ['allowedChoices', 1, 'choiceId'], 'shared'), 'Choice IDs must be unique.');
invalid(changed(selectable, ['allowedChoices', 1], { ...selectable.allowedChoices[0], choiceId: 'same-exact-source' }), 'Aliases cannot duplicate an exact connection with conflicting caps.');
invalid(changed(selectable, ['defaultChoiceId'], 'missing'), 'Default choice must exist.');
invalid(changed(selectable, ['allowedChoices', 0, 'selection', 'toolkit'], 'slack'), 'All selectable choices match the exact configured toolkit.');
invalid(changed(selectable, ['personalPolicy', 'toolkit'], 'slack'), 'Personal policies cannot widen the configured toolkit.');
invalid(changed(selectable, ['source'], 'unknown'), 'Only known sources are allowed.');
invalid(changed(selectable, ['personalPolicy'], { source: 'mcp', serverDefinitionIds: [definitionId], toolCap: null }), 'Personal policies cannot change source.');
invalid(changed(selectable, ['toolkit'], undefined), 'Composio slots require a toolkit.');
invalid(changed(selectable, ['allowedChoices'], Array.from({ length: 33 }, (_, index) => ({ ...selectable.allowedChoices[0], choiceId: String(index) }))), 'Choice counts are bounded.');

const mcpSelectable = {
  version: 1, kind: 'standalone', configurationId: 'own-approved-mcp', mode: 'selectable', source: 'mcp', requirement: 'optional',
  allowedChoices: [{ choiceId: 'own', selection: fixedMcp().entry.selection, target: personalMcp(), toolCap: null }],
  personalPolicy: { source: 'mcp', serverDefinitionIds: [definitionId], toolCap: [] },
};
assert.deepEqual(parseStoredStandaloneExtensionBinding(mcpSelectable), mcpSelectable);
invalid(changed(mcpSelectable, ['toolkit'], 'canva'), 'MCP slots cannot declare a Composio toolkit.');
invalid(changed(mcpSelectable, ['personalPolicy', 'serverDefinitionIds'], [definitionId, definitionId]), 'Permitted definitions must be unique.');
invalid(changed(mcpSelectable, ['personalPolicy', 'serverDefinitionIds'], []), 'Personal MCP policy names an explicit approved set.');
invalid(changed(mcpSelectable, ['personalPolicy', 'serverDefinitionIds'], ['Friendly server']), 'Personal definition policies use UUIDs.');
const policyOnly = { ...mcpSelectable, allowedChoices: [] };
assert.deepEqual(parseStoredStandaloneExtensionBinding(policyOnly), policyOnly, 'A permitted per-user policy can await the user’s explicit selection.');
invalid(changed(policyOnly, ['defaultChoiceId'], 'own'), 'An empty configured set cannot invent a default.');

const reordered = fixedComposio();
reordered.entry.target.personalBinding = Object.fromEntries(Object.entries(reordered.entry.target.personalBinding).reverse()) as typeof reordered.entry.target.personalBinding;
assert.equal(parseStoredStandaloneExtensionBinding(reordered).mode, 'fixed', 'Canonical binding field order matches existing generated hashes.');
assert.equal(parseStoredStandaloneExtensionBinding(fixedMcp(connectionId, 'unverified-owner')).mode, 'fixed', 'Syntax validates consistency, never actual ownership authority.');
invalid('cmp_personal_account_private_receipt', 'A raw account receipt is not a private binding.');
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
invalid(cyclic, 'Cyclic and non-JSON inputs are rejected.');
invalid(new Date(), 'Non-JSON instances cannot hide private fields with toJSON.');
invalid(changed(fixedMcp(), ['entry', 'toolCap'], new Array(2)), 'Sparse arrays cannot turn into null tool names.');
invalid(changed(fixedMcp(), ['configurationId'], 'x'.repeat(1_048_577)), 'Serialized input is bounded.');

const packageFixture = {
  version: 1,
  resourceRef: `canvas-resource:${connectionId}`,
  publishedRevisionRef: `canvas-package-revision:${secondConnectionId}`,
  checksum: 'c'.repeat(64),
  skillSelection: { kind: 'skills', relativeRoots: [''] },
  selectedSkills: [{ name: 'existing-skill', relativeRoot: '' }],
  declarations: [],
};
assert.deepEqual(parseStoredAgentWorkflowPackage(packageFixture), packageFixture, 'Existing private PackageV1 retains its original codec and shape.');
invalid(packageFixture, 'The standalone codec never absorbs PackageV1.');

console.log('PASS strict durable standalone bindings, exact identities and derived refs, selection policies, receipt rejection, frozen copies and unchanged PackageV1.');
