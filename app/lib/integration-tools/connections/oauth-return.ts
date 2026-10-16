import { z } from 'zod';
import { safePluginReturnTo } from '@/app/lib/plugins/plugin-return';
import { IntegrationConnectionError, type IntegrationConnectionActor, type IntegrationConnectionResource,
  type SharedIntegrationConnectionOwnership } from './contracts';

export type SharedConnectionOAuthReturnContext = {
  version: 1;
  locale: 'de' | 'en';
  workspaceId: string;
  ownership: SharedIntegrationConnectionOwnership;
  connectionRef: string;
  catalog?: {q?: string; kind?: 'all' | 'plugin' | 'skill' | 'integration' | 'mcp'; stock?: 'all' | 'installed' | 'available';
    extensionSource?: 'all' | 'store' | 'composio' | 'mcp'; scope?: 'all' | 'user' | 'team' | 'organization' | 'system';
    teamId?: string; audience?: 'own' | 'shared'; extensionId?: string; resourceRef?: string; task?: 'connections'};
};

const identifier = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\\\u0000-\u001f\u007f]/u.test(value));
const ownership = z.discriminatedUnion('type', [
  z.object({ type: z.literal('organization'), organizationId: identifier }).strict(),
  z.object({ type: z.literal('team'), organizationId: identifier, workspaceId: identifier }).strict(),
]);
const catalogSchema = z.object({q: z.string().max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)).optional(),
  kind: z.enum(['all', 'plugin', 'skill', 'integration', 'mcp']).optional(), stock: z.enum(['all', 'installed', 'available']).optional(),
  extensionSource: z.enum(['all', 'store', 'composio', 'mcp']).optional(), scope: z.enum(['all', 'user', 'team', 'organization', 'system']).optional(),
  teamId: identifier.optional(), audience: z.enum(['own', 'shared']).optional(), extensionId: z.string().min(1).max(4096).refine(value => !/[\\\u0000-\u001f\u007f]/u.test(value)).optional(),
  resourceRef: z.string().regex(/^canvas-resource:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u).optional(), task: z.literal('connections').optional(),
}).strict().superRefine((value, context) => {
  if (value.teamId && value.scope !== 'team' || value.audience && value.scope !== 'user' || Boolean(value.resourceRef) !== Boolean(value.task)) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Invalid catalog selection.'});
  }
});
const contextSchema = z.object({ version: z.literal(1), locale: z.enum(['de', 'en']), workspaceId: identifier, ownership,
  connectionRef: z.string().regex(/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u), catalog: catalogSchema.optional() }).strict();

/** Routing never establishes authority; callers must supply their freshly authorized resource. */
export function validateSharedConnectionOAuthReturn(value: unknown, resource: IntegrationConnectionResource,
  actor: Pick<IntegrationConnectionActor, 'workspaceId'>): asserts value is SharedConnectionOAuthReturnContext {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_INVALID', 'The shared sign-in return context is invalid.');
  const context = parsed.data, expected = resource.ownership;
  if (context.connectionRef !== resource.connectionRef || context.workspaceId !== actor.workspaceId
    || context.catalog?.resourceRef && context.catalog.extensionId && context.catalog.extensionId !== context.catalog.resourceRef
    || context.ownership.type !== expected.type || context.ownership.organizationId !== expected.organizationId
    || (context.ownership.type === 'team' ? context.ownership.workspaceId : null) !== (expected.type === 'team' ? expected.workspaceId : null)) {
    throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_CHANGED', 'The shared sign-in return context no longer matches its connection.', 409);
  }
  if (context.catalog?.extensionId && !context.catalog.resourceRef && context.catalog.extensionId !== resource.connectionRef
    && !(resource.source === 'composio' && context.catalog.extensionId === `composio:${resource.application}`)) {
    throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_CHANGED', 'The selected catalog entry no longer matches its connection.', 409);
  }
}

export function createSharedConnectionOAuthReturn(resource: IntegrationConnectionResource,
  actor: Pick<IntegrationConnectionActor, 'workspaceId'>, locale: 'de' | 'en', catalogReturnPath?: string): SharedConnectionOAuthReturnContext {
  let catalog: SharedConnectionOAuthReturnContext['catalog'];
  if (catalogReturnPath !== undefined) {
    const safe = safePluginReturnTo(catalogReturnPath);
    if (!safe) throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_INVALID', 'The catalog return path is invalid.');
    const url = new URL(safe, 'https://canvas.invalid');
    const allowed = new Set(['view', 'area', 'source', 'workspaceId', 'q', 'kind', 'stock', 'extensionSource', 'scope', 'teamId', 'audience', 'extensionId', 'resourceRef', 'task', 'connectionRef', 'sharedOAuth', 'extensionCursor']);
    if (url.pathname !== `/${locale}/plugins` || url.hash || url.searchParams.get('view') !== 'browse'
      || [...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)
      || url.searchParams.has('workspaceId') && url.searchParams.get('workspaceId') !== actor.workspaceId) {
      throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_INVALID', 'The catalog return selection is invalid.');
    }
    const selected = Object.fromEntries([...url.searchParams].filter(([key]) => !['view', 'area', 'source', 'workspaceId', 'connectionRef', 'sharedOAuth', 'extensionCursor'].includes(key)));
    const parsed = catalogSchema.safeParse(selected);
    if (!parsed.success) throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_INVALID', 'The catalog return selection is invalid.');
    catalog = parsed.data;
    if (!catalog.extensionId && !catalog.resourceRef) catalog.extensionId = resource.connectionRef;
  }
  const context: unknown = { version: 1, locale, workspaceId: actor.workspaceId, ownership: structuredClone(resource.ownership), connectionRef: resource.connectionRef,
    ...(catalog ? {catalog} : {}) };
  validateSharedConnectionOAuthReturn(context, resource, actor);
  Object.freeze(context.ownership);
  if (context.catalog) Object.freeze(context.catalog);
  return Object.freeze(context);
}

/** Construct a closed local Plugins path without copying any callback query or hash. */
export function sharedConnectionOAuthReturnHref(context: SharedConnectionOAuthReturnContext,
  status?: 'connected' | 'cancelled' | 'failed'): string {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success || status !== undefined && !['connected', 'cancelled', 'failed'].includes(status)) {
    throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_INVALID', 'The shared sign-in return context is invalid.');
  }
  const value = parsed.data;
  const query = new URLSearchParams(value.catalog ? {view: 'browse', scope: value.catalog.scope || 'all'} : { view: 'advanced', scope: value.ownership.type });
  if (value.catalog) for (const [key, entry] of Object.entries(value.catalog)) { if (entry) query.set(key, entry); }
  else if (value.ownership.type === 'team') query.set('teamId', value.ownership.workspaceId);
  query.set('workspaceId', value.workspaceId); query.set('connectionRef', value.connectionRef);
  if (status !== undefined) query.set('sharedOAuth', status);
  return `/${value.locale}/plugins?${query}`;
}
