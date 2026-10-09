import 'server-only';

import { randomUUID } from 'node:crypto';
import { DecisionModelError } from '@/app/lib/decision-models/errors';
import type { DecisionInput, DecisionResult } from '@/app/lib/decision-models/types';
import { htmlToPlainText } from '@/app/lib/email/html-conversion';
import { isLikelyHtmlEmailContent } from '@/app/lib/email/html-content';
import { EMAIL_SEARCH_SYNTAX_VERSION } from '@/app/lib/email/search-query';
import type { EmailClassificationCredentialResolution } from './credential-service';
import { resolveEmailClassificationExecution, executeEmailClassification, reconcileEmailClassificationExecution, type EmailClassificationExecutionDependencies } from './execution-service';
import { ManagedDecisionClientError } from '@/app/lib/managed/decision-client';
import { emailClassificationMessageIdentity } from './identity';
import { ingestEmailClassificationMetadata, isStoredEmailClassificationResultCurrent } from './index-service';
import { canClassifyIndexedEmail, listEmailClassificationDiscoveryUserIds, resolveAuthorizedEmailClassificationMailboxes } from './mailbox-registry';
import type { AuthorizedEmailClassificationMailbox } from './mailbox-types';
import { normalizeEmailClassificationResult } from './normalize';
import { buildEmailClassificationQuestions, buildEmailDecisionState, EMAIL_CLASSIFICATION_SCHEMA_VERSION } from './schema';
import { emailClassificationEvaluationFingerprint } from './settings-evaluation';
import { isEmailSelectedForClassification } from './selection';
import { EmailMailboxSyncError, emailMailboxSyncErrorCode } from './sync-errors';
import type { EmailClassificationConfiguration } from './settings-types';
import { getRuntimeEmailClassificationStore, type PostgresEmailClassificationStore } from './store';
import type { StoredEmailClassificationJob, StoredEmailClassificationMailbox, StoredEmailClassificationMetadata } from './store-types';

type WorkerStoreMethods = 'readSettings' | 'upsertMailbox' | 'readMailbox' | 'deactivateMailbox' | 'recordMailboxSync' | 'claimMailboxSync' | 'releaseMailboxSync' | 'reconcileMailboxInbox' | 'readMessages' | 'readResultsBatch' | 'readClassificationHistory' | 'enqueueClassification' | 'claimJobs' | 'readJob' | 'renewClaim' | 'retryJob' | 'completeJob';
export type EmailClassificationWorkerStore = Pick<PostgresEmailClassificationStore, WorkerStoreMethods> & {
  updateSettings?: PostgresEmailClassificationStore['updateSettings'];
  cancelClaim(input: { jobId: string; claimToken: string; errorCode: string; now?: number }): Promise<boolean>;
  listActiveMailboxes?(): Promise<StoredEmailClassificationMailbox[]>;
};

export interface EmailClassificationWorkerPage {
  messages: Record<string, unknown>[];
  total: number | null;
  hasMore: boolean;
  nextOffset: number | null;
  uidValidity?: string | number;
  confirmed: boolean;
}

type MailboxActor = { mailbox: AuthorizedEmailClassificationMailbox; actorUserId: string };
type RawListInput = MailboxActor & { offset: number; limit: number; signal: AbortSignal };
type RawReadInput = MailboxActor & { message: StoredEmailClassificationMetadata; signal: AbortSignal };

export interface EmailClassificationWorkerDependencies extends EmailClassificationExecutionDependencies {
  getStore?: () => Promise<EmailClassificationWorkerStore>;
  listUserIds?: () => Promise<string[]>;
  resolveMailboxes?: (actorUserId: string) => Promise<AuthorizedEmailClassificationMailbox[]>;
  listMessages?: (input: RawListInput) => Promise<EmailClassificationWorkerPage>;
  readMessage?: (input: RawReadInput) => Promise<Record<string, unknown>>;
  ingestMetadata?: typeof ingestEmailClassificationMetadata;
  isResultCurrent?: typeof isStoredEmailClassificationResultCurrent;
  evaluate?: (input: DecisionInput) => Promise<DecisionResult>;
  resolveCredential?: (configuration: EmailClassificationConfiguration) => EmailClassificationCredentialResolution;
  now?: () => number;
  random?: () => number;
  maxMailboxesPerCycle?: number;
  maxPagesPerMailbox?: number;
  maxAttempts?: number;
  claimCheckIntervalMs?: number;
  rawTimeoutMs?: number;
  /** Production discovery is bounded to at least one minute; zero is reserved for deterministic tests. */
  discoveryIntervalMs?: number;
}

