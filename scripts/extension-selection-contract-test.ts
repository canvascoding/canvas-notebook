import assert from 'node:assert/strict';
import { z } from 'zod';
import { agentExtensionConfigurationInputSchema, agentStandaloneConfigurationInputSchema, chatExtensionSelectionInputSchema,
  chatExtensionSelectionSchema, extensionSelectionSchema, extensionSelectionInputSchema, extensionSelectionIdentity,
  extensionToolCapSchema, EXTENSION_SELECTION_LIMITS, type ExtensionSelection, type ExtensionSelectionInput } from '../app/lib/capabilities/extensions/contracts';
import { createPersonalComposioAccountReference, readPersonalComposioAccountReference } from '../app/lib/composio/composio-shared-account-reference';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';
import { storedStandaloneExtensionBindingSchema } from '../app/lib/capabilities/extensions/stored-contracts';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const pin = { resourceRef: `canvas-resource:${id(1)}`, publishedRevisionRef: `canvas-package-revision:${id(2)}`, checksum: 'a'.repeat(64) };
const sharedRef = `canvas-connection:${id(3)}`;
const personalRef = `mcp-personal:${id(4)}`;
const profileId = id(5), accountId = 'ca_explicit_account';
const plugin: ExtensionSelection = { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } };
const child: ExtensionSelection = { kind: 'skill', package: pin, origin: 'plugin_child', relativeRoot: 'skills/brief' };
const rootChild: ExtensionSelection = { ...child, relativeRoot: '' };
const standaloneSkill: ExtensionSelection = { kind: 'skill', package: { ...pin, resourceRef: `canvas-resource:${id(6)}`,
  publishedRevisionRef: `canvas-package-revision:${id(7)}` }, origin: 'standalone', relativeRoot: '' };
const mcp: ExtensionSelection = { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: personalRef } };
const sharedMcp: ExtensionSelection = { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: sharedRef, bindingRevision: 2 } };
const account: ExtensionSelection = { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId,
  accountBinding: 'account', accountId, connectionRef: `composio-personal:${profileId}:${accountId}` } };
const noAuth: ExtensionSelection = { kind: 'composio', source: 'composio', toolkit: 'duck_duck_go',
  target: { kind: 'personal', profileId, accountBinding: 'no_auth' } };
const sharedComposio: ExtensionSelection = { kind: 'composio', source: 'composio', toolkit: 'canva',
  target: { kind: 'shared', connectionRef: `canvas-connection:${id(8)}`, bindingRevision: 1 } };
const entry = (selection: ExtensionSelection): ExtensionSelectionInput => ({ selection, requirement: 'optional', toolCap: null });
const chat = (selections: unknown[]) => ({ version: 1, origin: 'turn_reference', selections });
const fixed = (selections: unknown[], workflow: unknown = null, standalone: unknown[] = []) =>
  ({ version: 1, origin: 'agent_configuration', mode: 'fixed', selections, workflow, standalone });
const workflow = { version: 1, packages: [{ ...pin, skillSelection: { kind: 'plugin' }, declarations: [{
  declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'design', required: true,
    selection: { mode: 'selectable', allowedChoices: [{ choiceId: 'team-canva', alternativeKey: 'composio:canva',
      target: { kind: 'shared', source: 'composio', connectionRef: sharedComposio.target.kind === 'shared' ? sharedComposio.target.connectionRef : '', bindingRevision: 1 },
      toolCap: ['CANVA_CREATE_DESIGN'] }], defaultChoiceId: 'team-canva', personalPolicy: { sources: ['composio'],
      alternativeKeys: ['composio:canva'], toolCap: ['CANVA_CREATE_DESIGN'] } } }] }] }] };
let assertions = 0;
function accepts(schema: z.ZodType, value: unknown, message: string) { assertions += 1; assert(schema.safeParse(value).success, message); }
function rejects(schema: z.ZodType, value: unknown, message: string) { assertions += 1; assert.equal(schema.safeParse(value).success, false, message); }

