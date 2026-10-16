import { z } from 'zod';
import { agentWorkflowConfigurationSchema, parseAgentWorkflowConfiguration } from '@/app/lib/agents/workflow-public-contracts';
import { corePluginExtensionSelectionSchema, coreSkillExtensionSelectionSchema, isCoreExtensionSelection } from './core-source-contracts';

export const EXTENSION_SELECTION_LIMITS = Object.freeze({ turn: 5, agent: 256, sharedConnections: 128, children: 128, tools: 256, choices: 32, definitions: 32, bytes: 1_048_576 });
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const identifier = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const resourceRef = z.string().regex(new RegExp(`^canvas-resource:${uuid}$`, 'u'));
const publishedRevisionRef = z.string().regex(new RegExp(`^canvas-package-revision:${uuid}$`, 'u'));
const connectionRef = z.string().regex(new RegExp(`^canvas-connection:${uuid}$`, 'u'));
const relativeRoot = z.string().max(1_024).refine(value => value === '' || value === value.trim()
  && !/^[A-Za-z][A-Za-z0-9+.-]*:|^[\/]|[\\\p{Cc}\p{Cf}]/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const uniqueRoots = z.array(relativeRoot).max(EXTENSION_SELECTION_LIMITS.children)
  .refine(values => new Set(values).size === values.length);

export const extensionPackagePinSchema = z.object({ resourceRef, publishedRevisionRef,
  checksum: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const extensionToolCapSchema = z.array(identifier).max(EXTENSION_SELECTION_LIMITS.tools).nullable()
  .refine(values => values === null || new Set(values).size === values.length);
const sharedConnection = z.object({ kind: z.literal('shared'), connectionRef, bindingRevision: revision }).strict();
const personalMcpConnection = z.object({ kind: z.literal('personal'),
  connectionRef: z.string().regex(new RegExp(`^mcp-personal:${uuid}$`, 'u')) }).strict();
const personalComposioAccount = z.object({ kind: z.literal('personal'), profileId: identifier,
  accountBinding: z.literal('account'), accountId: identifier, connectionRef: z.string().min(1).max(1_024) }).strict()
  .refine(value => value.connectionRef === `composio-personal:${value.profileId}:${value.accountId}`);
const personalComposioNoAuth = z.object({ kind: z.literal('personal'), profileId: identifier,
  accountBinding: z.literal('no_auth') }).strict();
const toolkit = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/u);
const composioSelection = z.object({ kind: z.literal('composio'), source: z.literal('composio'), toolkit,
  target: z.union([sharedConnection, personalComposioAccount, personalComposioNoAuth]) }).strict();
const mcpSelection = z.object({ kind: z.literal('mcp'), source: z.literal('mcp'), target: z.union([sharedConnection, personalMcpConnection]) }).strict();
export const standaloneExtensionSelectionSchema = z.discriminatedUnion('kind', [composioSelection, mcpSelection]);

/** Exact public identity only. Parsing never grants use or proves current source/actor authority. */
export const extensionSelectionSchema = z.discriminatedUnion('kind', [
  corePluginExtensionSelectionSchema,
  coreSkillExtensionSelectionSchema,
  z.object({ kind: z.literal('plugin'), package: extensionPackagePinSchema,
    skillSelection: z.discriminatedUnion('kind', [z.object({ kind: z.literal('all') }).strict(),
      z.object({ kind: z.literal('subset'), relativeRoots: uniqueRoots }).strict()]) }).strict(),
  z.object({ kind: z.literal('skill'), package: extensionPackagePinSchema,
    origin: z.enum(['standalone', 'plugin_child']), relativeRoot }).strict()
    .refine(value => value.origin !== 'standalone' || value.relativeRoot === ''),
  // The management catalogue's UI kind "integration" maps explicitly to this source.
  composioSelection, mcpSelection,
]);
export type ExtensionSelection = z.infer<typeof extensionSelectionSchema>;
export type ExtensionPackagePin = z.infer<typeof extensionPackagePinSchema>;
export type StandaloneExtensionSelection = Extract<ExtensionSelection, { kind: 'mcp' | 'composio' }>;

export const extensionSelectionEntrySchema = z.object({ selection: extensionSelectionSchema,
  requirement: z.enum(['optional', 'required']), toolCap: extensionToolCapSchema }).strict().superRefine((entry,context)=>{
    if(isCoreExtensionSelection(entry.selection)&&entry.toolCap!==null) context.addIssue({code:'custom',path:['toolCap'],
      message:'Core plugin instruction selections use a null tool capability field.'});
  });
export type ExtensionSelectionEntry = z.infer<typeof extensionSelectionEntrySchema>;

const declarationPath = relativeRoot.refine(value => value.length > 0);
const connector = z.string().min(1).max(128).refine(value => value === value.trim()
  && !/[\u0000-\u0020\u007f/\\:\p{Cc}\p{Cf}]/u.test(value));
const packageAlternativeKey = z.string().min(1).max(137).refine(value => value.startsWith('mcp:')
  ? connector.safeParse(value.slice(4)).success
  : value.startsWith('composio:') && toolkit.safeParse(value.slice(9)).success);

/** Explicit declaration-to-selected-connection intent. Syntax never proves a package declaration or use rights. */
export const extensionPackageConnectionSchema = z.object({
  package: extensionPackagePinSchema,
  declarationPath,
  capabilityId: identifier,
  alternativeKey: packageAlternativeKey,
  connectionSelection: standaloneExtensionSelectionSchema,
}).strict().superRefine((value, context) => {
  const selected = value.connectionSelection;
  const coherent = selected.kind === 'mcp' ? value.alternativeKey.startsWith('mcp:')
    : value.alternativeKey === `composio:${selected.toolkit}`;
  if (!coherent) context.addIssue({ code: 'custom', path: ['alternativeKey'],
    message: 'The package alternative must preserve the selected source and exact Composio toolkit.' });
});
export type ExtensionPackageConnection = z.infer<typeof extensionPackageConnectionSchema>;

function packagePinIdentity(pin: ExtensionPackagePin): string {
  return JSON.stringify([pin.resourceRef, pin.publishedRevisionRef, pin.checksum]);
}

function checkPackageConnections(entries: readonly ExtensionSelectionEntry[],
  connections: readonly ExtensionPackageConnection[] | undefined, context: z.RefinementCtx) {
  const pins = new Set(entries.flatMap(entry => entry.selection.kind === 'plugin' || entry.selection.kind === 'skill'
    ? [packagePinIdentity(entry.selection.package)] : []));
  // Include the complete normalized selection, especially the shared binding revision.
  const selectedConnections = new Set(entries.filter(entry => entry.selection.kind === 'mcp' || entry.selection.kind === 'composio')
    .map(entry => JSON.stringify(entry.selection)));
  const slots = new Set<string>();
  connections?.forEach((connection, index) => {
    const pin = packagePinIdentity(connection.package);
    const slot = JSON.stringify([pin, connection.declarationPath, connection.capabilityId]);
    if (slots.has(slot)) context.addIssue({ code: 'custom', path: ['packageConnections', index],
      message: 'A package declaration capability can have only one explicit connection mapping.' });
    slots.add(slot);
    if (!pins.has(pin)) context.addIssue({ code: 'custom', path: ['packageConnections', index, 'package'],
      message: 'The mapping requires the same exact package pin among the selected plugins or skills.' });
    if (!selectedConnections.has(JSON.stringify(connection.connectionSelection))) {
      context.addIssue({ code: 'custom', path: ['packageConnections', index, 'connectionSelection'],
        message: 'The mapping requires the complete exact connection selection among the selected entries.' });
    }
  });
}

/** Sealed five-minute existing account-choice receipt, consumed by the server before acceptance. */
const accountSelectionRef = z.string().max(8_192).regex(/^cmp_personal_account_[A-Za-z0-9_-]{39,}$/u);
const retainedBindingRef = z.string().regex(/^agent-extension-retain:v1:[a-f0-9]{64}$/u);
function checkAccountReceipt(value: { selection: ExtensionSelection; accountSelectionRef?: string }, context: z.RefinementCtx) {
  const needsAccount = value.selection.kind === 'composio' && value.selection.target.kind === 'personal'
    && value.selection.target.accountBinding === 'account';
  if (needsAccount !== (value.accountSelectionRef !== undefined)) context.addIssue({ code: 'custom', path: ['accountSelectionRef'],
    message: 'An exact personal Composio account requires its current sealed selection receipt; other selections cannot carry one.' });
}
export const extensionSelectionInputSchema = extensionSelectionEntrySchema.safeExtend({ accountSelectionRef: accountSelectionRef.optional() }).strict()
  .superRefine(checkAccountReceipt);
export type ExtensionSelectionInput = z.infer<typeof extensionSelectionInputSchema>;
export const standaloneExtensionEntrySchema = z.object({ selection: standaloneExtensionSelectionSchema,
  requirement: z.enum(['optional', 'required']), toolCap: extensionToolCapSchema }).strict();
export const standaloneExtensionInputSchema = standaloneExtensionEntrySchema.extend({ accountSelectionRef: accountSelectionRef.optional() }).strict()
  .superRefine(checkAccountReceipt);
export type StandaloneExtensionInput = z.infer<typeof standaloneExtensionInputSchema>;

/** Agent-edit retention is separate from initial chat/account admission. */
function checkAgentStandaloneReceipt(value: { selection: ExtensionSelection; accountSelectionRef?: string; retainedBindingRef?: string },
  context: z.RefinementCtx) {
  if (value.retainedBindingRef !== undefined) {
    if (value.accountSelectionRef !== undefined) context.addIssue({ code: 'custom', path: ['retainedBindingRef'],
      message: 'Retain one exact stored binding or select a new account, not both.' });
    return;
  }
  checkAccountReceipt(value, context);
}
export const agentStandaloneEntryInputSchema = standaloneExtensionEntrySchema.extend({
  accountSelectionRef: accountSelectionRef.optional(), retainedBindingRef: retainedBindingRef.optional(),
}).strict().superRefine(checkAgentStandaloneReceipt);
export type AgentStandaloneEntryInput = z.infer<typeof agentStandaloneEntryInputSchema>;

export const agentStandalonePersonalPolicySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('composio'), toolkit, toolCap: extensionToolCapSchema }).strict(),
  z.object({ source: z.literal('mcp'), toolCap: extensionToolCapSchema,
    serverDefinitionIds: z.array(z.string().regex(new RegExp(`^${uuid}$`, 'u'))).min(1).max(EXTENSION_SELECTION_LIMITS.definitions)
      .refine(values => new Set(values).size === values.length) }).strict(),
]);
const standaloneChoice = z.object({ choiceId: identifier, selection: standaloneExtensionSelectionSchema,
  toolCap: extensionToolCapSchema, accountSelectionRef: accountSelectionRef.optional(),
  retainedBindingRef: retainedBindingRef.optional() }).strict().superRefine(checkAgentStandaloneReceipt);
