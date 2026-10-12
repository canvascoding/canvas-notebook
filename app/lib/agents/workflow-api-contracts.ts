import { z } from 'zod';
import { agentWorkflowConfigurationSchema } from './workflow-contracts';
import type { setManagedAgentWorkflowChoice } from './workflow-configuration';

const identifier = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const strings = z.array(identifier).max(512).nullable();
const optionalModel = identifier.nullable().optional();
const capability = z.object({ resourceType: z.enum(['skill', 'plugin']), resourceId: identifier.optional(), name: identifier.optional(),
  requirement: z.enum(['optional', 'required']).optional() }).strict();

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
}).strict();
export const updateAgentWorkflowChoiceSchema = z.object({
  agentId: identifier, capabilityKey: identifier, expectedWorkflowRevision: revision.refine(value => value > 0), expectedPreferenceRevision: revision,
  choiceId: identifier.nullable().optional(), personalSelection: z.object({ alternativeKey: identifier,
    target: z.object({ kind: z.literal('personal'), source: z.enum(['mcp', 'composio']), ownerUserId: identifier.optional(),
      providerRef: identifier, accountSelectionRef: z.string().min(1).max(8_192).optional() }).strict() }).strict().optional(),
}).strict().refine(value => (value.choiceId !== undefined) !== (value.personalSelection !== undefined));

/** An omitted personal owner is always the authenticated caller, never an admin-selected default. */
export function bindOwnAgentWorkflowChoiceInput(input: z.infer<typeof updateAgentWorkflowChoiceSchema>, userId: string):
  Omit<Parameters<typeof setManagedAgentWorkflowChoice>[0], 'actor'> {
  const { personalSelection, ...choice } = input;
  return { ...choice, ...(personalSelection ? { personalSelection: { ...personalSelection,
    target: { ...personalSelection.target, ownerUserId: personalSelection.target.ownerUserId ?? userId } } } : {}) };
}
