import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentManagementActor, AgentCapabilitySelection } from './management-actions';
import type { AgentProfile } from './registry';
import type { AgentCapabilityBinding } from './capability-bindings';
import type { DecodedAgentExtensionBinding } from '@/app/lib/capabilities/extensions/stored-binding-dispatch';
import type { StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentWorkflowVersion } from './workflow-version';
import type { WorkflowDeclaration, WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';

export const AGENT_WORKFLOW_LIMITS = Object.freeze({ bytes: 1_048_576, packages: 32, declarations: 128, capabilities: 128, choices: 32, tools: 256 });
const text = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const resourceRef = z.string().regex(new RegExp(`^canvas-resource:${uuid}$`, 'u'));
const publishedRef = z.string().regex(new RegExp(`^canvas-package-revision:${uuid}$`, 'u'));
const connectionRef = z.string().regex(new RegExp(`^canvas-connection:${uuid}$`, 'u'));
const checksum = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePath = z.string().max(1_024).refine(value => !value.startsWith('/') && !/^[A-Za-z]:|[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'));
const toolCap = z.array(text).max(AGENT_WORKFLOW_LIMITS.tools).nullable().refine(value => value === null || new Set(value).size === value.length);
const sharedTargetSchema = z.object({ kind: z.literal('shared'), source: z.enum(['mcp', 'composio']), connectionRef,
  bindingRevision: z.number().int().positive(), mcpMapping: z.object({ kind: z.literal('manager_confirmation') }).strict().optional() }).strict();
const personalTargetSchema = z.object({ kind: z.literal('personal'), source: z.enum(['mcp', 'composio']), ownerUserId: text,
  providerRef: text, accountSelectionRef: z.string().min(1).max(8_192).optional() }).strict();
const retainedTargetSchema = z.object({ kind: z.literal('retained'),
  retainedBindingRef: z.string().regex(/^agent-workflow-retain:v1:[a-f0-9]{64}$/u) }).strict();
export const agentWorkflowTargetSchema = z.discriminatedUnion('kind', [sharedTargetSchema, personalTargetSchema, retainedTargetSchema]);
const choiceSchema = z.object({ choiceId: text, alternativeKey: text, target: agentWorkflowTargetSchema, toolCap }).strict();
const personalPolicySchema = z.object({ sources: z.array(z.enum(['mcp', 'composio'])).min(1).max(2),
  alternativeKeys: z.array(text).min(1).max(8), toolCap,
  mcpDefinitionMappings: z.array(z.object({ connector: text, serverDefinitionIds: z.array(text).min(1).max(32) }).strict()).max(8).optional() }).strict();
const selectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), alternativeKey: text, target: agentWorkflowTargetSchema, toolCap }).strict(),
  z.object({ mode: z.literal('selectable'), allowedChoices: z.array(choiceSchema).max(AGENT_WORKFLOW_LIMITS.choices),
    personalPolicy: personalPolicySchema.optional(), defaultChoiceId: text.optional() }).strict(),
]);
const capabilitySchema = z.object({ capabilityId: text, required: z.boolean().optional(), selection: selectionSchema }).strict();
export const agentWorkflowPackageSchema = z.object({ resourceRef, publishedRevisionRef: publishedRef, checksum,
  skillSelection: z.discriminatedUnion('kind', [z.object({ kind: z.literal('plugin') }).strict(),
    z.object({ kind: z.literal('skills'), relativeRoots: z.array(z.union([z.literal(''), relativePath])).min(1).max(128) }).strict()]),
  childRelativeRoot: relativePath.optional(), declarations: z.array(z.object({ declarationPath: relativePath,
    capabilities: z.array(capabilitySchema).max(AGENT_WORKFLOW_LIMITS.capabilities) }).strict()).max(AGENT_WORKFLOW_LIMITS.declarations) }).strict();
