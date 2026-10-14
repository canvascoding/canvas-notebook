import { z } from 'zod';
import {
  agentExtensionConfigurationInputSchema,
  extensionPackageConnectionSchema,
  extensionPackagePinSchema,
  EXTENSION_SELECTION_LIMITS,
  type ExtensionPackagePin,
  type ExtensionSelection,
  type StandaloneExtensionSelection,
} from '@/app/lib/capabilities/extensions/contracts';
import type { WorkflowDeclaration } from '@/app/lib/capabilities/workflow-contracts';
import type { PluginExtensionCoverage, PluginExtensionItem } from '@/app/lib/plugins/plugin-extension-contracts';
import type { PluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import type { PluginWorkspaceCatalogResponse } from '@/app/lib/plugins/plugin-workspace-catalog-contracts';
import type { AgentWorkflowTarget } from './workflow-public-contracts';

const identifier = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const toolkit = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/u);
const query = z.string().max(512).refine(value => !/[\p{Cc}]/u.test(value));
const cursor = z.string().min(1).max(8_192).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));

export const agentExtensionProspectiveTargetSchema = z.object({ kind: z.literal('prospective'),
  scopeType: z.enum(['user', 'organization']) }).strict();
export const agentExtensionExistingTargetSchema = z.object({ kind: z.literal('existing'), agentId: identifier,
  expectedRevision: revision.refine(value => value > 0), expectedWorkflowRevision: revision }).strict();
export const agentExtensionUserChoiceTargetSchema = z.object({ kind: z.literal('user_choice'), agentId: identifier,
  capabilityKey: z.string().regex(/^agent-(?:extension|capability):[A-Za-z0-9_-]{43}$/u),
  expectedWorkflowRevision: revision.refine(value => value > 0), expectedPreferenceRevision: revision }).strict();
export const agentExtensionConfigurationTargetSchema = z.discriminatedUnion('kind', [
  agentExtensionProspectiveTargetSchema, agentExtensionExistingTargetSchema,
]);
/** A target is intent, never a substitute for the current SQL actor/agent authorization. */
export const agentExtensionOptionsTargetSchema = z.discriminatedUnion('kind', [agentExtensionProspectiveTargetSchema,
  agentExtensionExistingTargetSchema, agentExtensionUserChoiceTargetSchema]);
export type AgentExtensionConfigurationTarget = z.infer<typeof agentExtensionConfigurationTargetSchema>;
export type AgentExtensionOptionsTarget = z.infer<typeof agentExtensionOptionsTargetSchema>;

export const agentExtensionConnectionSelectorSchema = z.union([
  z.object({ kind: z.literal('standalone'), source: z.literal('mcp') }).strict(),
  z.object({ kind: z.literal('standalone'), source: z.literal('composio'), toolkit }).strict(),
  z.object({ kind: z.literal('package'), package: extensionPackagePinSchema,
    declarationPath: extensionPackageConnectionSchema.shape.declarationPath,
    capabilityId: extensionPackageConnectionSchema.shape.capabilityId,
    alternativeKey: extensionPackageConnectionSchema.shape.alternativeKey }).strict(),
]);
const slotSelector = z.object({ kind: z.literal('slot'),
  alternativeKey: extensionPackageConnectionSchema.shape.alternativeKey.optional() }).strict();
export type AgentExtensionConfigurationConnectionSelector = z.infer<typeof agentExtensionConnectionSelectorSchema>;
export type AgentExtensionUserChoiceSelector = z.infer<typeof slotSelector>;
export type AgentExtensionConnectionSelector = AgentExtensionConfigurationConnectionSelector | AgentExtensionUserChoiceSelector;

const searchRequest = z.object({ operation: z.literal('search'), target: agentExtensionConfigurationTargetSchema,
  q: query.default(''), types: z.array(z.enum(['plugin', 'skill', 'integration', 'mcp'])).min(1).max(4)
    .refine(values => new Set(values).size === values.length).default(['plugin', 'skill', 'integration', 'mcp']),
  stock: z.enum(['all', 'installed', 'available']).default('all'), source: z.enum(['all', 'store', 'composio', 'mcp']).default('all'),
  scope: z.enum(['all', 'user', 'team', 'organization', 'system']).default('all'),
  audience: z.enum(['own', 'shared']).nullable().default(null), teamId: identifier.nullable().default(null),
  cursor: cursor.nullable().default(null), selected: z.string().min(1).max(4_096)
    .refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value)).nullable().default(null),
  limit: z.number().int().min(1).max(50).default(20),
}).strict().superRefine((value, context) => {
  if (value.audience !== null && value.scope !== 'user') context.addIssue({ code: 'custom', path: ['audience'], message: 'Audience requires the user scope.' });
  if ((value.scope === 'team') !== (value.teamId !== null)) context.addIssue({ code: 'custom', path: ['teamId'], message: 'Choose one exact team for the team scope.' });
});
const packageRequest = z.object({ operation: z.literal('package_version'), target: agentExtensionConfigurationTargetSchema,
  resourceRef: extensionPackagePinSchema.shape.resourceRef,
  publishedRevisionRef: extensionPackagePinSchema.shape.publishedRevisionRef,
  checksum: extensionPackagePinSchema.shape.checksum.optional() }).strict();
