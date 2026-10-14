import { z } from 'zod';
import type { AgentWorkflowDescriptor } from '@/app/lib/agents/workflow-contracts';
import { agentStandalonePersonalPolicySchema, extensionPackagePinSchema, extensionToolCapSchema,
  standaloneExtensionSelectionSchema } from '@/app/lib/capabilities/extensions/contracts';

const text = z.string().min(1).max(4_096);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const connection = z.object({ label: text, availability: z.enum(['available', 'unavailable']),
  status: z.enum(['unknown', 'setup_required', 'unavailable']), source: z.enum(['mcp', 'composio']).optional(),
  scopeLabel: z.enum(['organization', 'team', 'personal']).optional(), connectionRef: text.optional() });
const packageCapability = z.object({ capabilityKey: text, capabilityId: text, application: text, required: z.boolean(),
  selectionMode: z.enum(['fixed', 'selectable']), choices: z.array(connection.extend({ choiceId: text,
    kind: z.enum(['shared', 'personal']) })).max(32), selectedConnection: connection.optional(),
  selectionOrigin: z.enum(['fixed', 'default', 'user', 'stale']), selectedKind: z.enum(['shared', 'personal']).nullable(),
  selectedChoiceId: text.nullable(), personalChoiceAllowed: z.boolean() });
const standalone = z.object({ capabilityKey: text, source: z.enum(['mcp', 'composio']), toolkit: text.optional(),
  required: z.boolean(), selectionMode: z.enum(['fixed', 'selectable']),
  selectionOrigin: z.enum(['fixed', 'default', 'user', 'stale', 'missing']), selectedChoiceId: text.nullable(),
  selectedConnection: connection.optional(), selectedSelection: standaloneExtensionSelectionSchema.optional(),
  choices: z.array(connection.extend({ choiceId: text, selection: standaloneExtensionSelectionSchema.optional(),
    toolCap: extensionToolCapSchema })).max(32), personalPolicy: agentStandalonePersonalPolicySchema.optional() });

/** Full display descriptor validation; neither this parser nor its result grants tool authority. */
export const agentWorkflowDescriptorSchema = z.object({ agentId: text, revision: revision.refine(value => value > 0),
  workflowVersion: z.union([z.null(), z.literal(1), z.literal(2)]), workflowRevision: revision,
  preferenceRevision: revision, unavailablePackageCount: revision.optional(),
  access: z.object({ canUse: z.boolean(), canEdit: z.boolean(), canManage: z.boolean() }),
  packages: z.array(extensionPackagePinSchema.extend({ name: text,
    declarations: z.array(z.object({ declarationPath: text, capabilities: z.array(packageCapability).max(128) })).max(128) })).max(32),
  standalone: z.array(standalone).max(256).optional(),
}).superRefine((value, context) => {
  if (value.workflowVersion !== 2 && value.standalone?.length) context.addIssue({ code: 'custom', path: ['standalone'],
    message: 'Standalone choices require workflow version 2.' });
  const keys = value.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities.map(slot => slot.capabilityKey)))
    .concat((value.standalone ?? []).map(slot => slot.capabilityKey));
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Connection slot keys must be unique.' });
});

export function isAgentWorkflowDescriptor(value: unknown, agentId: string): value is AgentWorkflowDescriptor {
  const parsed = agentWorkflowDescriptorSchema.safeParse(value);
  return parsed.success && parsed.data.agentId === agentId;
}
