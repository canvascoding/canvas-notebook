import { createHash } from 'node:crypto';
import { z } from 'zod';

import { IntegrationConnectionError, type IntegrationConnectionActor, type IntegrationConnectionRevisions,
  type SharedIntegrationConnectionOwnership } from '@/app/lib/integration-tools/connections/contracts';

export type SharedMcpDesktopInitiator = { actor: IntegrationConnectionActor; authSessionId: string };
export type SharedMcpDesktopOAuthSnapshot = {
  connectionId: string;
  organizationId: string;
  authVersion: number;
  configHash: string;
  lifecycleGeneration: number;
  serverUrl?: string;
  shared: {
    connectionRef: string;
    ownership: SharedIntegrationConnectionOwnership;
    initiatingUserId: string;
    revisions: IntegrationConnectionRevisions;
    authorizationRevision: string;
  };
  sharedDesktopInitiator: SharedMcpDesktopInitiator;
};

const identifier = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value));
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const humanActorSchema = z.object({ userId: identifier, workspaceId: identifier.nullish(), organizationId: identifier.nullish(),
  // CommonStore normalizes absent PI fields to null. Real PI identities are forbidden.
  agentId: z.null().optional(), sessionId: z.null().optional(), policyRevision: z.undefined().optional(),
}).strict().transform(value => ({ userId: value.userId, workspaceId: value.workspaceId ?? null, organizationId: value.organizationId ?? null }));
const snapshotSchema = z.object({
  connectionId: uuid, organizationId: identifier, authVersion: positive,
  configHash: z.string().regex(/^[a-f0-9]{64}$/u), lifecycleGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  serverUrl: z.string().url().max(8192).refine(value => {
    const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }).optional(),
  shared: z.object({
    connectionRef: z.string().regex(/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
    ownership: z.discriminatedUnion('type', [
      z.object({ type: z.literal('organization'), organizationId: identifier }).strict(),
      z.object({ type: z.literal('team'), organizationId: identifier, workspaceId: identifier }).strict(),
    ]),
    initiatingUserId: identifier,
    revisions: z.object({ metadataRevision: positive, grantsRevision: positive, bindingRevision: positive }).strict(),
    authorizationRevision: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  }).strict(),
  sharedDesktopInitiator: z.object({ actor: humanActorSchema, authSessionId: identifier }).strict(),
}).strict().refine(value => value.shared.initiatingUserId === value.sharedDesktopInitiator.actor.userId
  && value.organizationId === value.shared.ownership.organizationId
  && (value.sharedDesktopInitiator.actor.organizationId === null || value.sharedDesktopInitiator.actor.organizationId === value.organizationId));

function canonicalSharedDesktopValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSharedDesktopValue).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSharedDesktopValue(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function parseSharedMcpDesktopActor(value: unknown): IntegrationConnectionActor {
  const parsed = humanActorSchema.safeParse(value);
  if (!parsed.success) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID', 'A verified human desktop sign-in initiator is required.', 409);
  return Object.freeze(parsed.data);
}
function freezeSharedMcpDesktopSnapshot(snapshot: SharedMcpDesktopOAuthSnapshot): SharedMcpDesktopOAuthSnapshot {
  Object.freeze(snapshot.shared.revisions); Object.freeze(snapshot.shared.ownership); Object.freeze(snapshot.shared);
  Object.freeze(snapshot.sharedDesktopInitiator.actor); Object.freeze(snapshot.sharedDesktopInitiator);
  return Object.freeze(snapshot);
}

/** Private routing data, never serialized authority. Current SQL rights are checked by the caller. */
export function parseSharedMcpDesktopOAuthSnapshot(value: unknown): SharedMcpDesktopOAuthSnapshot {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID', 'The shared desktop sign-in snapshot is invalid.', 409);
  return freezeSharedMcpDesktopSnapshot(parsed.data);
}
export function sharedMcpDesktopSnapshotFingerprint(snapshot: SharedMcpDesktopOAuthSnapshot): string {
  return createHash('sha256').update(canonicalSharedDesktopValue(parseSharedMcpDesktopOAuthSnapshot(snapshot))).digest('hex');
}
export function sharedMcpDesktopActorFingerprint(actor: IntegrationConnectionActor): string {
  return createHash('sha256').update(canonicalSharedDesktopValue(parseSharedMcpDesktopActor(actor))).digest('hex');
}
export function sharedMcpDesktopSessionFingerprint(authSessionId: string): string {
  const parsed = identifier.safeParse(authSessionId);
  if (!parsed.success) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID', 'A verified desktop authentication session is required.', 409);
  return createHash('sha256').update(parsed.data).digest('hex');
}