export interface EmailClassificationCycleResult {
  discovered: number; synced: number; indexed: number; claimed: number;
  completed: number; reused: number; retried: number; failed: number; canceled: number;
}

type SyncCursor = {
  version: 2; phase: 'backfill' | 'head' | 'blocked'; offset: number;
  scanned: number; historicalQueued: number; headCheckedAt: number; complete: boolean;
  evaluationFingerprint: string | null; generationStartedAt: number;
};

class WorkerCancelled extends Error {
  constructor(readonly code: string) { super('Email classification execution was canceled.'); }
}

function cursorFrom(value: string | null): SyncCursor {
  try {
    const parsed = value ? JSON.parse(value) as SyncCursor : null;
    if (parsed?.version === 2 && ['backfill', 'head', 'blocked'].includes(parsed.phase)
      && [parsed.offset, parsed.scanned, parsed.historicalQueued, parsed.headCheckedAt, parsed.generationStartedAt].every(number => Number.isSafeInteger(number) && number >= 0)
      && typeof parsed.complete === 'boolean'
      && (parsed.evaluationFingerprint === null || typeof parsed.evaluationFingerprint === 'string')) return parsed;
  } catch { /* Restart a bounded scan after an invalid or obsolete cursor. */ }
  return { version: 2, phase: 'backfill', offset: 0, scanned: 0, historicalQueued: 0, headCheckedAt: 0, complete: false, evaluationFingerprint: null, generationStartedAt: 0 };
}

function normalizedInboxMessage(message: Record<string, unknown>, page: EmailClassificationWorkerPage, mailbox: AuthorizedEmailClassificationMailbox): Record<string, unknown> {
  return { ...message, folder: message.folder || (mailbox.provider === 'microsoft' ? 'inbox' : 'INBOX'),
    ...(message.uidValidity === undefined && page.uidValidity !== undefined ? { uidValidity: page.uidValidity } : {}) };
}

