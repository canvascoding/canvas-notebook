import { z } from 'zod';

/** A bundled source identity is separate from immutable SQL publication pins. */
export const corePluginSourceSchema = z.object({
  resourceRef: z.literal('canvas-capability:v1:plugin:system:core:plugin-creator'),
  coreRevision: z.string().min(1).max(200).regex(/^[0-9]+(?:\.[0-9]+){0,2}(?:[-+][a-z0-9.-]+)?$/iu),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type CorePluginSource = z.infer<typeof corePluginSourceSchema>;

export const corePluginExtensionSelectionSchema = z.object({
  kind: z.literal('core_plugin'), coreSource: corePluginSourceSchema,
}).strict();
export type CorePluginExtensionSelection = z.infer<typeof corePluginExtensionSelectionSchema>;
