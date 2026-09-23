'use client';

import { create } from 'zustand';
import { plainTextToEmailHtml } from '@/app/lib/email/html-conversion';
import { sanitizeEmailEditorHtml } from '@/app/lib/email/html-editor-content';
import {
  decideEmailReview, emailReviewKey, emailReviewTarget, EmailReviewClientError, isPendingEmailReview,
  loadEmailReview, loadEmailReviewQueue, matchesEmailReviewFilter, saveEmailReview,
  type EmailReviewEntry, type EmailReviewFilter, type EmailReviewForm, type EmailReviewTarget,
} from '@/app/lib/email/review-client';

type Navigation = { kind: 'close' | 'refresh' | 'postpone' } | { kind: 'select' | 'open'; target?: EmailReviewTarget; filter?: EmailReviewFilter } | { kind: 'filter'; filter: EmailReviewFilter };
type State = {
  open: boolean; queue: EmailReviewEntry[]; activeEntry: EmailReviewEntry | null; form: EmailReviewForm;
  dirty: boolean; loading: boolean; busy: boolean; error: string | null; loadingWarnings: string[];
  filter: EmailReviewFilter; completed: boolean; needsReload: boolean; pendingNavigation: Navigation | null;
};
const emptyForm: EmailReviewForm = { toText: '', ccText: '', bccText: '', subject: '', bodyHtml: '' };
export const useEmailReviewStore = create<State>(() => ({
  open: false, queue: [], activeEntry: null, form: emptyForm, dirty: false, loading: false, busy: false,
  error: null, loadingWarnings: [], filter: 'all', completed: false, needsReload: false, pendingNavigation: null,
}));
let generation = 0;
const message = (error: unknown) => error instanceof Error ? error.message : 'Unable to update email review.';
function formFor(entry: EmailReviewEntry): EmailReviewForm {
  return { toText: entry.to.join(', '), ccText: entry.cc.join(', '), bccText: entry.bcc.join(', '), subject: entry.subject,
    bodyHtml: entry.isHtml ? sanitizeEmailEditorHtml(entry.body) : plainTextToEmailHtml(entry.body) };
}
function emitUpdated() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('email_review_updated'));
  window.dispatchEvent(new CustomEvent('notification_summary_updated'));
}
function guardNavigation(navigation: Navigation) {
  const state = useEmailReviewStore.getState();
  if (state.busy) return false;
  if (state.dirty) { useEmailReviewStore.setState({ pendingNavigation: navigation }); return false; }
  return true;
}
function setActive(entry: EmailReviewEntry | null) {
  useEmailReviewStore.setState({ activeEntry: entry, form: entry ? formFor(entry) : emptyForm, dirty: false, loading: false, needsReload: false });
}
function handleAuthFailure(error: unknown) {
  if (!(error instanceof EmailReviewClientError) || error.status !== 401) return false;
  generation += 1;
  useEmailReviewStore.setState({ queue: [], activeEntry: null, form: emptyForm, dirty: false, loading: false, busy: false, error: message(error) });
  return true;
}
async function loadQueue(target?: EmailReviewTarget) {
  const currentGeneration = ++generation;
  useEmailReviewStore.setState({ loading: true, error: null, completed: false });
  try {
    const result = await loadEmailReviewQueue();
    if (currentGeneration !== generation) return false;
    const state = useEmailReviewStore.getState();
    const selected = target ? result.queue.find((entry) => emailReviewKey(entry) === emailReviewKey(target)) : result.queue.find((entry) => matchesEmailReviewFilter(entry, state.filter));
    useEmailReviewStore.setState({ queue: result.queue, loadingWarnings: result.warnings, completed: !result.queue.length && !result.warnings.length });
    if (selected) {
      const fresh = await loadEmailReview(emailReviewTarget(selected), selected);
      if (currentGeneration !== generation) return false;
      if (isPendingEmailReview(fresh)) setActive(fresh);
      else { emitUpdated(); await advanceAfterDecision(fresh); }
    } else {
      setActive(null);
      if (target) useEmailReviewStore.setState({ error: 'This email is no longer awaiting review or its outbox could not be loaded.' });
    }
    return true;
  } catch (error) {
    if (currentGeneration !== generation) return false;
    if (!handleAuthFailure(error)) useEmailReviewStore.setState({ loading: false, error: message(error) });
    return false;
  }
}
export async function openEmailReview(target?: EmailReviewTarget, options?: { filter?: EmailReviewFilter }) {
  if (!guardNavigation({ kind: 'open', target, filter: options?.filter })) return false;
  useEmailReviewStore.setState({ open: true, filter: options?.filter || 'all', activeEntry: null, form: emptyForm });
  return loadQueue(target);
}
export async function selectEmailReview(target: EmailReviewTarget) {
  const state = useEmailReviewStore.getState();
  if (!state.loading && state.activeEntry && emailReviewKey(state.activeEntry) === emailReviewKey(target)) return true;
  if (!guardNavigation({ kind: 'select', target })) return false;
  const context = state.queue.find((entry) => emailReviewKey(entry) === emailReviewKey(target));
  if (!context) return false;
  const currentGeneration = ++generation;
  useEmailReviewStore.setState({ loading: true, error: null });
  try {
    const entry = await loadEmailReview(target, context);
    if (currentGeneration !== generation) return false;
    if (isPendingEmailReview(entry)) setActive(entry);
    else { emitUpdated(); await advanceAfterDecision(entry); }
    return true;
  } catch (error) {
    if (currentGeneration === generation && !handleAuthFailure(error)) useEmailReviewStore.setState({ loading: false, error: message(error) });
    return false;
  }
}
export function updateEmailReviewForm(patch: Partial<EmailReviewForm>) {
  const state = useEmailReviewStore.getState();
  if (!state.activeEntry?.canWrite || state.busy || state.loading || ['sending', 'send_uncertain'].includes(state.activeEntry.status || '')) return;
  const form = { ...state.form, ...patch };
  useEmailReviewStore.setState({ form, dirty: JSON.stringify(form) !== JSON.stringify(formFor(state.activeEntry)) });
}
export function closeEmailReview() {
  if (!guardNavigation({ kind: 'close' })) return false;
  generation += 1;
  useEmailReviewStore.setState({ open: false, activeEntry: null, form: emptyForm, loading: false, dirty: false, pendingNavigation: null });
  return true;
}
export async function refreshEmailReview() {
  if (!guardNavigation({ kind: 'refresh' })) return false;
  const entry = useEmailReviewStore.getState().activeEntry;
  return loadQueue(entry ? emailReviewTarget(entry) : undefined);
}
export function setEmailReviewFilter(filter: EmailReviewFilter) {
  if (useEmailReviewStore.getState().loading) return false;
  if (!guardNavigation({ kind: 'filter', filter })) return false;
  useEmailReviewStore.setState({ filter });
  const state = useEmailReviewStore.getState();
  if (state.activeEntry && matchesEmailReviewFilter(state.activeEntry, filter)) return true;
  const next = state.queue.find((entry) => matchesEmailReviewFilter(entry, filter));
  if (next) void selectEmailReview(emailReviewTarget(next));
  else setActive(null);
  return true;
}
export async function postponeActiveEmailReview() {
  if (!guardNavigation({ kind: 'postpone' })) return false;
  const state = useEmailReviewStore.getState();
  const visible = state.queue.filter((entry) => matchesEmailReviewFilter(entry, state.filter));
  const index = visible.findIndex((entry) => state.activeEntry && emailReviewKey(entry) === emailReviewKey(state.activeEntry));
  if (visible.length < 2) return closeEmailReview();
  return selectEmailReview(emailReviewTarget(visible[(index + 1) % visible.length]));
}
export function cancelEmailReviewNavigation() { useEmailReviewStore.setState({ pendingNavigation: null }); }
export async function confirmDiscardEmailReviewNavigation() {
  const state = useEmailReviewStore.getState();
  if (!state.pendingNavigation || state.busy) return false;
  const pending = state.pendingNavigation;
  useEmailReviewStore.setState({ pendingNavigation: null, dirty: false });
  if (state.activeEntry) useEmailReviewStore.setState({ form: formFor(state.activeEntry) });
  switch (pending.kind) {
    case 'close': return closeEmailReview();
    case 'refresh': return refreshEmailReview();
    case 'postpone': return postponeActiveEmailReview();
    case 'filter': return setEmailReviewFilter(pending.filter);
    case 'open': return openEmailReview(pending.target, { filter: pending.filter });
    case 'select': return pending.target ? selectEmailReview(pending.target) : false;
  }
}
function replaceEntry(entry: EmailReviewEntry) {
  const state = useEmailReviewStore.getState();
  useEmailReviewStore.setState({ queue: state.queue.map((item) => emailReviewKey(item) === emailReviewKey(entry) ? entry : item) });
}
function canMutate() {
  const state = useEmailReviewStore.getState();
  return !state.busy && !state.loading && !state.needsReload && Boolean(state.activeEntry?.canWrite) && !['sent', 'discarded', 'sending', 'send_uncertain'].includes(state.activeEntry?.status || '');
}
async function advanceAfterDecision(entry: EmailReviewEntry) {
  const state = useEmailReviewStore.getState();
  const oldIndex = state.queue.findIndex((item) => emailReviewKey(item) === emailReviewKey(entry));
  const queue = state.queue.filter((item) => emailReviewKey(item) !== emailReviewKey(entry));
  const visible = queue.filter((item) => matchesEmailReviewFilter(item, state.filter));
  useEmailReviewStore.setState({ queue, busy: false, loading: false, needsReload: false, dirty: false, activeEntry: null, form: emptyForm, completed: !queue.length && !state.loadingWarnings.length });
  if (visible.length) await selectEmailReview(emailReviewTarget(visible[Math.min(Math.max(oldIndex, 0), visible.length - 1)]));
}
export async function saveActiveEmailReview() {
  if (!canMutate()) return false;
  const state = useEmailReviewStore.getState();
  if (!state.activeEntry || !state.dirty) return true;
  useEmailReviewStore.setState({ busy: true, error: null });
  try {
    const entry = await saveEmailReview(state.activeEntry, state.form);
    replaceEntry(entry); setActive(entry); emitUpdated();
    return true;
  } catch (error) {
    if (!handleAuthFailure(error)) useEmailReviewStore.setState({ error: message(error) });
    return false;
  } finally { useEmailReviewStore.setState({ busy: false }); }
}
export async function sendActiveEmailReview() {
  if (!canMutate()) return false;
  let state = useEmailReviewStore.getState();
  if (!state.activeEntry) return false;
  useEmailReviewStore.setState({ busy: true, error: null });
  let entry = state.activeEntry;
  let dispatchStarted = false;
  try {
    if (state.dirty) {
      entry = await saveEmailReview(entry, state.form);
      replaceEntry(entry); setActive(entry); emitUpdated();
    }
    state = useEmailReviewStore.getState();
    dispatchStarted = true;
    await decideEmailReview(entry, 'send');
    emitUpdated();
    await advanceAfterDecision(entry);
    return true;
  } catch (error) {
    if (handleAuthFailure(error)) return false;
    if (dispatchStarted && error instanceof EmailReviewClientError && error.status === 409 && !error.code?.startsWith('SEND_')) {
      // Keep the old expectedVersion with the user's text until explicit discard/reload.
      useEmailReviewStore.setState({ activeEntry: entry, form: state.form, dirty: true });
    } else if (dispatchStarted) {
      // A lost HTTP response can hide a completed send. Always reconcile before retry.
      try {
        const fresh = await loadEmailReview(emailReviewTarget(entry), entry);
        emitUpdated();
        if (!isPendingEmailReview(fresh)) { await advanceAfterDecision(fresh); return true; }
        replaceEntry(fresh); setActive(fresh);
      } catch (reloadError) {
        if (handleAuthFailure(reloadError)) return false;
        useEmailReviewStore.setState({ needsReload: true, error: `${message(error)} Reload this email before taking another action; its delivery state could not be confirmed.` });
        return false;
      }
    }
    useEmailReviewStore.setState({ error: message(error) });
    return false;
  } finally { useEmailReviewStore.setState({ busy: false }); }
}
export async function rejectActiveEmailReview() {
  if (!canMutate()) return false;
  const state = useEmailReviewStore.getState();
  const entry = state.activeEntry;
  if (!entry) return false;
  useEmailReviewStore.setState({ busy: true, error: null });
  try {
    await decideEmailReview(entry, 'reject'); emitUpdated(); await advanceAfterDecision(entry); return true;
  } catch (error) {
    if (handleAuthFailure(error)) return false;
    if (!(error instanceof EmailReviewClientError && error.status === 409)) {
      try {
        const fresh = await loadEmailReview(emailReviewTarget(entry), entry);
        if (!isPendingEmailReview(fresh)) { emitUpdated(); await advanceAfterDecision(fresh); return true; }
        // Never rebase an unsaved form onto somebody else's new version.
        if (!state.dirty) { replaceEntry(fresh); setActive(fresh); }
      } catch (reloadError) {
        if (handleAuthFailure(reloadError)) return false;
        useEmailReviewStore.setState({ needsReload: true });
      }
    }
    useEmailReviewStore.setState({ error: message(error) });
    return false;
  } finally { useEmailReviewStore.setState({ busy: false }); }
}
export async function rejectEmailReviewTarget(target: EmailReviewTarget) {
  const state = useEmailReviewStore.getState();
  if (state.busy || state.loading) throw new Error('An email review operation is already in progress.');
  if (state.dirty && state.activeEntry && emailReviewKey(state.activeEntry) === emailReviewKey(target)) throw new Error('This email has unsaved edits. Open the review to save or discard them first.');
  useEmailReviewStore.setState({ busy: true });
  let entry: EmailReviewEntry | null = null;
  try {
    entry = await loadEmailReview(target, state.queue.find((item) => emailReviewKey(item) === emailReviewKey(target)));
    if (isPendingEmailReview(entry)) await decideEmailReview(entry, 'reject');
  } catch (error) {
    if (handleAuthFailure(error)) throw error;
    if (!entry || (error instanceof EmailReviewClientError && error.status === 409)) {
      useEmailReviewStore.setState({ busy: false });
      throw error;
    }
    try {
      const fresh = await loadEmailReview(target, entry);
      if (isPendingEmailReview(fresh)) throw error;
      entry = fresh;
    } catch (reloadError) {
      handleAuthFailure(reloadError);
      useEmailReviewStore.setState({ busy: false });
      throw error;
    }
  }
  try {
    emitUpdated();
    if (entry && state.activeEntry && emailReviewKey(state.activeEntry) === emailReviewKey(target)) await advanceAfterDecision(entry);
    else useEmailReviewStore.setState({ queue: useEmailReviewStore.getState().queue.filter((item) => emailReviewKey(item) !== emailReviewKey(target)) });
    return true;
  } finally { useEmailReviewStore.setState({ busy: false }); }
}
