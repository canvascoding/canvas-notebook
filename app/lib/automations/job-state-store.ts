import { createHash } from 'node:crypto';

import { and, eq, lt, ne, sql } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { automationJobs, automationJobState, automationJobStateMutations, automationRuns } from '@/app/lib/db/schema';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';

import { canAccessAutomationJob } from './policy';

const MAX_KEY_LENGTH = 128;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_JOB_BYTES = 64 * 1024;
const MAX_KEYS_PER_JOB = 1024;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECEIPTS_PER_JOB = 1000;

export type AutomationJobStateAccess =
  | { kind: 'user'; userId: string }
  | { kind: 'run'; runId: string };

export type AutomationJobStateEntry = {
  key: string;
  value: string;
  revision: number;
  updatedAt: string;
};

export type AutomationJobStateMetadata = Omit<AutomationJobStateEntry, 'value'>;

export type AutomationJobStateMutationResult =
  | { action: 'set'; entry: AutomationJobStateEntry }
  | { action: 'delete'; key: string; previousRevision: number };

export class AutomationJobStateError extends Error {
  constructor(
    message: string,
    readonly code: 'ACCESS_DENIED' | 'INVALID_INPUT' | 'REVISION_CONFLICT' | 'SIZE_LIMIT' | 'MUTATION_CONFLICT',
  ) {
    super(message);
    this.name = 'AutomationJobStateError';
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type JobRow = typeof automationJobs.$inferSelect;

function validateKey(key: string): string {
  if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new AutomationJobStateError('State key must contain 1–128 printable characters.', 'INVALID_INPUT');
  }
  return key;
}

function validateMutationId(mutationId: string): string {
  if (typeof mutationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(mutationId)) {
    throw new AutomationJobStateError('Mutation ID is invalid.', 'INVALID_INPUT');
  }
  return mutationId;
}

function validateExpectedRevision(expectedRevision: number | null, action: 'set' | 'delete'): void {
  if (expectedRevision === null && action === 'set') return;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    throw new AutomationJobStateError('A positive expected revision is required.', 'INVALID_INPUT');
  }
}

function mapEntry(row: typeof automationJobState.$inferSelect): AutomationJobStateEntry {
  return { key: row.key, value: row.value, revision: row.revision, updatedAt: row.updatedAt.toISOString() };
}

async function authorizeJob(tx: Transaction, jobId: string, access: AutomationJobStateAccess, write = false): Promise<JobRow> {
  const [job] = await tx.select().from(automationJobs).where(eq(automationJobs.id, jobId)).limit(1).for('update');
  if (!job || job.deletedAt || job.integrityStatus !== 'valid') {
    throw new AutomationJobStateError('Automation is unavailable.', 'ACCESS_DENIED');
  }

  if (access.kind === 'user') {
    if (!access.userId || !await canAccessAutomationJob(access.userId, job)) {
      throw new AutomationJobStateError('Automation state access denied.', 'ACCESS_DENIED');
    }
    try {
      if (!job.workspaceId) throw new Error('Missing workspace');
      await resolveAgentSessionWorkspaceForUser({
        userId: access.userId, workspaceId: job.workspaceId,
        permissions: write ? ['canRead', 'canWrite'] : ['canRead'],
      });
    } catch {
      throw new AutomationJobStateError('Automation workspace access denied.', 'ACCESS_DENIED');
    }
  } else {
    const [run] = await tx.select().from(automationRuns).where(and(
      eq(automationRuns.id, access.runId), eq(automationRuns.jobId, jobId),
    )).limit(1);
    if (!run || run.status !== 'running' || run.jobScope !== job.jobScope || run.workspaceId !== job.workspaceId
      || run.organizationId !== job.organizationId || run.scope !== job.scope) {
      throw new AutomationJobStateError('Automation run has no access to this job state.', 'ACCESS_DENIED');
    }
    try {
      if (!job.workspaceId || !run.actorUserId) throw new Error('Missing runtime identity');
      await resolveAgentSessionWorkspaceForUser({
        userId: run.actorUserId, workspaceId: job.workspaceId,
        permissions: write ? ['canRead', 'canWrite', 'canRunAgent'] : ['canRead', 'canRunAgent'],
      });
    } catch {
      throw new AutomationJobStateError('Automation runtime workspace access denied.', 'ACCESS_DENIED');
    }
  }
  return job;
}

