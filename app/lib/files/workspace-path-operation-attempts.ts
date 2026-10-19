'use client';

import { openedDocumentAuthScope, type OpenedDocumentAuthScope } from '../collaboration/opened-document-registry';
import type { WorkspacePathOperationPublic } from './workspace-path-operation-public';
import { readWorkspacePathOperation } from './workspace-path-operation-parser';

export type WorkspacePathOperationAttempt = Readonly<{ operationId: string; planId?: string; authScope: OpenedDocumentAuthScope }>;
type Entry = { key: string; userId: string; workspaceId: string; kind: 'rename' | 'delete'; selections: string;
  operationId: string; planId?: string; locals: number; outstanding: number; unknown: boolean; resolved: boolean;
  pin?: { batchId: string; planId: string } };
type Ticket = { entry: Entry; state: 'local' | 'dispatched' | 'unknown' | 'closed' };
const attempts = new Map<string, Entry>();
const tickets = new WeakMap<WorkspacePathOperationAttempt, Ticket>();

/** Reserve before the first await. A local ticket cannot replace the shared request entry. */
export function reserveWorkspacePathOperationAttempt(input: { workspaceId: string | null;
  kind: 'rename' | 'delete'; selections: readonly { sourcePath: string; destinationPath?: string }[];
  overwrite?: boolean; planId?: string }): WorkspacePathOperationAttempt {
  const authScope = openedDocumentAuthScope();
  if (!authScope || !input.workspaceId) throw new Error('Wait for the signed-in workspace before requesting a file action.');
  const selections = JSON.stringify(input.selections.map(({ sourcePath, destinationPath }) => ({ sourcePath,
    ...(destinationPath === undefined ? {} : { destinationPath }) })));
  const key = JSON.stringify([authScope.userId, input.workspaceId, input.kind, selections, Boolean(input.overwrite)]);
  let entry = attempts.get(key);
  if (entry && input.planId !== undefined && entry.planId !== input.planId) {
    if (entry.planId === undefined && !entry.outstanding && !entry.unknown) entry.planId = input.planId;
    else throw new Error('This file action has an unresolved attempt. Check Notification Center before starting another one.');
  }
  if (!entry) {
    if (attempts.size >= 16) throw new Error('Check the pending file actions in Notification Center before starting another one.');
    entry = { key, userId: authScope.userId, workspaceId: input.workspaceId, kind: input.kind, selections,
      operationId: crypto.randomUUID(), ...(input.planId === undefined ? {} : { planId: input.planId }),
      locals: 0, outstanding: 0, unknown: false, resolved: false };
    attempts.set(key, entry);
  }
  entry.locals++;
  const shared = entry;
  const attempt = Object.freeze({ operationId: entry.operationId, get planId() { return shared.planId; }, authScope });
  tickets.set(attempt, { entry, state: 'local' });
  return attempt;
}

/** Only a still-local attempt may bind its first actual preview. All tickets see the same plan. */
export function bindWorkspacePathOperationAttemptPreview(attempt: WorkspacePathOperationAttempt, planId: string): void {
  const ticket = tickets.get(attempt), entry = ticket?.entry;
  if (!ticket || ticket.state !== 'local' || !entry || entry.resolved || attempts.get(entry.key) !== entry
    || openedDocumentAuthScope() !== attempt.authScope || !/^[a-f0-9]{64}$/u.test(planId)
    || entry.planId !== planId && (entry.planId !== undefined || entry.outstanding > 0 || entry.unknown)) {
    throw new Error('The file action preview changed. Check Notification Center before requesting another action.');
  }
  entry.planId = planId;
}

/** A local flush/cancel cannot release another ticket's dispatch or unknown outcome. */
export function abandonWorkspacePathOperationAttempt(attempt: WorkspacePathOperationAttempt): void {
  const ticket = tickets.get(attempt);
  if (!ticket || ticket.state !== 'local') return;
  ticket.state = 'closed'; ticket.entry.locals--;
  const entry = ticket.entry;
  if (!entry.locals && !entry.outstanding && !entry.unknown && attempts.get(entry.key) === entry) attempts.delete(entry.key);
}

/** Call synchronously immediately before fetch, after serialization and all local guards. */
export function dispatchWorkspacePathOperationAttempt(attempt: WorkspacePathOperationAttempt): void {
  const ticket = tickets.get(attempt);
  if (!ticket || ticket.state !== 'local' || ticket.entry.resolved || attempts.get(ticket.entry.key) !== ticket.entry
    || openedDocumentAuthScope() !== attempt.authScope) throw new Error('The file action or signed-in session changed. Please retry.');
  ticket.state = 'dispatched'; ticket.entry.locals--; ticket.entry.outstanding++;
}

/** Only this dispatch is settled. Unknown is sticky until the original completion is verified. */
export function settleWorkspacePathOperationAttempt(attempt: WorkspacePathOperationAttempt, outcome: 'unknown' | 'rejected'): void {
  const ticket = tickets.get(attempt);
  if (!ticket || ticket.state !== 'dispatched' || ticket.entry.resolved) return;
  ticket.entry.outstanding--; ticket.state = outcome === 'unknown' ? 'unknown' : 'closed';
  if (outcome === 'unknown') ticket.entry.unknown = true;
  const entry = ticket.entry;
  if (!entry.locals && !entry.outstanding && !entry.unknown && attempts.get(entry.key) === entry) attempts.delete(entry.key);
}

/** Bind the strictly validated initial response to its account/workspace/request. */
export function bindWorkspacePathOperationAttempt(attempt: WorkspacePathOperationAttempt, supplied: WorkspacePathOperationPublic): void {
  const ticket = tickets.get(attempt);
  if (!ticket || ticket.entry.resolved || !['dispatched', 'unknown'].includes(ticket.state)) throw new Error('Invalid file action attempt.');
  const entry = ticket.entry, operation = readWorkspacePathOperation(supplied,
    { workspaceId: entry.workspaceId, planId: entry.planId, allowPreparation: true });
  if (operation.kind !== entry.kind || JSON.stringify(operation.selections) !== entry.selections
    || entry.pin && (entry.pin.batchId !== operation.batchId || entry.pin.planId !== operation.planId)) {
    throw new Error('The original file action identity changed.');
  }
  entry.pin = { batchId: operation.batchId, planId: operation.planId };
}

/** Called only after existing authenticated status/response validation. This
 * grants no rights and never sends, retries, resumes or cancels a mutation. */
export function observeWorkspacePathOperationAttemptCompletion(supplied: WorkspacePathOperationPublic): void {
  const operation = readWorkspacePathOperation(supplied), current = openedDocumentAuthScope();
  if (!current || operation.status !== 'applied' || operation.phase !== 'complete'
    || operation.completedActions !== operation.totalActions) return;
  for (const [key, entry] of attempts) {
    if (entry.userId !== current.userId || entry.workspaceId !== operation.workspaceId || entry.kind !== operation.kind
      || entry.selections !== JSON.stringify(operation.selections) || !entry.pin
      || entry.pin.batchId !== operation.batchId || entry.pin.planId !== operation.planId) continue;
    entry.resolved = true;
    attempts.delete(key);
  }
}