const previousSecret = process.env.BETTER_AUTH_SECRET;
process.env.BETTER_AUTH_SECRET = 'synthetic-extension-contract-test-secret-with-no-production-authority';
try {
  const providerRef = createIntegrationProviderRef({ source: 'composio', scope: { type: 'user', ownerUserId: 'fixture-owner',
    resourceId: `profile:${profileId}:canva` }, profileId, toolkit: 'canva' });
  const receipt = createPersonalComposioAccountReference({ actorUserId: 'fixture-owner', workspaceId: 'fixture-workspace', organizationId: 'fixture-org',
    providerRef, profileId, cacheRevision: 'fixture-profile-revision', toolkit: 'canva', accountId, credentialRevision: 'fixture-credential-revision' });
  assert.equal(readPersonalComposioAccountReference(receipt).accountId, accountId, 'Use the existing sealed receipt issuer, not an invented account reference');
  const accountInput = { ...entry(account), accountSelectionRef: receipt };
  for (const selection of [plugin, child, rootChild, standaloneSkill, mcp, sharedMcp, account, noAuth, sharedComposio])
    accepts(extensionSelectionSchema, selection, 'All actual canonical identity kinds parse unchanged');
  accepts(extensionSelectionInputSchema, accountInput, 'An explicitly confirmed own account uses its existing receipt');
  rejects(extensionSelectionInputSchema, entry(account), 'Even a single account needs explicit sealed confirmation at initial acceptance');
  rejects(extensionSelectionSchema, { ...account, accountSelectionRef: receipt }, 'A choice receipt is not canonical durable identity');
  accepts(chatExtensionSelectionInputSchema, chat([accountInput]), 'Intake accepts a receipt with its exact account identity');
  rejects(chatExtensionSelectionSchema, chat([accountInput]), 'Accepted queue/history envelope cannot persist a five-minute input receipt');
  accepts(chatExtensionSelectionSchema, chat([entry(account)]), 'Accepted public identity is distinct from server-private materialization/authority');
  for (const selection of [mcp, noAuth, sharedComposio, plugin]) rejects(extensionSelectionInputSchema,
    { ...entry(selection), accountSelectionRef: receipt }, 'Only an own authenticated Composio account can carry its receipt');
  rejects(extensionSelectionInputSchema, { ...accountInput, accountSelectionRef: receipt.replace('cmp_personal_account_', 'cmp_account_') }, 'Shared and personal sealed receipts cannot be confused');
  rejects(extensionSelectionInputSchema, { ...accountInput, accountSelectionRef: accountId }, 'Raw account ID is not a sealed choice receipt');
  rejects(extensionSelectionInputSchema, { ...accountInput, accountSelectionRef: `cmp_personal_account_${'x'.repeat(8_193)}` }, 'Receipts remain bounded');
  rejects(extensionSelectionSchema, { ...account, target: { ...account.target, connectionRef: `composio-personal:${id(9)}:${accountId}` } }, 'Display reference and exact profile/account identity must agree');
  rejects(extensionSelectionSchema, { ...noAuth, target: { ...noAuth.target, accountId } }, 'No-auth is not a fabricated account');
  for (const field of ['providerRef', 'toolRef', 'schemaRef', 'apiKey', 'credentials', 'skillText', 'healthy', 'canUse', 'entityId', 'displayName'])
    rejects(extensionSelectionSchema, { ...mcp, [field]: 'untrusted-client-value' }, 'Client metadata and private authority do not enter canonical identity');
  rejects(extensionSelectionSchema, { ...mcp, target: { kind: 'personal', connectionRef: 'mcp:Canva' } }, 'Legacy display-name aliases cannot impersonate durable personal connections');
  rejects(extensionSelectionSchema, { ...mcp, source: 'composio' }, 'Kind and source agree');
  for (const root of ['../private', '/private', 'file:secret', 'skills//brief', 'skills/./brief', 'skills/brief\\private', 'skills/brief\u0000'])
    rejects(extensionSelectionSchema, { ...child, relativeRoot: root }, 'Published child roots cannot traverse or transform');
  accepts(extensionSelectionSchema, { ...plugin, skillSelection: { kind: 'subset', relativeRoots: ['', 'skills/brief'] } }, 'A real plugin can declare a root SKILL.md; origin still distinguishes it');
  rejects(extensionSelectionSchema, { ...plugin, skillSelection: { kind: 'subset', relativeRoots: ['skills/brief', 'skills/brief'] } }, 'Duplicate selected child roots are rejected');
  rejects(chatExtensionSelectionSchema, chat([entry(rootChild), entry({ ...rootChild, origin: 'standalone' })]), 'One immutable root cannot enter twice through contradictory standalone/child source assumptions');
  rejects(chatExtensionSelectionSchema, chat([entry(mcp), { ...entry(mcp), requirement: 'required', toolCap: [] }]), 'Requirement/cap changes do not manufacture a new exact connection');
  accepts(chatExtensionSelectionSchema, chat([entry(account), entry({ ...account, target: { kind: 'personal', profileId, accountBinding: 'account',
    accountId: 'ca_second_account', connectionRef: `composio-personal:${profileId}:ca_second_account` } })]), 'Different accounts remain distinct');
  rejects(chatExtensionSelectionSchema, chat([entry(plugin), entry({ ...child, package: { ...pin, checksum: 'b'.repeat(64) } })]), 'One immutable revision cannot carry contradictory checksums');
  accepts(chatExtensionSelectionSchema, chat([entry(plugin), entry({ ...plugin, package: { ...pin, publishedRevisionRef: `canvas-package-revision:${id(10)}` } })]), 'Different held versions are not silently merged');
  rejects(chatExtensionSelectionSchema, chat(Array.from({ length: 6 }, (_, index) => entry({ ...mcp,
    target: { kind: 'personal', connectionRef: `mcp-personal:${id(20 + index)}` } }))), 'Turn selection count is limited separately from agent configuration');
  accepts(extensionToolCapSchema, null, 'Null means all tools within current authority');
  accepts(extensionToolCapSchema, [], 'Empty cap means no callable tools');
  rejects(extensionToolCapSchema, ['READ', 'READ'], 'Case-sensitive tool names are exact and unique');
  accepts(extensionToolCapSchema, ['READ', 'read'], 'Distinct actual tool names are not normalized together');
  for (const name of [' READ', 'READ\n', 'READ\u200b']) rejects(extensionToolCapSchema, [name], 'Names stay exact without trimming/control removal');
  rejects(extensionToolCapSchema, Array.from({ length: 257 }, (_, index) => `TOOL_${index}`), 'Tool caps preserve the existing bounded limit');
  accepts(agentExtensionConfigurationInputSchema, { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' }, 'Existing inheritance has an explicit separate representation');
  accepts(agentExtensionConfigurationInputSchema, fixed([]), 'A new fixed empty configuration is representable without granting inheritance');
  rejects(agentExtensionConfigurationInputSchema, { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit', selections: [] }, 'Inheritance cannot secretly carry a fixed selection');
  const aggregate = fixed([entry(plugin), entry(child)], workflow, [{ mode: 'fixed', entry: accountInput }]);
  const parsed = agentExtensionConfigurationInputSchema.parse(aggregate);
  assert(parsed.mode === 'fixed'); assert.deepEqual(parsed.workflow, workflow, 'Preserve exact V1 declaration choices, required state, personal policy and tool caps');
  accepts(agentExtensionConfigurationInputSchema, fixed([entry({ ...plugin, skillSelection: { kind: 'subset', relativeRoots: [] } })], workflow),
    'An empty optional-child mask keeps plugin scope and all parent declarations');
  rejects(agentExtensionConfigurationInputSchema, fixed([entry(plugin)], { version: 1, packages: [{ ...pin, skillSelection: { kind: 'skills', relativeRoots: ['skills/brief'] }, declarations: [] }] }),
    'Plugin subset cannot be implemented by dropping the parent declaration scope');
  rejects(agentExtensionConfigurationInputSchema, fixed([entry(plugin)], { ...workflow, packages: [{ ...workflow.packages[0], publishedRevisionRef: `canvas-package-revision:${id(11)}` }] }), 'Public selection and preserved workflow cannot disagree on revision');
  rejects(agentExtensionConfigurationInputSchema, fixed([entry(plugin)], { ...workflow, packages: [{ ...workflow.packages[0], checksum: 'b'.repeat(64) }] }), 'Public selection and preserved workflow cannot disagree on checksum');
  rejects(agentExtensionConfigurationInputSchema, fixed([], workflow), 'A hidden unrelated workflow package is not an explicit selection');
  rejects(agentExtensionConfigurationInputSchema, fixed([entry(plugin)]), 'A thin plugin identity cannot replace full package binding choices');
  rejects(agentExtensionConfigurationInputSchema, fixed([entry(mcp)]), 'Standalone choice slots must be explicit rather than embedded in package metadata');
  const choice = { choiceId: 'team', selection: sharedComposio, toolCap: [] };
  const selectable = { mode: 'selectable', configurationId: 'marketing-canva', source: 'composio', toolkit: 'canva', requirement: 'required',
    allowedChoices: [choice], defaultChoiceId: 'team', personalPolicy: { source: 'composio', toolkit: 'canva', toolCap: ['CANVA_CREATE_DESIGN'] } };
  accepts(agentStandaloneConfigurationInputSchema, selectable, 'Organization standalone can permit each actor own choice without a fake package');
  const definitionId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const approvedMcp = { mode: 'selectable', configurationId: 'approved-mcp', source: 'mcp', requirement: 'optional', allowedChoices: [],
    personalPolicy: { source: 'mcp', serverDefinitionIds: [definitionId], toolCap: null } };
  accepts(agentStandaloneConfigurationInputSchema, approvedMcp, 'MCP personal choice uses actual canonical definition UUIDs');
  accepts(storedStandaloneExtensionBindingSchema, { version: 1, kind: 'standalone', ...approvedMcp }, 'The same approved UUID policy is accepted by the private durable codec');
  for (const invalidId of ['approved-definition', definitionId.toUpperCase(), ` ${definitionId}`, definitionId + '\u200b']) {
    const invalidPolicy = { ...approvedMcp, personalPolicy: { ...approvedMcp.personalPolicy, serverDefinitionIds: [invalidId] } };
    rejects(agentStandaloneConfigurationInputSchema, invalidPolicy, 'Public policy cannot accept a definition identity the existing publisher rejects');
    rejects(storedStandaloneExtensionBindingSchema, { version: 1, kind: 'standalone', ...invalidPolicy }, 'Public and private definition grammar remain consistent');
  }
  rejects(agentStandaloneConfigurationInputSchema, { ...selectable, defaultChoiceId: 'unlisted' }, 'Default cannot pick an unlisted first account');
  rejects(agentStandaloneConfigurationInputSchema, { ...selectable, allowedChoices: [choice, { ...choice, choiceId: 'other' }] }, 'Repeated exact account cannot get conflicting caps through duplicate allowed choices');
  rejects(agentStandaloneConfigurationInputSchema, { ...selectable, allowedChoices: [{ ...choice, selection: sharedMcp }] }, 'Choice source cannot differ from slot source');
  rejects(agentStandaloneConfigurationInputSchema, { ...selectable, toolkit: 'linkedin' }, 'Composio choice must preserve exact configured toolkit');
  rejects(agentStandaloneConfigurationInputSchema, { ...selectable, personalPolicy: { ...selectable.personalPolicy, ownerUserId: 'creator' } }, 'Per-user policy cannot silently embed creator account');
  rejects(agentStandaloneConfigurationInputSchema, { ...selectable, personalPolicy: { source: 'mcp', serverDefinitionIds: ['approved'], toolCap: null } }, 'Per-user policy cannot change source');
  rejects(agentExtensionConfigurationInputSchema, fixed([], null, [selectable, { ...selectable, allowedChoices: [] }]), 'Logical standalone slot IDs are agent-local and unique');
  rejects(agentExtensionConfigurationInputSchema, fixed([], null, [{ mode: 'fixed', configurationId: 'a', entry: entry(mcp) },
    { mode: 'fixed', configurationId: 'b', entry: { ...entry(mcp), toolCap: [] } }]), 'Fixed and selectable configuration cannot duplicate exact standalone identity to widen caps');
  accepts(agentExtensionConfigurationInputSchema, fixed([], null, Array.from({ length: 6 }, (_, index) => ({ mode: 'fixed', entry: entry({ ...mcp,
    target: { kind: 'personal', connectionRef: `mcp-personal:${id(40 + index)}` } }) }))), 'Agent configuration is not reduced to the five-turn limit');
  const largeCaps = Array.from({ length: 256 }, (_, index) => `工具${index}${'é'.repeat(100)}`);
  rejects(agentExtensionConfigurationInputSchema, fixed([], null, Array.from({ length: 24 }, (_, index) => ({ mode: 'fixed', entry: { ...entry({ ...mcp,
    target: { kind: 'personal', connectionRef: `mcp-personal:${id(60 + index)}` } }), toolCap: largeCaps } }))), 'Combined UTF-8 envelope size is bounded, not just JS string length');
  const oversizedReceipts = Array.from({ length: 5 }, (_, slot) => ({ ...selectable, configurationId: `receipt-slot-${slot}`, defaultChoiceId: undefined,
    allowedChoices: Array.from({ length: 32 }, (_, index) => {
      const chosenAccountId = `ca_receipt_${slot}_${index}`;
      return { choiceId: `choice-${index}`, selection: { ...account, target: { kind: 'personal', profileId, accountBinding: 'account',
        accountId: chosenAccountId, connectionRef: `composio-personal:${profileId}:${chosenAccountId}` } }, toolCap: null,
      accountSelectionRef: `cmp_personal_account_${'a'.repeat(7_900)}` };
    }) }));
  accepts(agentStandaloneConfigurationInputSchema, oversizedReceipts[0], 'Each individual bounded receipt slot is structurally valid; cryptographic authority is checked later');
  rejects(agentExtensionConfigurationInputSchema, fixed([entry(plugin)], workflow, oversizedReceipts),
    'The combined valid V1 workflow and syntactically valid bounded receipts still cannot exceed the aggregate byte limit');
  assert.equal(EXTENSION_SELECTION_LIMITS.tools, 256);
  assert.notEqual(extensionSelectionIdentity(mcp), extensionSelectionIdentity(sharedMcp));
  assert.equal(extensionSelectionIdentity(rootChild), extensionSelectionIdentity({ ...rootChild, origin: 'standalone' }), 'Source claims cannot evade semantic identity deduplication');
  z.toJSONSchema(agentExtensionConfigurationInputSchema, { target: 'draft-7', io: 'input' });
  console.log(`PASS ${assertions} strict shared extension contract cases: actual canonical refs/receipts, immutable pins/child roots, full V1 preservation, standalone choices/policies, input-vs-accepted lifetimes, caps and byte limits. Syntax checks do not prove current actor/provider authority.`);
} finally {
  if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret;
}