/** Metadata-only by default; values must be read one key at a time. */
export async function listAutomationJobState(jobId: string, access: AutomationJobStateAccess): Promise<AutomationJobStateMetadata[]> {
  return db.transaction(async (tx) => {
    const job = await authorizeJob(tx, jobId, access);
    const rows = await tx.select({ key: automationJobState.key, revision: automationJobState.revision,
      updatedAt: automationJobState.updatedAt }).from(automationJobState).where(and(
      eq(automationJobState.jobId, jobId), eq(automationJobState.jobScope, job.jobScope), eq(automationJobState.deleted, false),
    ));
    return rows.map((row) => ({ key: row.key, revision: row.revision, updatedAt: row.updatedAt.toISOString() }));
  });
}

export async function getAutomationJobState(
  jobId: string, key: string, access: AutomationJobStateAccess,
): Promise<AutomationJobStateEntry | null> {
  validateKey(key);
  return db.transaction(async (tx) => {
    const job = await authorizeJob(tx, jobId, access);
    const [row] = await tx.select().from(automationJobState).where(and(
      eq(automationJobState.jobId, jobId), eq(automationJobState.jobScope, job.jobScope),
      eq(automationJobState.key, key), eq(automationJobState.deleted, false),
    )).limit(1);
    return row ? mapEntry(row) : null;
  });
}

