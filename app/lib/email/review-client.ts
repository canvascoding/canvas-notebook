'use client';

import type { EmailOutboxDraft } from '@/app/apps/email/components/email-client-types';
import { sanitizeEmailEditorHtml } from '@/app/lib/email/html-editor-content';

export type EmailReviewTarget = { scope: 'personal' | 'workspace'; workspaceId?: string; draftId: string };
export type EmailReviewEntry = EmailOutboxDraft & {
  scope: 'personal' | 'workspace'; workspaceId?: string; workspaceName?: string; canWrite: boolean;
  errorCode?: string | null; errorMessage?: string | null; failedAt?: string | null; policySettingsUrl?: string;
};
export type EmailReviewForm = { toText: string; ccText: string; bccText: string; subject: string; bodyHtml: string };
export type EmailReviewFilter = 'all' | 'failed';
const pendingStatuses = new Set(['prepared', 'awaiting_review', 'editing', 'send_failed', 'send_uncertain', 'sending']);

export class EmailReviewClientError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly draft?: EmailOutboxDraft) {
    super(message);
    this.name = 'EmailReviewClientError';
  }
}

export function emailReviewTarget(entry: EmailReviewEntry): EmailReviewTarget {
  return { scope: entry.scope, workspaceId: entry.workspaceId, draftId: entry.id };
}
export function emailReviewKey(target: EmailReviewTarget | EmailReviewEntry) {
  return `${target.scope}:${target.workspaceId || ''}:${'draftId' in target ? target.draftId : target.id}`;
}
export function isPendingEmailReview(entry: EmailOutboxDraft) { return pendingStatuses.has(entry.status || ''); }
export function matchesEmailReviewFilter(entry: EmailOutboxDraft, filter: EmailReviewFilter) {
  return filter === 'all' || entry.status === 'send_failed' || entry.status === 'send_uncertain';
}
function endpoint(target: EmailReviewTarget) {
  if (target.scope === 'workspace' && !target.workspaceId) throw new Error('A workspace is required for this email review.');
  const base = target.scope === 'workspace' ? `/api/workspaces/${encodeURIComponent(target.workspaceId!)}/email/outbox` : '/api/email/outbox';
  return `${base}/${encodeURIComponent(target.draftId)}`;
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) {
    throw new EmailReviewClientError(typeof payload.error === 'string' ? payload.error : 'Unable to load or update email review.', response.status, payload.code, payload.data);
  }
  return payload as T;
}
function contextualize(draft: EmailOutboxDraft, context: Pick<EmailReviewEntry, 'scope' | 'workspaceId' | 'workspaceName' | 'canWrite'> & { senderAddress?: string | null }): EmailReviewEntry {
  // Scope and permissions come from the authorized listing, never a draft payload.
  return { ...draft, senderAddress: draft.senderAddress ?? context.senderAddress ?? null, scope: context.scope, workspaceId: context.workspaceId, workspaceName: context.workspaceName, canWrite: context.canWrite };
}

export async function loadEmailReviewQueue(): Promise<{ queue: EmailReviewEntry[]; warnings: string[] }> {
  const queue: EmailReviewEntry[] = [];
  const warnings: string[] = [];
  const [personal, workspaces] = await Promise.allSettled([
    request<{ data: EmailOutboxDraft[] }>('/api/email/outbox'),
    request<{ workspaces: Array<{ id: string; name: string; permissions?: { canRead?: boolean; canWrite?: boolean } }> }>('/api/workspaces'),
  ]);
  for (const result of [personal, workspaces]) {
    if (result.status === 'rejected' && result.reason instanceof EmailReviewClientError && result.reason.status === 401) throw result.reason;
  }
  if (personal.status === 'fulfilled' && Array.isArray(personal.value.data)) {
    queue.push(...personal.value.data.map((draft) => contextualize(draft, { scope: 'personal', canWrite: true })));
  } else warnings.push(`Personal outbox: ${personal.status === 'rejected' && personal.reason instanceof Error ? personal.reason.message : 'Invalid outbox response.'}`);
  if (workspaces.status === 'fulfilled' && Array.isArray(workspaces.value.workspaces)) {
    const readable = workspaces.value.workspaces.filter((workspace) => workspace.permissions?.canRead !== false);
    const results = await Promise.allSettled(readable.map((workspace) => request<{ data: EmailOutboxDraft[] }>(`/api/workspaces/${encodeURIComponent(workspace.id)}/email/outbox`)));
    results.forEach((result, index) => {
      const workspace = readable[index];
      if (result.status === 'rejected' && result.reason instanceof EmailReviewClientError && result.reason.status === 401) throw result.reason;
      if (result.status === 'fulfilled' && Array.isArray(result.value.data)) queue.push(...result.value.data.map((draft) => contextualize(draft, {
        scope: 'workspace', workspaceId: workspace.id, workspaceName: workspace.name, canWrite: workspace.permissions?.canWrite === true,
      })));
      else warnings.push(`${workspace.name}: ${result.status === 'rejected' && result.reason instanceof Error ? result.reason.message : 'Invalid outbox response.'}`);
    });
  } else warnings.push(`Workspaces: ${workspaces.status === 'rejected' && workspaces.reason instanceof Error ? workspaces.reason.message : 'Invalid workspace response.'}`);
  return { queue: [...new Map(queue.filter(isPendingEmailReview).map((entry) => [emailReviewKey(entry), entry])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), warnings };
}

export async function loadEmailReview(target: EmailReviewTarget, context?: EmailReviewEntry): Promise<EmailReviewEntry> {
  const { data } = await request<{ data: EmailOutboxDraft }>(endpoint(target));
  return contextualize(data, { scope: target.scope, workspaceId: target.workspaceId, workspaceName: context?.workspaceName, canWrite: context?.canWrite ?? target.scope === 'personal' });
}

export function parseEmailReviewRecipients(value: string): string[] {
  return value.split(/[,;\n]/u).map((item) => item.trim()).filter(Boolean).map((item) => {
    const display = item.match(/^[^<>]*<([^<>]+)>$/u);
    const address = (display?.[1] || item).trim().toLowerCase();
    if (/[\r\n,;]/u.test(item) || !/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/u.test(address)) {
      throw new Error('Use one valid email address per recipient. Separate recipients with commas or new lines.');
    }
    return address;
  });
}
export async function saveEmailReview(entry: EmailReviewEntry, form: EmailReviewForm) {
  const { data } = await request<{ data: EmailOutboxDraft }>(endpoint(emailReviewTarget(entry)), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      expectedVersion: entry.version, subject: form.subject, body: sanitizeEmailEditorHtml(form.bodyHtml),
      to: parseEmailReviewRecipients(form.toText), cc: parseEmailReviewRecipients(form.ccText), bcc: parseEmailReviewRecipients(form.bccText),
    }),
  });
  return contextualize(data, entry);
}
export async function decideEmailReview(entry: EmailReviewEntry, decision: 'send' | 'reject') {
  const { data } = await request<{ data: EmailOutboxDraft }>(`${endpoint(emailReviewTarget(entry))}/${decision}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: entry.version }),
  });
  return contextualize(data, entry);
}
