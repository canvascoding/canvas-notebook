import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentManagementActor, AgentCapabilitySelection } from './management-actions';
import type { AgentProfile } from './registry';
import type { AgentCapabilityBinding } from './capability-bindings';
import type { DecodedAgentExtensionBinding } from '@/app/lib/capabilities/extensions/stored-binding-dispatch';
import type { StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentWorkflowVersion } from './workflow-version';
import type { WorkflowDeclaration, WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';

import {
  AGENT_WORKFLOW_LIMITS, agentWorkflowPackageSchema, agentWorkflowSchemaParts, AgentWorkflowError,
  type AgentWorkflowTarget, type AgentWorkflowSelection, type AgentWorkflowPackageConfiguration, type AgentWorkflowConfiguration,
} from './workflow-public-contracts';
export {
  AGENT_WORKFLOW_LIMITS, agentWorkflowTargetSchema, agentWorkflowPackageSchema, agentWorkflowConfigurationSchema,
  AgentWorkflowError, isAgentWorkflowError, parseAgentWorkflowConfiguration,
  type AgentWorkflowTarget, type AgentWorkflowSelection, type AgentWorkflowPackageConfiguration, type AgentWorkflowConfiguration,
} from './workflow-public-contracts';
const { text, relativePath, toolCap, sharedTargetSchema, personalTargetSchema, choiceSchema, personalPolicySchema } = agentWorkflowSchemaParts;

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