const connectionRequest = z.object({ operation: z.literal('connection_choices'), target: agentExtensionConfigurationTargetSchema,
  selector: agentExtensionConnectionSelectorSchema,
  /** Presence is an explicit account-chooser action, never an instruction to probe all profiles. */
  profileId: identifier.optional(), q: query.default(''), cursor: cursor.nullable().default(null),
  limit: z.number().int().min(1).max(50).default(20),
}).strict().superRefine((value, context) => {
  const mcp = value.selector.kind === 'standalone' ? value.selector.source === 'mcp' : value.selector.alternativeKey.startsWith('mcp:');
  if (mcp && value.profileId !== undefined) context.addIssue({ code: 'custom', path: ['profileId'], message: 'An MCP choice cannot select a Composio profile.' });
});
const userChoiceRequest = z.object({ operation: z.literal('connection_choices'), target: agentExtensionUserChoiceTargetSchema,
  selector: slotSelector, profileId: identifier.optional(), q: query.default(''), cursor: cursor.nullable().default(null),
  limit: z.number().int().min(1).max(50).default(20),
}).strict().superRefine((value, context) => {
  if (value.profileId !== undefined && value.selector.alternativeKey?.startsWith('mcp:')) {
    context.addIssue({ code: 'custom', path: ['profileId'], message: 'An MCP choice cannot select a Composio profile.' });
  }
});
const previewRequest = z.object({ operation: z.literal('preview'), target: agentExtensionConfigurationTargetSchema,
  configuration: agentExtensionConfigurationInputSchema,
  enabledTools: z.array(identifier).max(512).nullable().refine(values => values === null || new Set(values).size === values.length).optional(),
}).strict().superRefine((value, context) => {
  if (value.target.kind !== 'prospective' || value.configuration.mode !== 'fixed') return;
  const retainedSlot = value.configuration.standalone.some(slot => (slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices)
    .some(choice => choice.retainedBindingRef !== undefined));
  const retainedPackage = value.configuration.workflow?.packages.some(pkg => pkg.declarations.some(declaration => declaration.capabilities
    .some(capability => (capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices)
      .some(choice => choice.target.kind === 'retained'))));
  if (retainedSlot || retainedPackage) context.addIssue({ code: 'custom', path: ['configuration'], message: 'Retained bindings require their actual existing agent.' });
});

/** No actor, private binding, credential, runtime handle or central edit data is accepted for user_choice. */
function checkOptionsRequestSize(value: unknown, context: z.RefinementCtx): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > EXTENSION_SELECTION_LIMITS.bytes) {
    context.addIssue({ code: 'custom', message: 'The complete options request exceeds its byte limit.' });
  }
}
export const agentExtensionOptionsRequestSchema = z.union([
  searchRequest, packageRequest, connectionRequest, userChoiceRequest, previewRequest,
]).superRefine(checkOptionsRequestSize);
/** Planning-safe tool dialect: selecting a profile is an explicit, separate account operation. */
export const agentExtensionMetadataOptionsRequestSchema = z.union([
  searchRequest, packageRequest, connectionRequest.safeExtend({ profileId: z.never().optional() }),
  userChoiceRequest.safeExtend({ profileId: z.never().optional() }), previewRequest,
]).superRefine(checkOptionsRequestSize);
/** Explicit chooser dialect; the actual source and account rights are rechecked by the service. */
export const agentExtensionAccountOptionsRequestSchema = z.union([
  connectionRequest.safeExtend({ profileId: identifier }), userChoiceRequest.safeExtend({ profileId: identifier }),
]).superRefine(checkOptionsRequestSize);
export type AgentExtensionOptionsRequest = z.infer<typeof agentExtensionOptionsRequestSchema>;
export type AgentExtensionSearchRequest = Extract<AgentExtensionOptionsRequest, { operation: 'search' }>;
export type AgentExtensionConnectionChoicesRequest = Extract<AgentExtensionOptionsRequest, { operation: 'connection_choices' }>;

