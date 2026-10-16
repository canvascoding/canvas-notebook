import { z } from 'zod';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { corePluginExtensionSelectionSchema } from './core-source-contracts';
import { copyBoundedJson, freeze } from './stored-contracts';

/** Private identity only. Current source bytes and actor Use are checked separately. */
const storedCorePluginBindingSchema = z.object({
  version: z.literal(2),
  kind: z.literal('core_plugin'),
  entry: z.object({ selection: corePluginExtensionSelectionSchema,
    requirement: z.enum(['optional', 'required']), toolCap: z.null() }).strict(),
}).strict();
export type StoredCorePluginExtensionBinding = z.infer<typeof storedCorePluginBindingSchema>;

export function parseStoredCorePluginExtensionBinding(value: unknown): StoredCorePluginExtensionBinding {
  try {
    return freeze(storedCorePluginBindingSchema.parse(copyBoundedJson(value)));
  } catch {
    throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored built-in plugin binding cannot be verified.', 409);
  }
}
