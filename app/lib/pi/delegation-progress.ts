import 'server-only';

import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { requireAgentAccess } from '@/app/lib/agents/access';
import { db } from '@/app/lib/db';
import { piDelegationProgress, piDelegations, piSessions } from '@/app/lib/db/schema';
import { requireDelegationSource } from '@/app/lib/pi/delegation-policy';
import { PI_DELEGATION_LEASE_TIMEOUT_MS } from '@/app/lib/pi/delegation-store';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';

export type PiDelegationProgressKind =
  | 'queued' | 'running' | 'tool_start' | 'tool_end' | 'compacting'
  | 'resumed' | 'completed' | 'failed' | 'cancelled';
export type PiDelegationProgressEvent = typeof piDelegationProgress.$inferSelect;

const MAX_EVENT_KEY_LENGTH = 160;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_PAGE = 100;

/** Tool names only: never persist a prompt, raw tool result, URL, or credential. */
function safePreview(kind: PiDelegationProgressKind, preview: string | undefined): string | null {
  if ((kind !== 'tool_start' && kind !== 'tool_end') || !preview) return null;
  const name = preview.trim();
  return name.length <= MAX_TOOL_NAME_LENGTH && /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(name)
    ? name
    : null;
}

function validEventKey(value: string | undefined): string | null {
  if (!value) return null;
  const key = value.trim();
  if (!key || key.length > MAX_EVENT_KEY_LENGTH || !/^[A-Za-z0-9_.:-]+$/u.test(key)) {
    throw new Error('Invalid delegation progress event key.');
  }
  return key;
}

/** Serializes revisions on the delegation row and deduplicates confirmed boundaries. */
export async function appendPiDelegationProgress(input: {
  delegationId: string;
  userId: string;
  kind: PiDelegationProgressKind;
  preview?: string;
  eventKey?: string;
}): Promise<PiDelegationProgressEvent | null> {
  const eventKey = validEventKey(input.eventKey);
  return db.transaction(async (tx) => {
    const [delegation] = await tx.select({
      id: piDelegations.id,
      status: piDelegations.status,
      runOwnerId: piDelegations.runOwnerId,
      freshRunLease: sql<boolean>`${piDelegations.runHeartbeatAt} >= floor(extract(epoch from clock_timestamp()) * 1000)::bigint - ${PI_DELEGATION_LEASE_TIMEOUT_MS}`,
    })
      .from(piDelegations)
      .where(and(eq(piDelegations.id, input.delegationId), eq(piDelegations.userId, input.userId)))
      .for('update');
    if (!delegation) return null;

    if (eventKey) {
      const [existing] = await tx.select().from(piDelegationProgress)
        .where(and(eq(piDelegationProgress.delegationId, delegation.id), eq(piDelegationProgress.eventKey, eventKey)))
        .limit(1);
      if (existing) return existing;
    }

    const isWorkerEvent = ['tool_start', 'tool_end', 'compacting', 'resumed'].includes(input.kind);
    const allowed = input.kind === delegation.status
      || (delegation.status === 'running' && isWorkerEvent && Boolean(delegation.runOwnerId) && delegation.freshRunLease);
    if (!allowed) return null;

    const [updated] = await tx.update(piDelegations)
      .set({ progressRevision: sql`${piDelegations.progressRevision} + 1` })
      .where(eq(piDelegations.id, delegation.id))
      .returning({ progressRevision: piDelegations.progressRevision });
    if (!updated) return null;
    const [created] = await tx.insert(piDelegationProgress).values({
      delegationId: delegation.id,
      revision: updated.progressRevision,
      eventKey,
      kind: input.kind,
      preview: safePreview(input.kind, input.preview),
      createdAt: new Date(),
    }).returning();
    return created ?? null;
  });
}

