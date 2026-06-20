import 'server-only';

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';

type PiSessionPromptSnapshotRow = Pick<
  typeof piSessions.$inferSelect,
  'id' | 'userId' | 'agentId' | 'systemPromptSnapshot' | 'systemPromptSnapshotHash' | 'systemPromptSnapshotCreatedAt'
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
  scope?: { userId?: string | null } | null,
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
  if (existingPrompt && existingPrompt.length > 0) {
    const snapshot = buildPiSystemPromptSnapshotFromText(
      existingPrompt,
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

  const snapshot = await createPiSystemPromptSnapshot(session.agentId, { userId: session.userId });
  await db
    .update(piSessions)
    .set(piSystemPromptSnapshotDbFields(snapshot))
    .where(eq(piSessions.id, session.id));

  return snapshot;
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