export type AgentExtensionOptionsHeader<Target extends AgentExtensionOptionsTarget = AgentExtensionOptionsTarget> = {
  schemaVersion: 1;
  target: Target;
  /** Server-derived current actor/workspace/target namespace. It is not an authority token. */
  contextKey: string;
  coverage: PluginExtensionCoverage[];
  limits: typeof EXTENSION_SELECTION_LIMITS;
};
export type AgentExtensionOptionEligibility = {
  action: 'select' | 'choose_connection' | 'setup' | 'unavailable';
  reason?: { code: string; message: string };
};
export type AgentExtensionSearchItem = {
  item: PluginExtensionItem;
  eligibility: AgentExtensionOptionEligibility;
  /** Source-verified public identity. An own account still needs its explicit intake receipt. */
  selection?: ExtensionSelection;
  publishedVersions?: Array<{ pin: ExtensionPackagePin; version: string; publishedAt: number }>;
};
export type AgentExtensionPackageVersion = {
  pin: ExtensionPackagePin;
  kind: 'plugin' | 'skill';
  name: string;
  displayName: string;
  description: string;
  version: string;
  icon?: PluginExtensionIcon;
  children: Array<{ name: string; title?: string; description: string; relativeRoot: string;
    origin: 'standalone' | 'plugin_child'; required: boolean; icon?: PluginExtensionIcon }>;
  /** Actual held parent/child declarations; client names never manufacture these paths. */
  declarations: WorkflowDeclaration[];
};
/** A copyable public mutation value, not a private binding or a runtime grant. */
export type AgentExtensionPackageBinding = {
  alternativeKey: string;
  target: Exclude<AgentWorkflowTarget, { kind: 'retained' }>;
};
export type AgentExtensionConnectionChoice = {
  id: string;
  choiceId?: string;
  alternativeKey?: string;
  definitionId?: string;
  selection: StandaloneExtensionSelection;
  packageBinding?: AgentExtensionPackageBinding;
  label: string;
  scopeLabel: 'personal' | 'organization' | 'team';
  ownershipLabel?: string;
  profileLabel?: string;
  allowedToolNames: string[] | null;
  eligibility: AgentExtensionOptionEligibility;
  authorization: 'unknown' | 'required' | 'authorized' | 'not_required';
  /** Metadata options do not perform a provider health check. */
  health: 'unknown';
  mappingRequired: boolean;
  icon?: PluginExtensionIcon;
};
export type AgentExtensionProfileChoice = { profileId: string; label: string; status: 'unverified'; alternativeKey?: string };
export type AgentExtensionAccountChoice = {
  selection: Extract<StandaloneExtensionSelection, { kind: 'composio' }> & {
    target: Extract<Extract<StandaloneExtensionSelection, { kind: 'composio' }>['target'], { kind: 'personal'; accountBinding: 'account' }> };
  accountSelectionRef: string;
  packageBinding?: AgentExtensionPackageBinding;
  label: string;
  status: string;
  selectable: boolean;
  alternativeKey?: string;
  expiresAt?: string;
};
export type AgentExtensionOptionsPagination = { nextCursor: string | null; hasNextPage: boolean; loadedItems: number; totalItems?: number };
export type AgentExtensionConfigurationPreview = {
  configurationReadiness: 'valid' | 'incomplete' | 'blocked' | 'unknown';
  runtimeReadiness: 'not_checked';
  providerHealth: 'unknown';
  finalSaveValidationRequired: true;
  issues: Array<{ code: string; message: string; severity: 'error' | 'warning'; path?: string }>;
  requirements: Array<{ package: ExtensionPackagePin; declarationPath: string; capabilityId: string; required: boolean;
    state: 'bound' | 'unbound' | 'unavailable'; alternativeKey?: string; connectionSelection?: StandaloneExtensionSelection }>;
  effectiveToolCaps: Array<{ selection: ExtensionSelection; toolCap: string[] | null }>;
  toolConflicts: Array<{ code: string; message: string; toolNames: string[] }>;
  budget: { usedBytes: number; maxBytes: number; detailStatus: 'complete' | 'compacted'; omittedDetails: number };
  /** Bounded configuration presentation, not a runtime proof or executable system prompt. */
  contextPreview?: string;
};
type AgentExtensionConnectionChoicesPayload = {
  connections: AgentExtensionConnectionChoice[];
  profiles: AgentExtensionProfileChoice[];
  accounts: AgentExtensionAccountChoice[];
  personalSelectionPolicy?: { requirement: 'optional' | 'required'; toolCap: string[] | null };
  noAuthSelection?: Extract<StandaloneExtensionSelection, { kind: 'composio' }> & {
    target: Extract<Extract<StandaloneExtensionSelection, { kind: 'composio' }>['target'], { kind: 'personal'; accountBinding: 'no_auth' }> };
  noAuthPackageBinding?: AgentExtensionPackageBinding;
  pagination: AgentExtensionOptionsPagination;
};
export type AgentExtensionOptionsResponse =
  | (AgentExtensionOptionsHeader<AgentExtensionConfigurationTarget> & { operation: 'search'; query: AgentExtensionSearchRequest;
    items: AgentExtensionSearchItem[]; selectedItem: AgentExtensionSearchItem | null;
    scopes: PluginWorkspaceCatalogResponse['scopes']; pagination: AgentExtensionOptionsPagination })
  | (AgentExtensionOptionsHeader<AgentExtensionConfigurationTarget> & { operation: 'package_version'; package: AgentExtensionPackageVersion })
  | (AgentExtensionOptionsHeader<AgentExtensionConfigurationTarget> & AgentExtensionConnectionChoicesPayload & {
    operation: 'connection_choices'; selector: AgentExtensionConfigurationConnectionSelector })
  | (AgentExtensionOptionsHeader<z.infer<typeof agentExtensionUserChoiceTargetSchema>> & AgentExtensionConnectionChoicesPayload & {
    operation: 'connection_choices'; selector: AgentExtensionUserChoiceSelector })
  | (AgentExtensionOptionsHeader<AgentExtensionConfigurationTarget> & { operation: 'preview'; preview: AgentExtensionConfigurationPreview });