const configurationSchema = z.object({ version: z.literal(1), packages: z.array(agentWorkflowPackageSchema).max(AGENT_WORKFLOW_LIMITS.packages) }).strict();
export const agentWorkflowConfigurationSchema = configurationSchema;
export type AgentWorkflowTarget = z.infer<typeof agentWorkflowTargetSchema>;
export type AgentWorkflowSelection = z.infer<typeof selectionSchema>;
export type AgentWorkflowPackageConfiguration = z.infer<typeof agentWorkflowPackageSchema>;
export type AgentWorkflowConfiguration = z.infer<typeof configurationSchema>;
/** Private exact provider identity; never emitted in legacy binding DTOs. */
export type StoredAgentWorkflowTarget = Exclude<AgentWorkflowTarget, { kind: 'retained' }> & { bindingFingerprint?: string;
  boundProviderRef?: string; personalBinding?: {
    source: 'mcp'; ownerUserId: string; connectionId: string; serverDefinitionId: string | null;
  } | { source: 'composio'; ownerUserId: string; profileId: string; toolkit: string; mode: 'local' | 'managed';
    accountBinding: 'account' | 'no_auth'; connectedAccountId: string | null };
  verifiedMcpMapping?: { connector: string; configFingerprint: string; definitionId: string | null; definitionRevision: number | null; confirmedByUserId: string } };
export type StoredAgentWorkflowPackage = Omit<AgentWorkflowPackageConfiguration, 'declarations'> & {
  version: 1; selectedSkills: Array<{ name: string; relativeRoot: string }>;
  declarations: Array<{ declarationPath: string; capabilities: Array<{ capabilityId: string; required: boolean;
    application: string; alternatives: readonly WorkflowIntegrationAlternative[];
    selection: Omit<Extract<AgentWorkflowSelection, { mode: 'fixed' }>, 'target'> & { target: StoredAgentWorkflowTarget }
      | Omit<Extract<AgentWorkflowSelection, { mode: 'selectable' }>, 'allowedChoices'> & {
        allowedChoices: Array<{ choiceId: string; alternativeKey: string; target: StoredAgentWorkflowTarget; toolCap: string[] | null }> } }> }>;
};
export type AgentWorkflowStoredBinding = AgentCapabilityBinding & DecodedAgentExtensionBinding;
export type AgentWorkflowChoice = { workflowRevision: number; choiceId?: string; personalTarget?: StoredAgentWorkflowTarget; alternativeKey?: string;
  standaloneSelection?: StandaloneExtensionSelection };
export type AgentWorkflowInternalSnapshot = { agent: AgentProfile; workflowVersion: AgentWorkflowVersion; workflowRevision: number;
  access: { canUse: boolean; canEdit: boolean; canManage: boolean };
  bindings: AgentWorkflowStoredBinding[]; preferenceRevision: number; choices: Record<string, AgentWorkflowChoice> };
export type AgentWorkflowConnectionOption = { label: string; availability: 'available' | 'unavailable';
  status: 'unknown' | 'setup_required' | 'unavailable'; source?: 'mcp' | 'composio'; scopeLabel?: 'organization' | 'team' | 'personal'; connectionRef?: string };
export type AgentWorkflowDescriptor = { agentId: string; revision: number; workflowVersion: AgentWorkflowVersion; workflowRevision: number;
  unavailablePackageCount?: number;
  preferenceRevision: number; access: { canUse: boolean; canEdit: boolean; canManage: boolean };
  packages: Array<{ resourceRef: string; publishedRevisionRef: string; checksum: string; name: string;
    declarations: Array<{ declarationPath: string; capabilities: Array<{ capabilityKey: string; capabilityId: string; application: string;
      required: boolean; selectionMode: 'fixed' | 'selectable'; choices: Array<{ choiceId: string; kind: 'shared' | 'personal' } & AgentWorkflowConnectionOption>;
      selectedConnection?: AgentWorkflowConnectionOption;
      selectionOrigin: 'fixed' | 'default' | 'user' | 'stale'; selectedKind: 'shared' | 'personal' | null;
      selectedChoiceId: string | null; personalChoiceAllowed: boolean }> }> }>;
  standalone?: Array<{ capabilityKey: string; source: 'mcp' | 'composio'; toolkit?: string; required: boolean;
    selectionMode: 'fixed' | 'selectable'; selectionOrigin: 'fixed' | 'default' | 'user' | 'stale' | 'missing';
    selectedChoiceId: string | null; selectedConnection?: AgentWorkflowConnectionOption; selectedSelection?: StandaloneExtensionSelection;
    choices: Array<{ choiceId: string; selection?: StandaloneExtensionSelection; toolCap: string[] | null } & AgentWorkflowConnectionOption>;
    personalPolicy?: z.infer<typeof import('@/app/lib/capabilities/extensions/contracts').agentStandalonePersonalPolicySchema> }> };