export async function authorizePiDelegationInspection(input: {
  delegationId: string;
  userId: string;
  sourceSessionId: string;
}): Promise<{
  delegation: typeof piDelegations.$inferSelect;
  workerSession: typeof piSessions.$inferSelect | null;
}> {
  const sourceSessionId = input.sourceSessionId.trim();
  if (!sourceSessionId) throw new Error('Parent session is required.');
  const delegation = await db.query.piDelegations.findFirst({
    where: and(
      eq(piDelegations.id, input.delegationId),
      eq(piDelegations.userId, input.userId),
      eq(piDelegations.sourceSessionId, sourceSessionId),
    ),
  });
  if (!delegation) throw new Error('Delegation not found.');

  const source = await authorizePiDelegationParentRead(input);
  if (delegation.sourceAgentId !== source.sourceAgentId) throw new Error('Delegation source agent changed.');
  const workerAgentId = delegation.targetAgentId ?? delegation.sourceAgentId;
  await requireAgentAccess(input.userId, workerAgentId, 'canUse', {
    organizationId: source.organizationId,
    workspaceId: source.workspaceId,
    projectId: source.projectId,
  });

  const workerSession = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.userId, input.userId), eq(piSessions.sessionId, delegation.workerSessionId)),
  }) ?? null;
  if (workerSession && (
    workerSession.sessionKind !== 'delegation_worker'
    || workerSession.delegationDepth !== 1
    || workerSession.parentSessionId !== sourceSessionId
    || workerSession.agentId !== workerAgentId
    || workerSession.workspaceId !== source.workspaceId
    || workerSession.organizationId !== source.organizationId
    || workerSession.projectId !== source.projectId
  )) {
    throw new Error('Worker session does not belong to this parent context.');
  }
  return { delegation, workerSession };
}

export async function authorizePiDelegationParentRead(input: {
  userId: string;
  sourceSessionId: string;
}) {
  const source = await requireDelegationSource({
    userId: input.userId,
    sourceSessionId: input.sourceSessionId,
  });
  const workspace = await resolveAgentSessionWorkspaceForUser({
    userId: input.userId,
    workspaceId: source.workspaceId,
    permissions: ['canRead', 'canRunAgent'],
  });
  if (source.workspaceId && workspace.workspaceId !== source.workspaceId) {
    throw new Error('Parent workspace is no longer accessible.');
  }
  if (workspace.organizationId !== source.organizationId) {
    throw new Error('Parent organization changed.');
  }
  return source;
}

export async function readAuthorizedPiDelegationProgress(input: {
  delegationId: string;
  userId: string;
  sourceSessionId: string;
  afterRevision?: number;
  limit?: number;
}): Promise<{
  delegation: typeof piDelegations.$inferSelect;
  workerSession: typeof piSessions.$inferSelect | null;
  events: PiDelegationProgressEvent[];
  leaseState: 'active' | 'expired' | 'unknown' | null;
}> {
  const inspected = await authorizePiDelegationInspection(input);
  const afterRevision = Math.max(0, Math.trunc(input.afterRevision ?? 0));
  const limit = Math.max(1, Math.min(MAX_PAGE, Math.trunc(input.limit ?? 50)));
  const events = await db.select().from(piDelegationProgress)
    .where(and(eq(piDelegationProgress.delegationId, input.delegationId), gt(piDelegationProgress.revision, afterRevision)))
    .orderBy(asc(piDelegationProgress.revision))
    .limit(limit);
  const [lease] = await db.select({
    state: sql<'active' | 'expired' | 'unknown' | null>`CASE
      WHEN ${piDelegations.status} <> 'running' THEN NULL
      WHEN ${piDelegations.runOwnerId} IS NULL OR ${piDelegations.runHeartbeatAt} IS NULL THEN 'unknown'
      WHEN ${piDelegations.runHeartbeatAt} < floor(extract(epoch from clock_timestamp()) * 1000)::bigint - ${PI_DELEGATION_LEASE_TIMEOUT_MS} THEN 'expired'
      ELSE 'active' END`,
  }).from(piDelegations).where(eq(piDelegations.id, input.delegationId));
  return { ...inspected, events, leaseState: lease?.state ?? null };
}
