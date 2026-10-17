import { z } from 'zod';

/** Runtime metadata discovery uses the current server-bound agent, never a requested actor or grant. */
export const runtimeExtensionSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(256),
  types: z.array(z.enum(['plugin', 'skill'])).min(1).max(2)
    .refine(values => new Set(values).size === values.length).optional(),
  limit: z.number().int().min(1).max(20).default(8),
}).strict();
export type RuntimeExtensionSearchInput = z.infer<typeof runtimeExtensionSearchInputSchema>;

/** Authoring searches readable source metadata, independently from runtime Use and current selections. */
export const authoringExtensionSearchInputSchema = z.object({
  purpose: z.literal('authoring'),
  query: z.string().trim().min(1).max(256),
  types: z.array(z.enum(['plugin', 'skill', 'integration', 'mcp'])).min(1).max(4)
    .refine(values => new Set(values).size === values.length).optional(),
  limit: z.number().int().min(1).max(20).default(8),
  cursor: z.string().min(1).max(8192).regex(/^[a-zA-Z0-9_-]+$/u).optional(),
}).strict();
export type AuthoringExtensionSearchInput = z.infer<typeof authoringExtensionSearchInputSchema>;

/** Omitted purpose preserves the original strict runtime search input. */
export const extensionSearchInputSchema = z.union([
  runtimeExtensionSearchInputSchema.extend({ purpose: z.literal('runtime').optional() }).strict(),
  authoringExtensionSearchInputSchema,
]);

/** Operation under the existing canvas_extensions gateway; distinct from gateway operation-name search. */
export const RUNTIME_EXTENSION_SEARCH_OPERATION = 'search_canvas_extensions';