export type AgentWorkflowPreparedDeclaration = WorkflowDeclaration;
export type UpdateManagedAgentConfigurationInput = { actor: AgentManagementActor; agentId: string; expectedRevision: number;
  expectedWorkflowRevision?: number; name?: string | null; iconId?: string | null; enabledTools?: string[] | null;
  defaultProviderInstallationId?: unknown; defaultProvider?: unknown; defaultModel?: unknown; defaultThinking?: unknown;
  expectedCatalogRevision?: unknown; workflow?: AgentWorkflowConfiguration | null;
  extensions?: import('@/app/lib/capabilities/extensions/contracts').AgentExtensionConfigurationInput;
  capabilities?: AgentCapabilitySelection[] | null; relevantSkills?: string[] | null; relevantConnections?: string[] | null };

export class AgentWorkflowError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message); this.name = 'AgentWorkflowError';
    Object.defineProperty(this, Symbol.for('canvas.agent.workflow-error.v1'), { value: true });
  }
}
export function isAgentWorkflowError(value: unknown): value is AgentWorkflowError {
  return Boolean(value && typeof value === 'object' && Reflect.get(value, Symbol.for('canvas.agent.workflow-error.v1')) === true
    && typeof Reflect.get(value, 'code') === 'string' && Number.isInteger(Reflect.get(value, 'status')));
}
export function parseAgentWorkflowConfiguration(value: unknown): AgentWorkflowConfiguration {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'A bounded workflow configuration is required.'); }
  if (!encoded || Buffer.byteLength(encoded) > AGENT_WORKFLOW_LIMITS.bytes) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'The workflow configuration exceeds its limits.');
  const result = configurationSchema.safeParse(JSON.parse(encoded));
  if (!result.success) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'The workflow configuration contains invalid or unsupported fields.');
  const packages = new Set<string>();
  for (const entry of result.data.packages) {
    const packageKey = entry.resourceRef;
    if (packages.has(packageKey)) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'Duplicate package bindings are not allowed.'); packages.add(packageKey);
    const declarations = new Set<string>();
    for (const declaration of entry.declarations) {
      if (declarations.has(declaration.declarationPath)) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'Duplicate declaration scopes are not allowed.'); declarations.add(declaration.declarationPath);
      const ids = new Set<string>();
      for (const capability of declaration.capabilities) {
        if (ids.has(capability.capabilityId)) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'Duplicate capability bindings are not allowed.'); ids.add(capability.capabilityId);
        if (capability.selection.mode === 'selectable') {
          const choices = capability.selection.allowedChoices.map(choice => choice.choiceId);
          if (new Set(choices).size !== choices.length || capability.selection.defaultChoiceId && !choices.includes(capability.selection.defaultChoiceId)) {
            throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'The selectable choices are invalid.');
          }
        }
      }
    }
  }
  return result.data;
}
export function agentWorkflowCapabilityKey(resource: string, declarationPath: string, capabilityId: string): string {
  return `agent-capability:${createHash('sha256').update(JSON.stringify([resource, declarationPath, capabilityId])).digest('base64url')}`;
}

const personalBindingSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('mcp'), ownerUserId: text, connectionId: text, serverDefinitionId: text.nullable() }).strict(),
  z.object({ source: z.literal('composio'), ownerUserId: text, profileId: text, toolkit: text, mode: z.enum(['local', 'managed']),
    accountBinding: z.enum(['account', 'no_auth']), connectedAccountId: text.nullable() }).strict(),
]);
const storedTargetSchema = z.discriminatedUnion('kind', [
  sharedTargetSchema.extend({ bindingFingerprint: text.optional(), verifiedMcpMapping: z.object({ connector: text, configFingerprint: text,
    definitionId: text.nullable(), definitionRevision: z.number().int().positive().nullable(), confirmedByUserId: text }).strict().optional() }).strict(),
  personalTargetSchema.omit({ accountSelectionRef: true }).extend({ bindingFingerprint: text, boundProviderRef: text, personalBinding: personalBindingSchema }).strict(),
]);
const storedAlternativeSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('mcp'), connector: text, requiredTools: z.array(text).max(64).optional() }).strict(),
  z.object({ source: z.literal('composio'), toolkit: text, requiredTools: z.array(text).max(64).optional() }).strict(),
]);
const storedSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), alternativeKey: text, target: storedTargetSchema, toolCap }).strict(),
  z.object({ mode: z.literal('selectable'), allowedChoices: z.array(choiceSchema.extend({ target: storedTargetSchema }).strict()).max(AGENT_WORKFLOW_LIMITS.choices),
    personalPolicy: personalPolicySchema.optional(), defaultChoiceId: text.optional() }).strict(),
]);
const storedPackageSchema = agentWorkflowPackageSchema.extend({ version: z.literal(1),
  selectedSkills: z.array(z.object({ name: text, relativeRoot: z.union([z.literal(''), relativePath]) }).strict()).max(128),
  declarations: z.array(z.object({ declarationPath: relativePath,
  capabilities: z.array(z.object({ capabilityId: text, required: z.boolean(), application: text, alternatives: z.array(storedAlternativeSchema).min(1).max(8),
    selection: storedSelectionSchema }).strict()).max(AGENT_WORKFLOW_LIMITS.capabilities) }).strict()).max(AGENT_WORKFLOW_LIMITS.declarations) }).strict();