export async function mutateAutomationJobState(input: {
  jobId: string;
  key: string;
  access: AutomationJobStateAccess;
  action: 'set' | 'delete';
  value?: string;
  expectedRevision: number | null;
  mutationId: string;
}): Promise<AutomationJobStateMutationResult> {
  const key = validateKey(input.key);
  const mutationId = validateMutationId(input.mutationId);
  validateExpectedRevision(input.expectedRevision, input.action);
  if (input.action === 'set' && (typeof input.value !== 'string' || Buffer.byteLength(input.value, 'utf8') > MAX_VALUE_BYTES)) {
    throw new AutomationJobStateError('State value exceeds 16 KiB or is invalid.', 'SIZE_LIMIT');
  }
  if (input.action === 'delete' && input.value !== undefined) {
    throw new AutomationJobStateError('Delete must not include a value.', 'INVALID_INPUT');
  }
  const requestHash = createHash('sha256').update(JSON.stringify({
    action: input.action, key, value: input.value ?? null, expectedRevision: input.expectedRevision,
    access: input.access,
  })).digest('hex');

  return db.transaction(async (tx) => {
    const job = await authorizeJob(tx, input.jobId, input.access, true);
    // A moved job must not expose or overwrite state from its previous scope.
    await tx.delete(automationJobState).where(and(
      eq(automationJobState.jobId, input.jobId), ne(automationJobState.jobScope, job.jobScope),
    ));
    await tx.delete(automationJobStateMutations).where(and(
      eq(automationJobStateMutations.jobId, input.jobId), ne(automationJobStateMutations.jobScope, job.jobScope),
    ));
    const [receipt] = await tx.select().from(automationJobStateMutations).where(and(
      eq(automationJobStateMutations.jobId, input.jobId), eq(automationJobStateMutations.jobScope, job.jobScope),
      eq(automationJobStateMutations.mutationId, mutationId),
    )).limit(1);
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        throw new AutomationJobStateError('Mutation ID was already used for another write.', 'MUTATION_CONFLICT');
      }
      const saved = JSON.parse(receipt.resultJson) as AutomationJobStateMutationResult;
      return saved.action === 'set'
        ? { ...saved, entry: { ...saved.entry, value: input.value! } }
        : saved;
    }

    const [existing] = await tx.select().from(automationJobState).where(and(
      eq(automationJobState.jobId, input.jobId), eq(automationJobState.key, key),
    )).limit(1);
    if ((existing && !existing.deleted ? existing.revision : null) !== input.expectedRevision) {
      throw new AutomationJobStateError('State revision changed. Read it again before writing.', 'REVISION_CONFLICT');
    }

    let result: AutomationJobStateMutationResult;
    if (input.action === 'set') {
      const all = await tx.select({ key: automationJobState.key, value: automationJobState.value,
        deleted: automationJobState.deleted })
        .from(automationJobState).where(and(
          eq(automationJobState.jobId, input.jobId), eq(automationJobState.jobScope, job.jobScope),
        ));
      if (!existing && all.length >= MAX_KEYS_PER_JOB) {
        throw new AutomationJobStateError('Automation state has too many keys.', 'SIZE_LIMIT');
      }
      // Tombstones count toward both storage limits and key count so CAS
      // revisions can remain monotone without unbounded deleted-key growth.
      const currentBytes = all.reduce((total, row) => total + Buffer.byteLength(row.key, 'utf8')
        + (row.deleted ? 0 : Buffer.byteLength(row.value, 'utf8')), 0);
      const previousBytes = existing ? Buffer.byteLength(existing.key, 'utf8')
        + (existing.deleted ? 0 : Buffer.byteLength(existing.value, 'utf8')) : 0;
      const nextBytes = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(input.value!, 'utf8');
      if (currentBytes - previousBytes + nextBytes > MAX_JOB_BYTES) {
        throw new AutomationJobStateError('Automation state exceeds 64 KiB.', 'SIZE_LIMIT');
      }
      const now = new Date();
      const revision = (existing?.revision ?? 0) + 1;
      if (existing) {
        await tx.update(automationJobState).set({ value: input.value!, deleted: false, revision, updatedAt: now }).where(and(
          eq(automationJobState.jobId, input.jobId), eq(automationJobState.key, key),
        ));
      } else {
        await tx.insert(automationJobState).values({ jobId: input.jobId, jobScope: job.jobScope, key,
          value: input.value!, deleted: false, revision, updatedAt: now });
      }
      result = { action: 'set', entry: { key, value: input.value!, revision, updatedAt: now.toISOString() } };
    } else {
      await tx.update(automationJobState).set({ value: '', deleted: true,
        revision: existing!.revision + 1, updatedAt: new Date() }).where(and(
        eq(automationJobState.jobId, input.jobId), eq(automationJobState.key, key),
      ));
      result = { action: 'delete', key, previousRevision: existing!.revision };
    }

    await tx.insert(automationJobStateMutations).values({
      jobId: input.jobId, jobScope: job.jobScope, mutationId,
      runId: input.access.kind === 'run' ? input.access.runId : null,
      actorUserId: input.access.kind === 'user' ? input.access.userId : null,
      requestHash,
      resultJson: JSON.stringify(result.action === 'set'
        ? { ...result, entry: { ...result.entry, value: '' } }
        : result),
      createdAt: new Date(),
    });
    await tx.delete(automationJobStateMutations).where(and(
      eq(automationJobStateMutations.jobId, input.jobId),
      lt(automationJobStateMutations.createdAt, new Date(Date.now() - RECEIPT_RETENTION_MS)),
    ));
    await tx.execute(sql`
      DELETE FROM automation_job_state_mutations
      WHERE job_id = ${input.jobId} AND mutation_id IN (
        SELECT mutation_id FROM automation_job_state_mutations
        WHERE job_id = ${input.jobId}
        ORDER BY created_at DESC, mutation_id DESC OFFSET ${MAX_RECEIPTS_PER_JOB}
      )
    `);
    return result;
  });
}