const selectableFields = { mode: z.literal('selectable'), configurationId: identifier, requirement: z.enum(['optional', 'required']),
  allowedChoices: z.array(standaloneChoice).max(EXTENSION_SELECTION_LIMITS.choices), defaultChoiceId: identifier.optional(),
  personalPolicy: agentStandalonePersonalPolicySchema.optional() };
/** Configuration IDs identify agent-local choice slots; they carry no provider routing authority. */
export const agentStandaloneConfigurationInputSchema = z.union([
  z.object({ mode: z.literal('fixed'), configurationId: identifier.optional(), entry: agentStandaloneEntryInputSchema }).strict(),
  z.object({ ...selectableFields, source: z.literal('composio'), toolkit }).strict(),
  z.object({ ...selectableFields, source: z.literal('mcp') }).strict(),
]).superRefine((value, context) => {
  if (value.mode === 'fixed') {
    if (value.entry.retainedBindingRef !== undefined && value.configurationId === undefined) {
      context.addIssue({ code: 'custom', path: ['configurationId'], message: 'Retaining a binding requires its exact stored slot.' });
    }
    return;
  }
  const choiceIds = new Set<string>(), identities = new Set<string>();
  for (const choice of value.allowedChoices) {
    if (choiceIds.has(choice.choiceId) || identities.has(extensionSelectionIdentity(choice.selection)))
      context.addIssue({ code: 'custom', path: ['allowedChoices'], message: 'Duplicate choice ID or exact connection identity.' });
    choiceIds.add(choice.choiceId); identities.add(extensionSelectionIdentity(choice.selection));
    if (choice.selection.source !== value.source || value.source === 'composio'
      && (choice.selection.kind !== 'composio' || choice.selection.toolkit !== value.toolkit))
      context.addIssue({ code: 'custom', path: ['allowedChoices'], message: 'A choice must use the configured source and exact toolkit.' });
  }
  if (value.defaultChoiceId !== undefined && !choiceIds.has(value.defaultChoiceId))
    context.addIssue({ code: 'custom', path: ['defaultChoiceId'], message: 'The default must be an explicitly allowed choice.' });
  if (value.personalPolicy && (value.personalPolicy.source !== value.source || value.source === 'composio'
    && (value.personalPolicy.source !== 'composio' || value.personalPolicy.toolkit !== value.toolkit)))
    context.addIssue({ code: 'custom', path: ['personalPolicy'], message: 'Personal policy must preserve the configured source and exact toolkit.' });
});
export type AgentStandaloneConfigurationInput = z.infer<typeof agentStandaloneConfigurationInputSchema>;

