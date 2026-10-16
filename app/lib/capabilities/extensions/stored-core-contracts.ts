import { z } from 'zod';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { corePluginExtensionSelectionSchema, coreSkillExtensionSelectionSchema } from './core-source-contracts';
import { copyBoundedJson, freeze } from './stored-contracts';

/** Private identity only. Current source bytes and actor Use are checked separately. */
const storedCorePluginBindingSchema = z.object({
  version: z.literal(2),
  kind: z.literal('core_plugin'),
  entry: z.object({ selection: corePluginExtensionSelectionSchema,
    requirement: z.enum(['optional', 'required']), toolCap: z.null() }).strict(),
}).strict();
export type StoredCorePluginExtensionBinding = z.infer<typeof storedCorePluginBindingSchema>;
const storedCoreSkillBindingSchema = storedCorePluginBindingSchema.extend({ kind: z.literal('core_skill'),
  entry: z.object({ selection: coreSkillExtensionSelectionSchema, requirement: z.enum(['optional', 'required']), toolCap: z.null() }).strict(),
}).strict();
const storedCoreExtensionBindingSchema = z.discriminatedUnion('kind', [storedCorePluginBindingSchema, storedCoreSkillBindingSchema]);
export type StoredCoreExtensionBinding = z.infer<typeof storedCoreExtensionBindingSchema>;

export function parseStoredCoreExtensionBinding(value: unknown): StoredCoreExtensionBinding {
  try { return freeze(storedCoreExtensionBindingSchema.parse(copyBoundedJson(value))); }
  catch { throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored built-in instruction binding cannot be verified.', 409); }
}

export function parseStoredCorePluginExtensionBinding(value: unknown): StoredCorePluginExtensionBinding {
  try {
    return freeze(storedCorePluginBindingSchema.parse(copyBoundedJson(value)));
  } catch {
    throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored built-in plugin binding cannot be verified.', 409);
  }
}
