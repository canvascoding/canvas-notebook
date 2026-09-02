/**
 * Content-free legacy/lean scorecard over persisted local PI sessions.
 * Message text is read only in-process for token measurement and is never
 * logged or written to the report.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { closeDatabaseConnections, openDb } from '../app/lib/db';
import { evaluatePiCompactionVariants } from '../app/lib/pi/compaction/evaluation';
import { parsePersistedPiMessage } from '../app/lib/pi/message-projection';

type SessionRow = {
  id: number | string;
  summary_text: string | null;
  summary_updated_at: number | string | Date | null;
  summary_through_timestamp: number | string | null;
  summary_through_sequence: number | string | null;
  summary_revision: number | string | null;
};

type MessageRow = {
  content: string;
  sequence: number | string;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nullableNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableDate(value: number | string | Date | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function main(): Promise<void> {
  const sessionLimit = positiveInteger(process.env.CANVAS_PI_COMPACTION_EVAL_SESSION_LIMIT, 25);
  const contextWindow = positiveInteger(process.env.CANVAS_PI_COMPACTION_EVAL_CONTEXT_WINDOW, 262_144);
  const requestOutputTokens = positiveInteger(
    process.env.CANVAS_PI_COMPACTION_EVAL_OUTPUT_TOKENS,
    8_192,
  );
  const connection = await openDb();
  try {
    const sessions = await connection.all(
      `SELECT id, summary_text, summary_updated_at, summary_through_timestamp,
              summary_through_sequence, summary_revision
       FROM pi_sessions
       WHERE id IN (
         SELECT pi_session_db_id
         FROM pi_messages
         GROUP BY pi_session_db_id
         HAVING COUNT(*) >= 8
       )
       ORDER BY updated_at DESC
       LIMIT ?`,
      [sessionLimit],
    ) as SessionRow[];
    const scorecards: Array<ReturnType<typeof evaluatePiCompactionVariants>> = [];
    for (const session of sessions) {
      const rows = await connection.all(
        `SELECT content, sequence
         FROM pi_messages
         WHERE pi_session_db_id = ?
         ORDER BY sequence ASC, id ASC`,
        [session.id],
      ) as MessageRow[];
      const messages = rows.map((row) => ({
        ...(parsePersistedPiMessage(row.content, 'raw') as unknown as Record<string, unknown>),
        sequence: Number(row.sequence),
      }) as unknown as AgentMessage);
      const evaluation = evaluatePiCompactionVariants({
        messages,
        summary: {
          summaryText: session.summary_text,
          summaryUpdatedAt: nullableDate(session.summary_updated_at),
          summaryThroughTimestamp: nullableNumber(session.summary_through_timestamp),
          summaryThroughSequence: nullableNumber(session.summary_through_sequence),
          summaryRevision: nullableNumber(session.summary_revision) ?? 0,
        },
        systemPromptTokens: 8_000,
        contextWindow,
        modelMaxTokens: requestOutputTokens,
        requestOutputTokens,
        toolTokens: 8_000,
        modelIdentity: 'shadow-evaluation',
        selectionMode: 'force',
      });
      scorecards.push(evaluation);
    }

    const variants = (tailMode: 'legacy' | 'lean') => scorecards.map((scorecard) => scorecard[tailMode]);
    const summarize = (tailMode: 'legacy' | 'lean') => {
      const entries = variants(tailMode);
      const originalTokens = entries.reduce((total, entry) => total + entry.originalTokens, 0);
      const savedTokens = entries.reduce((total, entry) => total + entry.expectedSavingsTokens, 0);
      return {
        sessions: entries.length,
        messages: entries.reduce((total, entry) => total + entry.messageCount, 0),
        expectedSavingsBasisPoints: originalTokens > 0
          ? Math.floor(savedTokens * 10_000 / originalTokens)
          : 0,
        historyPartitionLossCount: entries.reduce(
          (total, entry) => total + entry.historyPartitionLossCount,
          0,
        ),
        newlyOrphanedToolGroupCount: entries.reduce(
          (total, entry) => total + entry.newlyOrphanedToolGroupCount,
          0,
        ),
        anchorFailureCount: entries.filter(
          (entry) => !entry.activeUserAnchored || !entry.visibleAssistantAnchored,
        ).length,
        p95SelectionDurationMs: percentile(
          entries.map((entry) => entry.selectionDurationMs),
          0.95,
        ),
      };
    };
    const report = {
      schemaVersion: 1,
      contentFree: true,
      contextWindow,
      requestOutputTokens,
      legacy: summarize('legacy'),
      lean: summarize('lean'),
    };
    console.log(JSON.stringify(report));
    for (const result of [report.legacy, report.lean]) {
      if (
        result.historyPartitionLossCount > 0
        || result.newlyOrphanedToolGroupCount > 0
        || result.anchorFailureCount > 0
      ) {
        process.exitCode = 1;
      }
    }
  } finally {
    await connection.close();
    await closeDatabaseConnections();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Session compaction evaluation failed.');
  process.exit(1);
});
