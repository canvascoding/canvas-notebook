import { z } from 'zod';

/** Client-safe contracts. Provider credentials continue to use the Secrets service. */
export const API_KEY_ACTIONS = ['read', 'create', 'import', 'edit', 'copy', 'move', 'delete', 'status', 'recover'] as const;
export type ApiKeyAction = typeof API_KEY_ACTIONS[number];

const identifier = z.string().uuid();
const grants = {
  workspaceIds: z.array(z.string().trim().min(1).max(256)).min(1).max(100)
    .refine(values => new Set(values).size === values.length, 'Duplicate workspaces are not allowed.'),
  actions: z.array(z.enum(API_KEY_ACTIONS)).min(1).max(API_KEY_ACTIONS.length)
    .refine(values => new Set(values).size === values.length, 'Duplicate actions are not allowed.'),
};
const name = z.string().trim().min(1).max(100);
const expiresAt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const createApiIntegrationSchema = z.object({
  requestId: identifier, name, workspaceIds: grants.workspaceIds,
  actions: grants.actions.default(['read']), expiresAt,
}).strict();
export const updateApiIntegrationSchema = z.object({
  expectedRevision: z.number().int().min(1), name, ...grants,
}).strict();
export const rotateApiKeySchema = z.object({
  requestId: identifier, expectedRevision: z.number().int().min(1), expiresAt,
}).strict();
export const revokeApiKeySchema = z.object({
  expectedRevision: z.number().int().min(1), credentialId: identifier,
}).strict();
export const apiKeyPageSchema = z.object({
  afterId: identifier.optional(), limit: z.coerce.number().int().min(1).max(50).default(25),
}).strict();

export type ApiIntegrationGrant = { workspaceIds: string[]; actions: ApiKeyAction[] };
export type ApiKeyMetadata = {
  id: string; prefix: string; issuanceRequestId: string; createdAt: number;
  expiresAt: number; revokedAt: number | null; lastUsedAt: number | null;
};
export type ApiIntegrationMetadata = ApiIntegrationGrant & {
  id: string; name: string; creationRequestId: string; revision: number;
  createdAt: number; updatedAt: number; latestCredential: ApiKeyMetadata | null;
};

export class ApiKeyAccessError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number,
    public readonly details: Record<string, string | number> = {}) {
    super(message);
    this.name = 'ApiKeyAccessError';
  }
}