/** Names, status, mutable head versions and gateway/provider references are never identity keys. */
export function extensionSelectionIdentity(selection: ExtensionSelection): string {
  switch (selection.kind) {
    case 'core_plugin':
    case 'core_skill': return JSON.stringify([selection.kind, selection.coreSource.resourceRef, selection.coreSource.coreRevision, selection.coreSource.checksum]);
    case 'plugin': return JSON.stringify(['plugin', selection.package.resourceRef, selection.package.publishedRevisionRef]);
    case 'skill': return JSON.stringify(['skill', selection.package.resourceRef, selection.package.publishedRevisionRef, selection.relativeRoot]);
    case 'mcp': return JSON.stringify(['mcp', selection.target.kind, selection.target.connectionRef]);
    case 'composio': return selection.target.kind === 'shared'
      ? JSON.stringify(['composio', selection.toolkit, 'shared', selection.target.connectionRef])
      : JSON.stringify(['composio', selection.toolkit, 'personal', selection.target.profileId,
        selection.target.accountBinding, selection.target.accountBinding === 'account' ? selection.target.accountId : null]);
  }
}
function checkEntries(entries: readonly ExtensionSelectionEntry[], context: z.RefinementCtx) {
  const identities = new Set<string>(), pins = new Map<string, string>();
  entries.forEach((entry, index) => {
    const key = extensionSelectionIdentity(entry.selection);
    if (identities.has(key)) context.addIssue({ code: 'custom', path: ['selections', index], message: 'Duplicate exact extension identity.' });
    identities.add(key);
    if (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill') {
      const pin = entry.selection.package, stamp = JSON.stringify([pin.resourceRef, pin.checksum]);
      if (pins.has(pin.publishedRevisionRef) && pins.get(pin.publishedRevisionRef) !== stamp)
        context.addIssue({ code: 'custom', path: ['selections', index], message: 'Contradictory immutable package pin.' });
      pins.set(pin.publishedRevisionRef, stamp);
    }
  });
}
function checkEncodedSize(value: unknown, context: z.RefinementCtx) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > EXTENSION_SELECTION_LIMITS.bytes)
    context.addIssue({ code: 'custom', message: 'The extension envelope exceeds its UTF-8 byte limit.' });
}