function messageRef(message: Record<string, unknown>, mailbox: AuthorizedEmailClassificationMailbox): string | null {
  try { return emailClassificationMessageIdentity(mailbox, message as { id: string }).messageRef; } catch { return null; }
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new WorkerCancelled('stopped'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new WorkerCancelled('stopped'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function emailClassificationRetryDelay(attempts: number, random = Math.random, retryAfterMs?: number): number {
  const exponential = Math.min(60 * 60_000, 2_000 * 2 ** Math.max(0, Math.min(attempts - 1, 20)));
  const jitter = exponential * (0.8 + Math.max(0, Math.min(1, random())) * 0.4);
  return Math.min(24 * 60 * 60_000, Math.max(Math.ceil(jitter), retryAfterMs ?? 0));
}

async function defaultList(input: RawListInput): Promise<EmailClassificationWorkerPage> {
  const service = await import('@/app/lib/email/service');
  const options = { actorUserId: input.actorUserId, workspaceId: input.mailbox.workspaceId, enforceReadPolicy: Boolean(input.mailbox.workspaceId), cacheMode: 'provider' as const, skipClassification: true, prefetchDetails: false };
  const raw = await service.listEmailMessages(input.mailbox.ownerUserId, { accountId: input.mailbox.accountId,
    folder: input.mailbox.provider === 'microsoft' ? 'inbox' : 'INBOX', offset: input.offset, limit: input.limit }, options) as Record<string, unknown>;
  return { messages: Array.isArray(raw.messages) ? raw.messages.filter((message): message is Record<string, unknown> => Boolean(message && typeof message === 'object' && !Array.isArray(message))) : [],
    total: typeof raw.total === 'number' && Number.isFinite(raw.total) && raw.total >= 0 ? raw.total : null,
    hasMore: raw.hasMore === true, nextOffset: typeof raw.nextOffset === 'number' ? raw.nextOffset : null,
    uidValidity: typeof raw.uidValidity === 'string' || typeof raw.uidValidity === 'number' ? raw.uidValidity : undefined,
    confirmed: input.mailbox.accountSource !== 'managed' || raw.searchSyntaxVersion === EMAIL_SEARCH_SYNTAX_VERSION };
}

async function defaultRead(input: RawReadInput): Promise<Record<string, unknown>> {
  const service = await import('@/app/lib/email/service');
  const options = { actorUserId: input.actorUserId, workspaceId: input.mailbox.workspaceId, enforceReadPolicy: true, cacheMode: 'provider' as const, skipClassification: true, prefetchDetails: false };
  const raw = await service.readEmailMessage(input.mailbox.ownerUserId, input.mailbox.accountId, input.message.canonicalId, input.message.folder, options) as { message?: unknown };
  if (!raw.message || typeof raw.message !== 'object' || Array.isArray(raw.message)) throw new Error('Email source did not provide a message.');
  return raw.message as Record<string, unknown>;
}

/** One instance owns its transient fairness, circuit breaker and active request state. DB owns claims. */
export function createEmailClassificationWorker(dependencies: EmailClassificationWorkerDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const resolveMailboxes = dependencies.resolveMailboxes ?? resolveAuthorizedEmailClassificationMailboxes;
  const ingest = dependencies.ingestMetadata ?? ingestEmailClassificationMetadata;
  const isCurrent = dependencies.isResultCurrent ?? isStoredEmailClassificationResultCurrent;
  const known = new Map<string, MailboxActor>();
  const active = new Map<string, AbortController>();
  const activeSync = new Set<AbortController>();
  const syncFailures = new Map<string, { attempts: number; until: number }>();
  let nextMailbox = 0;
  let circuitUntil = 0;
  let circuitProvider = '';
  let running: Promise<EmailClassificationCycleResult> | null = null;
  let stopped = false;
  let discoveredAt: number | null = null;
  const discoveryIntervalMs = dependencies.discoveryIntervalMs === 0 ? 0 : Math.max(60_000, dependencies.discoveryIntervalMs ?? 60_000);

  async function discover(store: EmailClassificationWorkerStore, force = false): Promise<Map<string, MailboxActor>> {
    if (!force && discoveredAt !== null && now() - discoveredAt < discoveryIntervalMs) return new Map(known);
    const actors = await (dependencies.listUserIds ?? listEmailClassificationDiscoveryUserIds)();
    const next = new Map<string, MailboxActor>();
    const failedActors = new Set<string>();
    for (const actorUserId of actors) {
      try {
        for (const mailbox of await resolveMailboxes(actorUserId)) {
          const previous = next.get(mailbox.mailboxRef);
          if (!previous || actorUserId === mailbox.ownerUserId) next.set(mailbox.mailboxRef, { mailbox, actorUserId });
        }
      } catch { failedActors.add(actorUserId); }
    }
    for (const [ref, source] of known) if (!next.has(ref) && failedActors.has(source.actorUserId)) next.set(ref, source);
    const persisted = store.listActiveMailboxes ? await store.listActiveMailboxes() : [];
    for (const mailbox of persisted) {
      if (next.has(mailbox.mailboxRef) || failedActors.has(mailbox.ownerUserId)) continue;
      // A failed membership/catalogue query is never evidence that a shared source disappeared.
      if (mailbox.workspaceId && failedActors.size) continue;
      await store.deactivateMailbox(mailbox.mailboxRef, now());
    }
    known.clear();
    for (const [ref, source] of next) { known.set(ref, source); if (!failedActors.has(source.actorUserId)) await store.upsertMailbox(source.mailbox, now()); }
    discoveredAt = now();
    return next;
  }

  async function freshSource(source: MailboxActor, expected: StoredEmailClassificationJob | null = null): Promise<MailboxActor> {
    const mailbox = (await resolveMailboxes(source.actorUserId)).find(candidate => candidate.mailboxRef === source.mailbox.mailboxRef);
    if (!mailbox || !mailbox.active || !mailbox.capabilities.canRead || mailbox.ownerUserId !== source.mailbox.ownerUserId
      || mailbox.accountId !== source.mailbox.accountId || mailbox.accountSource !== source.mailbox.accountSource
      || mailbox.workspaceId !== source.mailbox.workspaceId
      || mailbox.bindingRevision !== source.mailbox.bindingRevision || mailbox.policyRevision !== source.mailbox.policyRevision
      || expected && (mailbox.bindingRevision !== expected.bindingRevision || mailbox.policyRevision !== expected.policyRevision)) {
      throw new WorkerCancelled('source_changed');
    }
    return { actorUserId: source.actorUserId, mailbox };
  }

  async function syncMailbox(store: EmailClassificationWorkerStore, source: MailboxActor, result: EmailClassificationCycleResult): Promise<void> {
    const failure = syncFailures.get(source.mailbox.mailboxRef);
    if (failure && failure.until > now()) return;
    const stored = await store.readMailbox(source.mailbox.mailboxRef);
    if (!stored) return;
    const settings = await store.readSettings();
    const cursor = cursorFrom(stored.syncCursor);
    const evaluationFingerprint = settings.configuration.enabled ? emailClassificationEvaluationFingerprint(settings.configuration) : null;
    if (settings.configuration.enabled && cursor.evaluationFingerprint !== evaluationFingerprint) {
      cursor.phase = 'backfill'; cursor.offset = 0; cursor.historicalQueued = 0; cursor.complete = false; cursor.generationStartedAt = 0;
    }
    cursor.evaluationFingerprint = evaluationFingerprint;
    const headDue = now() - cursor.headCheckedAt >= settings.configuration.syncIntervalSeconds * 1000;
    if (cursor.phase !== 'backfill' && !headDue) return;
    if (cursor.phase !== 'backfill') {
      cursor.phase = 'backfill'; cursor.offset = 0; cursor.scanned = 0; cursor.historicalQueued = 0; cursor.complete = false; cursor.generationStartedAt = 0;
    }
    if (cursor.offset === 0 && cursor.generationStartedAt === 0) cursor.generationStartedAt = now();
    const syncClaim = await store.claimMailboxSync({ mailboxRef: source.mailbox.mailboxRef, leaseMs: 120_000, now: now() });
    if (!syncClaim) return;
    const controller = new AbortController();
    activeSync.add(controller);
    const rawTimer = setTimeout(() => controller.abort(new EmailMailboxSyncError('timeout')), dependencies.rawTimeoutMs ?? 60_000);
    const limit = source.mailbox.accountSource === 'managed' ? 25 : 50;
    let pages = 0;
    let coverage: StoredEmailClassificationMailbox['coverage'] = cursor.complete ? 'complete' : 'partial';
    let stage: 'provider' | 'content' | 'storage' = 'storage';
    try {
      source = await freshSource(source);
      if (source.mailbox.bindingRevision !== stored.bindingRevision || source.mailbox.policyRevision !== stored.policyRevision) throw new WorkerCancelled('source_changed');
      const loadPage = async (offset: number, head: boolean) => {
        stage = 'provider';
        const page = await withAbort((dependencies.listMessages ?? defaultList)({ ...source, offset, limit, signal: controller.signal }), controller.signal);
        stage = 'storage';
        pages++;
        const messages = page.messages.map(message => normalizedInboxMessage(message, page, source.mailbox));
        const refs = messages.flatMap(message => { const ref = messageRef(message, source.mailbox); return ref ? [ref] : []; });
        const existing = new Set((await store.readMessages(refs)).map(message => message.messageRef));
        const selected = evaluationFingerprint ? await store.readClassificationHistory(refs, evaluationFingerprint) : new Set<string>();
        let invalidIdentity = false;
        for (const message of messages) {
          controller.signal.throwIfAborted();
          stage = 'content';
          const metadata = await ingest({ mailbox: source.mailbox, message, enqueue: false, inInbox: true, inboxSeenAt: now(), settings, provenance: source.mailbox.provider === 'imap' ? 'imap' : 'provider', now: now() });
          stage = 'storage';
          if (!metadata) { invalidIdentity = true; continue; }
          result.indexed++;
          const latest = await store.readSettings();
          const incoming = head && cursor.headCheckedAt > 0 && !existing.has(metadata.messageRef);
          const previouslySelected = selected.has(metadata.messageRef);
          const withinHistoricalBudget = incoming || previouslySelected || cursor.historicalQueued < latest.configuration.maxHistoricalMessages;
          if (latest.configuration.enabled && emailClassificationEvaluationFingerprint(latest.configuration) === evaluationFingerprint
            && isEmailSelectedForClassification(metadata, latest.configuration.initialLookbackDays, now())
            && withinHistoricalBudget && canClassifyIndexedEmail(source.mailbox, metadata.list.from)) {
            const oldResult = (await store.readResultsBatch([metadata.messageRef]))[0];
            if (!isCurrent(oldResult ?? null, metadata, latest.configuration)) {
              const enqueued = await store.enqueueClassification({ messageRef: metadata.messageRef, fingerprint: metadata.fingerprint, configurationRevision: latest.revision, now: now() });
              if (enqueued) {
                if (!incoming && !previouslySelected) cursor.historicalQueued++;
                selected.add(metadata.messageRef);
              }
            }
          }
        }
        return { page, invalidIdentity };
      };
      if (headDue && cursor.offset > 0) {
        await loadPage(0, true);
        cursor.headCheckedAt = now();
      }
      while (pages < Math.max(1, Math.min(5, dependencies.maxPagesPerMailbox ?? 2))) {
        const requestedOffset = cursor.phase === 'backfill' ? Math.max(0, cursor.offset - (cursor.offset ? Math.min(10, limit - 1) : 0)) : 0;
        const { page, invalidIdentity } = await loadPage(requestedOffset, requestedOffset === 0);
        if (requestedOffset === 0) cursor.headCheckedAt = now();
        cursor.scanned = Math.max(cursor.scanned, requestedOffset + page.messages.length);
        if (!page.confirmed || invalidIdentity) { cursor.phase = 'blocked'; cursor.complete = false; coverage = 'partial'; break; }
        if (!page.hasMore) {
          cursor.complete = page.total !== null && Number.isSafeInteger(page.total) && page.total >= 0
            && requestedOffset + page.messages.length >= page.total;
          cursor.phase = cursor.complete ? 'head' : 'blocked';
          cursor.offset = 0;
          coverage = cursor.complete ? 'complete' : 'partial';
          break;
        }
        const continuation = page.nextOffset;
        if (continuation === null || !Number.isSafeInteger(continuation) || continuation <= requestedOffset
          || continuation <= cursor.offset && cursor.offset > 0) {
          cursor.phase = 'blocked'; cursor.complete = false; coverage = 'partial'; break;
        }
        cursor.offset = continuation;
        cursor.phase = 'backfill'; cursor.complete = false; coverage = 'partial';
      }
      await freshSource(source);
      const accepted = await store.recordMailboxSync({ mailboxRef: source.mailbox.mailboxRef, bindingRevision: stored.bindingRevision,
        policyRevision: stored.policyRevision, claimToken: syncClaim, cursor: JSON.stringify(cursor), coverage, now: now() });
      if (accepted) {
        if (cursor.complete) await store.reconcileMailboxInbox({ mailboxRef: source.mailbox.mailboxRef, bindingRevision: stored.bindingRevision,
          policyRevision: stored.policyRevision, claimToken: syncClaim, startedAt: cursor.generationStartedAt, now: now() });
        result.synced++;
      }
      syncFailures.delete(source.mailbox.mailboxRef);
    } catch (error) {
      const attempts = (failure?.attempts ?? 0) + 1;
      syncFailures.set(source.mailbox.mailboxRef, { attempts, until: now() + emailClassificationRetryDelay(attempts, dependencies.random) });
      const failureReason = controller.signal.aborted ? controller.signal.reason : error;
      if (!(failureReason instanceof WorkerCancelled)) await store.recordMailboxSync({ mailboxRef: source.mailbox.mailboxRef, bindingRevision: stored.bindingRevision,
        policyRevision: stored.policyRevision, claimToken: syncClaim, cursor: stored.syncCursor, coverage: 'failed', errorCode: emailMailboxSyncErrorCode(failureReason, stage), now: now() });
    } finally { clearTimeout(rawTimer); activeSync.delete(controller); await store.releaseMailboxSync({ mailboxRef: source.mailbox.mailboxRef, claimToken: syncClaim }); }
  }

  async function runJob(store: EmailClassificationWorkerStore, job: StoredEmailClassificationJob, initialSource: MailboxActor | undefined, result: EmailClassificationCycleResult): Promise<void> {
    if (!job.claimToken) return;
    const controller = new AbortController();
    active.set(job.id, controller);
    const leaseMs = Math.min(600_000, Math.max(60_000, (await store.readSettings()).configuration.timeoutMs + (dependencies.rawTimeoutMs ?? 60_000) + 30_000));
    let guarding = false;
    let guardFailure: unknown;
    let source = initialSource;
    let metadata: StoredEmailClassificationMetadata | undefined;
    const check = async (): Promise<EmailClassificationConfiguration> => {
      controller.signal.throwIfAborted();
      const settings = await store.readSettings();
      const claim = await store.readJob(job.id);
      const currentMetadata = (await store.readMessages([job.messageRef]))[0];
      if (!settings.configuration.enabled || settings.revision !== job.configurationRevision
        || !claim || claim.status !== 'processing' || claim.claimToken !== job.claimToken || claim.leaseUntil === null || claim.leaseUntil <= now()
        || !currentMetadata || !currentMetadata.inInbox || currentMetadata.fingerprint !== job.fingerprint || currentMetadata.mailbox.bindingRevision !== job.bindingRevision
        || currentMetadata.mailbox.policyRevision !== job.policyRevision) throw new WorkerCancelled('stale_claim');
      metadata = currentMetadata;
      if (!isEmailSelectedForClassification(metadata, settings.configuration.initialLookbackDays, now())) throw new WorkerCancelled('not_selected');
      if (!source) throw new WorkerCancelled('source_unavailable');
      source = await freshSource(source, job);
      if (!canClassifyIndexedEmail(source.mailbox, metadata.list.from)) throw new WorkerCancelled('sender_policy');
      const execution = await resolveEmailClassificationExecution(settings.configuration, dependencies);
      if (!execution.ready) {
        if (execution.mode === 'managed') throw new ManagedDecisionClientError(execution.catalog?.code ?? 'missing_configuration', { retryable: true });
        throw new WorkerCancelled('credential_unavailable');
      }
      if (execution.mode === 'managed' && execution.managedModel?.inferenceRevision !== settings.configuration.managedModel?.inferenceRevision) throw new WorkerCancelled('managed_model_changed');
      return settings.configuration;
    };
    const interval = setInterval(() => {
      if (guarding || controller.signal.aborted) return;
      guarding = true;
      void check().then(() => store.renewClaim({ jobId: job.id, claimToken: job.claimToken!, leaseMs, now: now() })).then(renewed => {
        if (!renewed) throw new WorkerCancelled('stale_claim');
      }).catch(error => { guardFailure = error; controller.abort(error); }).finally(() => { guarding = false; });
    }, Math.max(5, Math.min(1_000, dependencies.claimCheckIntervalMs ?? 1_000)));
    try {
      const configuration = await check();
      if (!source || !metadata) throw new WorkerCancelled('source_unavailable');
      const previous = (await store.readResultsBatch([job.messageRef]))[0];
      if (isCurrent(previous ?? null, metadata, configuration) && previous?.raw) {
        await check();
        if (await store.completeJob({ jobId: job.id, claimToken: job.claimToken, raw: previous.raw, now: now() })) { result.completed++; result.reused++; }
        else result.canceled++;
        return;
      }
      const rawTimer = setTimeout(() => controller.abort(new DecisionModelError('timeout', { retryable: true })), dependencies.rawTimeoutMs ?? 60_000);
      let raw: Record<string, unknown>;
      try { raw = await withAbort((dependencies.readMessage ?? defaultRead)({ ...source, message: metadata, signal: controller.signal }), controller.signal); }
      finally { clearTimeout(rawTimer); }
      await check();
      if (!source || !metadata || !canClassifyIndexedEmail(source.mailbox, String(raw.from ?? metadata.list.from))) throw new WorkerCancelled('sender_policy');
      const identity = emailClassificationMessageIdentity(source.mailbox, { ...raw, id: String(raw.id ?? metadata.canonicalId), folder: String(raw.folder ?? metadata.folder) });
      if (identity.messageRef !== job.messageRef) throw new WorkerCancelled('message_changed');
      // Provider flags can be newer than the index (e.g. another mail client read an old mail).
      const observedDate = typeof raw.date === 'string' ? Date.parse(raw.date) : metadata.dateTimestamp;
      if (!isEmailSelectedForClassification({ inInbox: metadata.inInbox,
        dateTimestamp: observedDate !== null && Number.isSafeInteger(observedDate) ? observedDate : null,
        list: { isRead: typeof raw.isRead === 'boolean' ? raw.isRead : metadata.list.isRead } }, configuration.initialLookbackDays, now())) {
        throw new WorkerCancelled('not_selected');
      }
      const originalBody = typeof raw.body === 'string' && raw.body.trim() ? raw.body : typeof raw.bodyHtml === 'string' ? raw.bodyHtml : '';
      const boundedBody = originalBody.slice(0, 64_000);
      const body = isLikelyHtmlEmailContent(boundedBody) || !raw.body ? htmlToPlainText(boundedBody) : boundedBody;
      const state = buildEmailDecisionState({ from: String(raw.from ?? metadata.list.from),
        to: Array.isArray(raw.to) ? raw.to.map(String) : metadata.list.to ?? [], subject: String(raw.subject ?? metadata.list.subject), body,
        mailboxScope: source.mailbox.workspaceId ? 'workspace' : 'personal' }, configuration.questionProfile);
      const current = await check();
      const execution = await resolveEmailClassificationExecution(current, dependencies);
      const decision = await withAbort(executeEmailClassification(current, { state: state.state, questions: buildEmailClassificationQuestions(current.questionProfile),
        schemaVersion: EMAIL_CLASSIFICATION_SCHEMA_VERSION, signal: controller.signal }, execution, job.decisionRequestId ?? job.id, dependencies), controller.signal);
      await check();
      const normalized = normalizeEmailClassificationResult(decision, { evaluatedBodyCharacters: state.evaluatedBodyCharacters,
        bodyWasTruncated: state.bodyWasTruncated || originalBody.length > 64_000, evaluatedAt: now() });
      if (await store.completeJob({ jobId: job.id, claimToken: job.claimToken, raw: normalized, now: now() })) result.completed++;
      else result.canceled++;
    } catch (caught) {
      const error = guardFailure ?? (controller.signal.aborted ? controller.signal.reason : caught);
      if (error instanceof WorkerCancelled) {
        await store.cancelClaim({ jobId: job.id, claimToken: job.claimToken, errorCode: error.code, now: now() }); result.canceled++;
      } else {
        const code = error instanceof ManagedDecisionClientError ? error.managedCode : error instanceof DecisionModelError ? error.code : 'source_error';
        const managedPaused = error instanceof ManagedDecisionClientError && ['missing_connection', 'missing_configuration', 'authentication_failed', 'scope_denied', 'entitlement_denied', 'budget_exhausted', 'model_changed', 'in_progress', 'provider_unavailable', 'rate_limited'].includes(error.managedCode);
        const terminal = !managedPaused && (job.attempts >= Math.max(1, dependencies.maxAttempts ?? 5)
          || error instanceof DecisionModelError && !error.retryable && !['aborted', 'authentication_failed'].includes(error.code));
        const delay = emailClassificationRetryDelay(job.attempts, dependencies.random, error instanceof DecisionModelError ? error.retryAfterMs : undefined);
        if (error instanceof DecisionModelError && ['rate_limited', 'authentication_failed', 'provider_error', 'timeout'].includes(error.code)) circuitUntil = Math.max(circuitUntil, now() + delay);
        if (await store.retryJob({ jobId: job.id, claimToken: job.claimToken, errorCode: code, nextAttemptAt: now() + delay, terminal, ...(error instanceof ManagedDecisionClientError && error.canReissue && !terminal ? { decisionRequestId: randomUUID() } : {}), now: now() })) {
          if (terminal) result.failed++; else result.retried++;
        } else result.canceled++;
      }
    } finally { clearInterval(interval); active.delete(job.id); }
  }

  async function cycle(): Promise<EmailClassificationCycleResult> {
    const result: EmailClassificationCycleResult = { discovered: 0, synced: 0, indexed: 0, claimed: 0, completed: 0, reused: 0, retried: 0, failed: 0, canceled: 0 };
    if (stopped) return result;
    const store = await (dependencies.getStore ?? getRuntimeEmailClassificationStore)();
    const initialSettings = await store.readSettings();
    if (initialSettings.configuration.enabled && initialSettings.configuration.executionMode === 'managed') {
      await reconcileEmailClassificationExecution(store, initialSettings, await resolveEmailClassificationExecution(initialSettings.configuration, dependencies));
    }
    let sources = await discover(store);
    result.discovered = sources.size;
    const entries = [...sources.values()];
    const maximum = Math.min(entries.length, Math.max(1, dependencies.maxMailboxesPerCycle ?? 10));
    for (let index = 0; index < maximum && !stopped; index++) await syncMailbox(store, entries[(nextMailbox + index) % entries.length], result);
    if (entries.length) nextMailbox = (nextMailbox + maximum) % entries.length;
    const settings = await store.readSettings();
    if (stopped || !settings.configuration.enabled) return result;
    const execution = await resolveEmailClassificationExecution(settings.configuration, dependencies);
    const providerKey = emailClassificationEvaluationFingerprint(settings.configuration);
    if (providerKey !== circuitProvider) { circuitProvider = providerKey; circuitUntil = 0; }
    if (stopped || !settings.configuration.enabled || !execution.ready || circuitUntil > now()) return result;
    const leaseMs = Math.min(600_000, Math.max(60_000, settings.configuration.timeoutMs + (dependencies.rawTimeoutMs ?? 60_000) + 30_000));
    const jobs = await store.claimJobs({ limit: settings.configuration.concurrency, leaseMs, now: now() });
    result.claimed = jobs.length;
    // Foreground ingestion may enqueue a newly authorized source before the bounded
    // discovery pass. Refresh once before treating that source as unavailable.
    if (jobs.some(job => !sources.has(job.mailboxRef))) sources = await discover(store, true);
    await Promise.all(jobs.map(job => runJob(store, job, sources.get(job.mailboxRef), result)));
    return result;
  }

  return {
    runCycle(): Promise<EmailClassificationCycleResult> {
      if (!running) running = cycle().finally(() => { running = null; });
      return running;
    },
    invalidateDiscovery(): void { discoveredAt = null; },
    cancelActive(): void { discoveredAt = null; for (const controller of active.values()) controller.abort(new WorkerCancelled('settings_changed')); },
    stop(): void { stopped = true; for (const controller of active.values()) controller.abort(new WorkerCancelled('stopped')); for (const controller of activeSync) controller.abort(new WorkerCancelled('stopped')); },
  };
}

export async function runEmailClassificationCycle(dependencies: EmailClassificationWorkerDependencies = {}): Promise<EmailClassificationCycleResult> {
  return createEmailClassificationWorker(dependencies).runCycle();
}
