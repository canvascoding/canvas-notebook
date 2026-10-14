import { z } from 'zod';
import { agentWorkflowConfigurationSchema } from './workflow-contracts';
import type { setManagedAgentWorkflowChoice } from './workflow-configuration';
import { agentExtensionConfigurationInputSchema, standaloneExtensionInputSchema } from '@/app/lib/capabilities/extensions/contracts';

const identifier = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const strings = z.array(identifier).max(512).nullable();
const optionalModel = identifier.nullable().optional();
const capability = z.object({ resourceType: z.enum(['skill', 'plugin']), resourceId: identifier.optional(), name: identifier.optional(),
  requirement: z.enum(['optional', 'required']).optional() }).strict();
const legacyExtensionFields = ['workflow', 'capabilities', 'relevantSkills', 'relevantConnections'] as const;
function checkExclusiveExtensionInput(value: { extensions?: unknown; workflow?: unknown; capabilities?: unknown;
  relevantSkills?: unknown; relevantConnections?: unknown }, context: z.RefinementCtx): void {
  if (value.extensions !== undefined && legacyExtensionFields.some(field => Object.hasOwn(value, field))) {
    context.addIssue({ code: 'custom', path: ['extensions'], message: 'Use either the complete extension configuration or legacy selection fields.' });
  }
}

/** API and tool intake share one strict complete create envelope. Authority stays in the writer. */
export const createAgentConfigurationSchema = z.object({
  name: z.string().min(1).max(256), agentId: identifier.nullable().optional(), iconId: identifier.nullable().optional(),
  scopeType: z.enum(['user', 'organization']).optional(), enabledTools: strings.optional(),
  defaultProviderInstallationId: optionalModel, defaultProvider: optionalModel, defaultModel: optionalModel, defaultThinking: optionalModel,
  expectedCatalogRevision: revision.optional(), capabilities: z.array(capability).max(256).nullable().optional(),
  relevantSkills: strings.optional(), relevantConnections: strings.optional(), extensions: agentExtensionConfigurationInputSchema.optional(),
  files: z.object({ 'AGENTS.md': z.string().optional(), 'MEMORY.md': z.string().optional(),
    'SOUL.md': z.string().optional(), 'TOOLS.md': z.string().optional() }).strict().nullable().optional(),
  grants: z.array(z.object({ targetType: z.enum(['organization', 'role', 'workspace', 'project', 'user']), targetId: identifier,
    canUse: z.boolean().optional(), canEdit: z.boolean().optional(), canManage: z.boolean().optional() }).strict()).max(512).nullable().optional(),
}).strict().superRefine(checkExclusiveExtensionInput);

/** Personal discovery is explicit and limited to one centrally permitted alternative. */
export const agentWorkflowPersonalOptionsSchema = z.object({ agentId: identifier, capabilityKey: identifier,
  alternativeKey: identifier.optional(), providerRef: identifier.optional(),
  expectedWorkflowRevision: revision.refine(value => value > 0).optional() }).strict()
  .refine(value => value.providerRef === undefined || value.alternativeKey !== undefined);

/** UI and agent tools share one strict atomic mutation contract. The service rechecks actual authority. */
export const updateAgentConfigurationSchema = z.object({
  agentId: identifier, expectedRevision: revision.refine(value => value > 0), expectedWorkflowRevision: revision.optional(),
  name: z.string().min(1).max(256).nullable().optional(), iconId: identifier.nullable().optional(), enabledTools: strings.optional(),
  defaultProviderInstallationId: optionalModel, defaultProvider: optionalModel, defaultModel: optionalModel, defaultThinking: optionalModel,
  expectedCatalogRevision: revision.optional(), capabilities: z.array(capability).max(256).nullable().optional(),
  relevantSkills: strings.optional(), relevantConnections: strings.optional(), workflow: agentWorkflowConfigurationSchema.nullable().optional(),
  extensions: agentExtensionConfigurationInputSchema.optional(),
}).strict().superRefine((value, context) => {
  checkExclusiveExtensionInput(value, context);
  if (value.extensions !== undefined && value.expectedWorkflowRevision === undefined) {
    context.addIssue({ code: 'custom', path: ['expectedWorkflowRevision'], message: 'The current workflow revision is required to replace the complete extension configuration.' });
  }
});
export const updateAgentWorkflowChoiceSchema = z.object({
  agentId: identifier, capabilityKey: identifier, expectedWorkflowRevision: revision.refine(value => value > 0), expectedPreferenceRevision: revision,
  choiceId: identifier.nullable().optional(), personalSelection: z.object({ alternativeKey: identifier,
    target: z.object({ kind: z.literal('personal'), source: z.enum(['mcp', 'composio']), ownerUserId: identifier.optional(),
      providerRef: identifier, accountSelectionRef: z.string().min(1).max(8_192).optional() }).strict() }).strict().optional(),
  standaloneSelection: standaloneExtensionInputSchema.optional(),
}).strict().refine(value => [value.choiceId, value.personalSelection, value.standaloneSelection].filter(selection => selection !== undefined).length === 1);

/** An omitted personal owner is always the authenticated caller, never an admin-selected default. */
export function bindOwnAgentWorkflowChoiceInput(input: z.infer<typeof updateAgentWorkflowChoiceSchema>, userId: string):
  Omit<Parameters<typeof setManagedAgentWorkflowChoice>[0], 'actor'> {
  const { personalSelection, ...choice } = input;
  return { ...choice, ...(personalSelection ? { personalSelection: { ...personalSelection,
    target: { ...personalSelection.target, ownerUserId: personalSelection.target.ownerUserId ?? userId } } } : {}) };
}
