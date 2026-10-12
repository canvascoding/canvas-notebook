import { z } from 'zod';

export const mobileSharedOAuthFlowIdSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
export const mobileSharedOAuthConnectionRefSchema = z.string().regex(/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const mobileSharedOAuthStartSchema = z.object({
  source: z.enum(['mcp', 'composio']), flowId: mobileSharedOAuthFlowIdSchema,
  expectedMetadataRevision: revision, expectedGrantsRevision: revision, expectedBindingRevision: revision,
  returnUrl: z.string().max(200),
}).strict();
export const mobileSharedOAuthActionSchema = z.object({ action: z.enum(['finalize', 'cancel']) }).strict();
export type MobileSharedOAuthStart = z.infer<typeof mobileSharedOAuthStartSchema>;
export type MobileSharedOAuthSource = MobileSharedOAuthStart['source'];
export type MobileSharedOAuthSummary = {
  flowId: string; connectionRef: string; source: MobileSharedOAuthSource; workspaceId: string;
  status: 'starting' | 'waiting' | 'callback_received' | 'completed' | 'cancelled' | 'expired' | 'failed';
  expiresAt: string; noAuth?: true; errorCode?: string;
};

/** A new native contract has one closed return destination and no caller-selected query. */
export function normalizeMobileSharedOAuthReturnUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:canvasnotebook|canvasnotebook-dev|canvasnotebook-preview):\/\/integration-return$/u.test(value)) {
    throw new Error('MOBILE_OAUTH_RETURN_INVALID');
  }
  return value;
}