export function parseStoredAgentWorkflowPackage(value: unknown): StoredAgentWorkflowPackage {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored workflow cannot be verified.', 409); }
  if (!encoded || Buffer.byteLength(encoded) > AGENT_WORKFLOW_LIMITS.bytes) throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored workflow cannot be verified.', 409);
  const result = storedPackageSchema.safeParse(JSON.parse(encoded));
  if (!result.success) throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored workflow cannot be verified.', 409);
  const invalid = () => { throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored workflow cannot be verified.', 409); };
  const entry = result.data;
  if (new Set(entry.selectedSkills.map(skill => skill.relativeRoot)).size !== entry.selectedSkills.length
    || new Set(entry.selectedSkills.map(skill => skill.name)).size !== entry.selectedSkills.length
    || entry.skillSelection.kind === 'skills' && (entry.skillSelection.relativeRoots.length !== entry.selectedSkills.length
      || entry.skillSelection.relativeRoots.some(root => !entry.selectedSkills.some(skill => skill.relativeRoot === root)))
    || new Set(entry.declarations.map(declaration => declaration.declarationPath)).size !== entry.declarations.length) invalid();
  for (const declaration of entry.declarations) {
    if (new Set(declaration.capabilities.map(capability => capability.capabilityId)).size !== declaration.capabilities.length) invalid();
    for (const capability of declaration.capabilities) {
      const key = (alternative: WorkflowIntegrationAlternative) => `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`;
      if (new Set(capability.alternatives.map(key)).size !== capability.alternatives.length) invalid();
      const selection = capability.selection;
      const choices = selection.mode === 'fixed' ? [selection] : selection.allowedChoices;
      if (selection.mode === 'selectable' && (new Set(selection.allowedChoices.map(choice => choice.choiceId)).size !== selection.allowedChoices.length
        || selection.defaultChoiceId && !selection.allowedChoices.some(choice => choice.choiceId === selection.defaultChoiceId))) invalid();
      for (const choice of choices) {
        const alternative = capability.alternatives.find(candidate => key(candidate) === choice.alternativeKey);
        if (!alternative || alternative.source !== choice.target.source
          || choice.toolCap !== null && (alternative.requiredTools ?? []).some(name => !choice.toolCap!.includes(name))) invalid();
        const target = parseStoredAgentWorkflowTarget(choice.target);
        if (target.kind === 'personal' && alternative!.source === 'composio'
          && (target.personalBinding?.source !== 'composio' || target.personalBinding.toolkit !== alternative!.toolkit)) invalid();
        if (target.kind === 'shared' && alternative!.source === 'mcp' && target.verifiedMcpMapping?.connector !== alternative!.connector) invalid();
      }
    }
  }
  return result.data;
}
export function parseStoredAgentWorkflowTarget(value: unknown): StoredAgentWorkflowTarget {
  const result = storedTargetSchema.safeParse(value);
  if (!result.success || result.data.kind === 'personal' && (result.data.personalBinding.ownerUserId !== result.data.ownerUserId
    || result.data.personalBinding.source !== result.data.source || !/^[a-f0-9]{64}$/u.test(result.data.bindingFingerprint)
    || !new RegExp(`^${result.data.source}:v1:personal:[a-f0-9]{64}$`, 'u').test(result.data.boundProviderRef)
    || result.data.personalBinding.source === 'composio' && (result.data.personalBinding.accountBinding === 'no_auth'
      ? result.data.personalBinding.connectedAccountId !== null : !result.data.personalBinding.connectedAccountId))) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored provider binding cannot be verified.', 409);
  }
  return result.data;
}