/** Public accepted message identity. Expiring choice receipts never belong in queue/history storage. */
export const chatExtensionSelectionSchema = z.object({ version: z.literal(1), origin: z.literal('turn_reference'),
  selections: z.array(extensionSelectionEntrySchema).max(EXTENSION_SELECTION_LIMITS.turn),
  packageConnections: z.array(extensionPackageConnectionSchema).max(EXTENSION_SELECTION_LIMITS.children).optional() }).strict()
  .superRefine((value, context) => {
    checkEntries(value.selections, context);
    checkPackageConnections(value.selections, value.packageConnections, context);
    checkEncodedSize(value, context);
  });
export const chatExtensionSelectionInputSchema = z.object({ version: z.literal(1), origin: z.literal('turn_reference'),
  selections: z.array(extensionSelectionInputSchema).max(EXTENSION_SELECTION_LIMITS.turn),
  packageConnections: z.array(extensionPackageConnectionSchema).max(EXTENSION_SELECTION_LIMITS.children).optional() }).strict()
  .superRefine((value, context) => {
    checkEntries(value.selections, context);
    checkPackageConnections(value.selections, value.packageConnections, context);
    checkEncodedSize(value, context);
  });
export type ChatExtensionSelection = z.infer<typeof chatExtensionSelectionSchema>;
export type ChatExtensionSelectionInput = z.infer<typeof chatExtensionSelectionInputSchema>;

