import { z } from 'zod';

/** Runtime metadata discovery uses the current server-bound agent, never a requested actor or grant. */
export const runtimeExtensionSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(256),
  types: z.array(z.enum(['plugin', 'skill'])).min(1).max(2)
    .refine(values => new Set(values).size === values.length).optional(),
  limit: z.number().int().min(1).max(20).default(8),
}).strict();
export type RuntimeExtensionSearchInput = z.infer<typeof runtimeExtensionSearchInputSchema>;

/** Operation under the existing canvas_extensions gateway; distinct from gateway operation-name search. */
export const RUNTIME_EXTENSION_SEARCH_OPERATION = 'search_canvas_extensions';
