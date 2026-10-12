import { z } from 'zod';
import { IntegrationConnectionError, type IntegrationConnectionActor, type IntegrationConnectionResource,
  type SharedIntegrationConnectionOwnership } from './contracts';

export type SharedConnectionOAuthReturnContext = {
  version: 1;
  locale: 'de' | 'en';
  workspaceId: string;
  ownership: SharedIntegrationConnectionOwnership;
  connectionRef: string;
};

const identifier = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\\\u0000-\u001f\u007f]/u.test(value));
const ownership = z.discriminatedUnion('type', [
  z.object({ type: z.literal('organization'), organizationId: identifier }).strict(),
  z.object({ type: z.literal('team'), organizationId: identifier, workspaceId: identifier }).strict(),
]);
const contextSchema = z.object({ version: z.literal(1), locale: z.enum(['de', 'en']), workspaceId: identifier, ownership,
  connectionRef: z.string().regex(/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u) }).strict();

/** Routing never establishes authority; callers must supply their freshly authorized resource. */
export function validateSharedConnectionOAuthReturn(value: unknown, resource: IntegrationConnectionResource,
  actor: Pick<IntegrationConnectionActor, 'workspaceId'>): asserts value is SharedConnectionOAuthReturnContext {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_INVALID', 'The shared sign-in return context is invalid.');
  const context = parsed.data, expected = resource.ownership;
  if (context.connectionRef !== resource.connectionRef || context.workspaceId !== actor.workspaceId
    || context.ownership.type !== expected.type || context.ownership.organizationId !== expected.organizationId
    || (context.ownership.type === 'team' ? context.ownership.workspaceId : null) !== (expected.type === 'team' ? expected.workspaceId : null)) {
    throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_CHANGED', 'The shared sign-in return context no longer matches its connection.', 409);
  }
}

export function createSharedConnectionOAuthReturn(resource: IntegrationConnectionResource,
  actor: Pick<IntegrationConnectionActor, 'workspaceId'>, locale: 'de' | 'en'): SharedConnectionOAuthReturnContext {
  const context: unknown = { version: 1, locale, workspaceId: actor.workspaceId, ownership: structuredClone(resource.ownership), connectionRef: resource.connectionRef };
  validateSharedConnectionOAuthReturn(context, resource, actor);
  Object.freeze(context.ownership);
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
  const query = new URLSearchParams({ view: 'advanced', scope: value.ownership.type });
  if (value.ownership.type === 'team') query.set('teamId', value.ownership.workspaceId);
  query.set('workspaceId', value.workspaceId); query.set('connectionRef', value.connectionRef);
  if (status !== undefined) query.set('sharedOAuth', status);
  return `/${value.locale}/plugins?${query}`;
}
