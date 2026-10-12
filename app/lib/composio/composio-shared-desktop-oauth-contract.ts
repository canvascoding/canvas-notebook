import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

import { IntegrationConnectionError, type IntegrationConnectionActor, type IntegrationConnectionBackendBinding,
  type IntegrationConnectionRevisions, type SharedIntegrationConnectionOwnership } from '@/app/lib/integration-tools/connections/contracts';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';

export type SharedComposioDesktopInitiator = { actor: IntegrationConnectionActor; authSessionId: string };
export type SharedComposioDesktopOAuthSnapshot = {
  contractVersion: 1;
  initiator: SharedComposioDesktopInitiator;
  connectionRef: string;
  ownership: SharedIntegrationConnectionOwnership;
  revisions: IntegrationConnectionRevisions;
  authorizationRevision: string;
  backend: Extract<IntegrationConnectionBackendBinding, { source: 'composio' }>;
  profileRevision: number;
  composioUserId: string;
  credentialRevision: string;
  pendingAccountId: string | null;
  authorizationUrl: string | null;
};

export type SharedComposioDesktopOAuthStatus = 'starting' | 'waiting' | 'callback_received' | 'completed' | 'cancelled' | 'expired' | 'failed';
type SummaryIdentity = { connectionRef: string; state: string; expiresAt: string };
type SummaryWithoutAuthorization = { authorizationUrl?: never };
export type SharedComposioDesktopOAuthSummary = SummaryIdentity & (
  | (SummaryWithoutAuthorization & { status: 'starting'; code?: never; error?: never })
  | (SummaryWithoutAuthorization & { status: 'starting'; code: 'CONNECTION_DESKTOP_OAUTH_START_UNCONFIRMED';
    error: 'Shared sign-in start is unconfirmed. Reload and check this sign-in.' })
  | { status: 'waiting'; authorizationUrl: string; code?: never; error?: never }
  | (SummaryWithoutAuthorization & { status: 'callback_received' | 'completed'; code?: never; error?: never })
  | (SummaryWithoutAuthorization & { status: 'cancelled'; code: 'CONNECTION_DESKTOP_OAUTH_CANCELLED'; error: 'Shared sign-in was cancelled.' })
  | (SummaryWithoutAuthorization & { status: 'expired'; code: 'CONNECTION_DESKTOP_OAUTH_EXPIRED'; error: 'Shared sign-in expired. Start again.' })
  | (SummaryWithoutAuthorization & { status: 'failed'; code: 'CONNECTION_DESKTOP_OAUTH_FAILED';
    error: 'Shared sign-in could not be completed. Reload and start again.' })
);

const identifier = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value));
const accountIdentifier = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value));
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const connectionRef = z.string().regex(/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const canonicalState = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).refine(value => {
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
});
const humanActorSchema = z.object({ userId: identifier, workspaceId: identifier.nullish(), organizationId: identifier.nullish(),
  // CommonStore normalizes absent PI fields to null; actual runtime identities are forbidden.
  agentId: z.null().optional(), sessionId: z.null().optional(), policyRevision: z.undefined().optional(),
}).strict().transform(value => ({ userId: value.userId, workspaceId: value.workspaceId ?? null, organizationId: value.organizationId ?? null }));
const initiatorSchema = z.object({ actor: humanActorSchema, authSessionId: identifier }).strict();
const authorizationUrl = z.string().url().max(16_384).refine(value => {
  if (value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(url.hostname);
  return !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && loopback);
});
const snapshotSchema = z.object({
  contractVersion: z.literal(1), initiator: initiatorSchema, connectionRef,
  ownership: z.discriminatedUnion('type', [
    z.object({ type: z.literal('organization'), organizationId: identifier }).strict(),
    z.object({ type: z.literal('team'), organizationId: identifier, workspaceId: identifier }).strict(),
  ]),
  revisions: z.object({ metadataRevision: positive, grantsRevision: positive, bindingRevision: positive }).strict(),
  authorizationRevision: canonicalState,
  backend: z.object({ source: z.literal('composio'), profileId: identifier,
    toolkit: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/u), mode: z.enum(['local', 'managed']),
    accountBinding: z.enum(['pending', 'account', 'no_auth']), connectedAccountId: accountIdentifier.nullable(),
  }).strict().refine(value => value.accountBinding === 'account' ? value.connectedAccountId !== null : value.connectedAccountId === null),
  profileRevision: positive, composioUserId: accountIdentifier, credentialRevision: hash,
  pendingAccountId: accountIdentifier.nullable(), authorizationUrl: authorizationUrl.nullable(),
}).strict().refine(value => (value.pendingAccountId === null) === (value.authorizationUrl === null)
  && (value.initiator.actor.organizationId === null || value.initiator.actor.organizationId === value.ownership.organizationId));

function canonicalSharedComposioDesktopValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSharedComposioDesktopValue).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSharedComposioDesktopValue(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function invalidSnapshot(): IntegrationConnectionError {
  return new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID', 'The shared desktop sign-in snapshot is invalid.', 409);
}

/** Private immutable routing data, never a replacement for fresh SQL authority. */
export function parseSharedComposioDesktopInitiator(value: unknown): SharedComposioDesktopInitiator {
  const parsed = initiatorSchema.safeParse(value);
  if (!parsed.success) throw invalidSnapshot();
  Object.freeze(parsed.data.actor);
  return Object.freeze(parsed.data);
}
export function parseSharedComposioDesktopOAuthSnapshot(value: unknown): SharedComposioDesktopOAuthSnapshot {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw invalidSnapshot();
  const snapshot = parsed.data;
  Object.freeze(snapshot.initiator.actor); Object.freeze(snapshot.initiator);
  Object.freeze(snapshot.ownership); Object.freeze(snapshot.revisions); Object.freeze(snapshot.backend);
  return Object.freeze(snapshot);
}
export function sharedComposioDesktopSnapshotFingerprint(snapshot: SharedComposioDesktopOAuthSnapshot): string {
  return createHash('sha256').update(canonicalSharedComposioDesktopValue(parseSharedComposioDesktopOAuthSnapshot(snapshot))).digest('hex');
}
export function sharedComposioDesktopActorFingerprint(actor: IntegrationConnectionActor): string {
  const parsed = humanActorSchema.safeParse(actor);
  if (!parsed.success) throw invalidSnapshot();
  return createHash('sha256').update(canonicalSharedComposioDesktopValue(parsed.data)).digest('hex');
}
export function sharedComposioDesktopSessionFingerprint(authSessionId: string): string {
  const parsed = identifier.safeParse(authSessionId);
  if (!parsed.success) throw invalidSnapshot();
  return createHash('sha256').update(parsed.data).digest('hex');
}
export function deriveSharedComposioDesktopOAuthState(intent: string, initiator: SharedComposioDesktopInitiator, reference: string): string {
  const parsedIntent = canonicalState.safeParse(intent), parsedRef = connectionRef.safeParse(reference);
  if (!parsedIntent.success || !parsedRef.success) throw invalidSnapshot();
  const current = parseSharedComposioDesktopInitiator(initiator);
  return createHmac('sha256', resolveAuthSecret()).update(canonicalSharedComposioDesktopValue([
    'canvas-shared-composio-desktop-state-v1', parsedIntent.data, current.actor, current.authSessionId, parsedRef.data,
  ])).digest('base64url');
}
export function sharedComposioDesktopStateHash(state: string): string {
  const parsed = canonicalState.safeParse(state);
  if (!parsed.success) throw invalidSnapshot();
  return createHash('sha256').update(parsed.data).digest('hex');
}
