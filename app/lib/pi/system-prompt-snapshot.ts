import 'server-only';

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import type { AgentStorageScope } from '@/app/lib/agents/storage';
import { ensureBradleyIdentitySystemPrompt } from '@/app/lib/agents/bradley-identity';
import {
  SYSTEM_PROMPT_FOUNDATION_MARKER,
  truncateComposedSystemPrompt,
} from '@/app/lib/agents/system-prompt-shared';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { ensureCanvasMarkdownAgentGuidance } from '@/app/lib/markdown/canvas-markdown-agent-guidance';

type PiSessionPromptSnapshotRow = Pick<
  typeof piSessions.$inferSelect,
  | 'id'
  | 'userId'
  | 'agentId'
  | 'organizationId'
  | 'workspaceId'
  | 'projectId'
  | 'systemPromptSnapshot'
  | 'systemPromptSnapshotHash'
  | 'systemPromptSnapshotCreatedAt'
>;

export type PiSystemPromptSnapshot = {
  systemPrompt: string;
  systemPromptHash: string;
  systemPromptCreatedAt: Date;
};

export function hashPiSystemPrompt(systemPrompt: string): string {
  return createHash('sha256').update(systemPrompt, 'utf8').digest('hex');
}

export function buildPiSystemPromptSnapshotFromText(
  systemPrompt: string,
  createdAt = new Date(),
): PiSystemPromptSnapshot {
  return {
    systemPrompt,
    systemPromptHash: hashPiSystemPrompt(systemPrompt),
    systemPromptCreatedAt: createdAt,
  };
}

export async function createPiSystemPromptSnapshot(
  agentId?: string | null,
  scope?: AgentStorageScope | null,
): Promise<PiSystemPromptSnapshot> {
  const { systemPrompt } = await loadManagedAgentSystemPrompt(agentId, scope);
  return buildPiSystemPromptSnapshotFromText(systemPrompt);
}

export function piSystemPromptSnapshotDbFields(snapshot: PiSystemPromptSnapshot) {
  return {
    systemPromptSnapshot: snapshot.systemPrompt,
    systemPromptSnapshotHash: snapshot.systemPromptHash,
    systemPromptSnapshotCreatedAt: snapshot.systemPromptCreatedAt,
  };
}

export async function ensurePiSessionSystemPromptSnapshot(
  session: PiSessionPromptSnapshotRow,
): Promise<PiSystemPromptSnapshot> {
  const existingPrompt = session.systemPromptSnapshot;
  if (existingPrompt && existingPrompt.length > 0 && existingPrompt.includes(SYSTEM_PROMPT_FOUNDATION_MARKER)) {
    const boundedPrompt = truncateComposedSystemPrompt(
      ensureCanvasMarkdownAgentGuidance(
        ensureBradleyIdentitySystemPrompt(existingPrompt, session.agentId),
      ),
    );
    const snapshot = buildPiSystemPromptSnapshotFromText(
      boundedPrompt,
      session.systemPromptSnapshotCreatedAt ?? new Date(),
    );
    const missingMetadata =
      session.systemPromptSnapshotHash !== snapshot.systemPromptHash ||
      !session.systemPromptSnapshotCreatedAt;

    if (missingMetadata) {
      await db
        .update(piSessions)
        .set(piSystemPromptSnapshotDbFields(snapshot))
        .where(eq(piSessions.id, session.id));
    }

    return snapshot;
  }

  const snapshot = await createPiSystemPromptSnapshot(session.agentId, {
    userId: session.userId,
    organizationId: session.organizationId,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
  });
  await db
    .update(piSessions)
    .set(piSystemPromptSnapshotDbFields(snapshot))
    .where(eq(piSessions.id, session.id));

  return snapshot;
}

/**
 * Plugin and skill mutations change the generated prompt. Clear persisted
 * snapshots so inactive sessions regenerate their prompt on their next turn.
 */
export async function invalidatePiSystemPromptSnapshotsForUser(userId: string): Promise<void> {
  await db
    .update(piSessions)
    .set({
      systemPromptSnapshot: null,
      systemPromptSnapshotHash: null,
      systemPromptSnapshotCreatedAt: null,
    })
    .where(eq(piSessions.userId, userId));
}

export async function invalidatePiSystemPromptSnapshotsForOrganization(
  organizationId: string,
): Promise<string[]> {
  const sessions = await db
    .select({ userId: piSessions.userId })
    .from(piSessions)
    .where(eq(piSessions.organizationId, organizationId));
  await db
    .update(piSessions)
    .set({
      systemPromptSnapshot: null,
      systemPromptSnapshotHash: null,
      systemPromptSnapshotCreatedAt: null,
    })
    .where(eq(piSessions.organizationId, organizationId));
  return Array.from(new Set(sessions.map((session) => session.userId)));
}

export async function loadPiSessionSystemPromptSnapshot(input: {
  sessionId: string;
  userId: string;
  agentId: string;
}): Promise<PiSystemPromptSnapshot> {
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
      eq(piSessions.agentId, input.agentId),
    ),
  });

  if (session) {
    return ensurePiSessionSystemPromptSnapshot(session);
  }

  return createPiSystemPromptSnapshot(input.agentId, { userId: input.userId });
}