/** Mutation intent: preserve full V1 declaration choices. The durable private codec is separate. */
export const agentExtensionConfigurationInputSchema = z.discriminatedUnion('mode', [
  z.object({ version: z.literal(1), origin: z.literal('agent_configuration'), mode: z.literal('legacy_inherit') }).strict(),
  z.object({ version: z.literal(1), origin: z.literal('agent_configuration'), mode: z.literal('fixed'),
    selections: z.array(extensionSelectionInputSchema).max(EXTENSION_SELECTION_LIMITS.agent),
    workflow: agentWorkflowConfigurationSchema.nullable(),
    standalone: z.array(agentStandaloneConfigurationInputSchema).max(EXTENSION_SELECTION_LIMITS.agent) }).strict()
    .describe('At most 256 combined package selections and standalone slots, with at most 128 distinct shared connections across every package and allowed choice.'),
]).superRefine((value, context) => {
  if (value.mode === 'legacy_inherit') return;
  checkEncodedSize(value, context);
  checkEntries(value.selections, context);
  if (value.selections.length + value.standalone.length > EXTENSION_SELECTION_LIMITS.agent)
    context.addIssue({ code: 'custom', message: 'The combined configuration exceeds its selection limit.' });
  const slots = new Set<string>(), standaloneIdentities = new Set<string>();
  for (const slot of value.standalone) {
    if (slot.configurationId !== undefined) {
      if (slots.has(slot.configurationId)) context.addIssue({ code: 'custom', path: ['standalone'], message: 'Duplicate agent-local standalone slot.' });
      slots.add(slot.configurationId);
    }
    for (const selection of slot.mode === 'fixed' ? [slot.entry.selection] : slot.allowedChoices.map(choice => choice.selection)) {
      const identity = extensionSelectionIdentity(selection);
      if (standaloneIdentities.has(identity)) context.addIssue({ code: 'custom', path: ['standalone'], message: 'Duplicate exact standalone connection across configuration slots.' });
      standaloneIdentities.add(identity);
    }
  }
  if (value.workflow) {
    try { parseAgentWorkflowConfiguration(value.workflow); }
    catch { context.addIssue({ code: 'custom', path: ['workflow'], message: 'The complete V1 workflow configuration is invalid.' }); }
  }
  const packages = value.workflow?.packages ?? [], seen = new Set<string>();
  const shared = new Set(value.standalone.flatMap(slot => slot.mode === 'fixed' ? [slot.entry.selection] : slot.allowedChoices.map(choice => choice.selection))
    .flatMap(selection => selection.target.kind === 'shared' ? [selection.target.connectionRef] : []));
  for (const pkg of packages) for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
    for (const choice of capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices) {
      if (choice.target.kind === 'shared') shared.add(choice.target.connectionRef);
    }
  }
  if (shared.size > EXTENSION_SELECTION_LIMITS.sharedConnections) context.addIssue({ code: 'custom',
    message: 'The configuration exceeds the transaction limit of 128 distinct shared connections across packages and standalone choices.' });
  for (const pkg of packages) {
    if (seen.has(pkg.resourceRef)) context.addIssue({ code: 'custom', path: ['workflow'], message: 'Duplicate workflow package.' });
    seen.add(pkg.resourceRef);
    const matching = value.selections.filter(entry => (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill')
      && entry.selection.package.resourceRef === pkg.resourceRef);
    if (!matching.length) context.addIssue({ code: 'custom', path: ['workflow'], message: 'A workflow package must correspond to an explicit selection.' });
    if (pkg.skillSelection.kind === 'plugin' && !matching.some(entry => entry.selection.kind === 'plugin'))
      context.addIssue({ code: 'custom', path: ['workflow'], message: 'A complete plugin workflow needs its explicit parent selection.' });
    if (pkg.skillSelection.kind === 'skills') for (const root of pkg.skillSelection.relativeRoots) {
      if (!matching.some(entry => entry.selection.kind === 'skill' && entry.selection.relativeRoot === root))
        context.addIssue({ code: 'custom', path: ['workflow'], message: 'A workflow skill root must correspond to an explicit exact skill selection.' });
    }
  }
  value.selections.forEach((entry, index) => {
    const selection = entry.selection;
    if(isCoreExtensionSelection(selection)) return;
    if (selection.kind !== 'plugin' && selection.kind !== 'skill') {
      context.addIssue({ code: 'custom', path: ['selections', index], message: 'Configure standalone connections in their explicit fixed/selectable slots.' }); return;
    }
    const pkg = packages.find(candidate => candidate.resourceRef === selection.package.resourceRef);
    if (!pkg || pkg.publishedRevisionRef !== selection.package.publishedRevisionRef || pkg.checksum !== selection.package.checksum)
      context.addIssue({ code: 'custom', path: ['selections', index], message: 'Package selection and workflow must hold the same immutable pin.' });
    else if (selection.kind === 'plugin' && pkg.skillSelection.kind !== 'plugin'
      || selection.kind === 'skill' && (selection.origin === 'standalone' && pkg.skillSelection.kind !== 'skills'
        || pkg.skillSelection.kind === 'skills' && !pkg.skillSelection.relativeRoots.includes(selection.relativeRoot)
        || pkg.childRelativeRoot !== undefined && pkg.childRelativeRoot !== selection.relativeRoot))
      context.addIssue({ code: 'custom', path: ['selections', index], message: 'Skill selection contradicts the workflow or drops its parent scope.' });
  });
});
export type AgentExtensionConfigurationInput = z.infer<typeof agentExtensionConfigurationInputSchema>;
