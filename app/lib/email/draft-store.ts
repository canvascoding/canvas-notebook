import 'server-only';

import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { emailDrafts } from '@/app/lib/db/schema';

export type LocalEmailDraftInput = {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  is_HTML?: boolean;
};

export type StoredEmailDraft = typeof emailDrafts.$inferSelect;

function jsonArray(value: string[]): string {
  return JSON.stringify(value.map((entry) => entry.trim()).filter(Boolean));
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function publicEmailDraft(draft: StoredEmailDraft) {
  return {
    id: draft.id,
    accountId: draft.accountId,
    status: draft.status,
    to: parseJsonArray(draft.toJson),
    cc: parseJsonArray(draft.ccJson),
    bcc: parseJsonArray(draft.bccJson),
    subject: draft.subject,
    body: draft.body,
    is_HTML: draft.isHtml,
    sentAt: draft.sentAt?.toISOString() || null,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

export async function createStoredEmailDraft(userId: string, input: LocalEmailDraftInput): Promise<StoredEmailDraft> {
  const now = new Date();
  const id = `draft_${crypto.randomUUID()}`;
  await db.insert(emailDrafts).values({
    id,
    userId,
    accountId: input.accountId,
    status: 'draft',
    toJson: jsonArray(input.to),
    ccJson: jsonArray(input.cc || []),
    bccJson: jsonArray(input.bcc || []),
    subject: input.subject,
    body: input.body,
    isHtml: Boolean(input.is_HTML),
    providerDraftId: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const draft = await getStoredEmailDraft(userId, id);
  if (!draft) throw new Error('Email draft could not be created.');
  return draft;
}

export async function getStoredEmailDraft(userId: string, draftId: string): Promise<StoredEmailDraft | null> {
  const draft = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.userId, userId), eq(emailDrafts.id, draftId)),
  });
  return draft ?? null;
}

export async function updateStoredEmailDraft(userId: string, draftId: string, input: LocalEmailDraftInput): Promise<StoredEmailDraft> {
  const existing = await getStoredEmailDraft(userId, draftId);
  if (!existing || existing.status !== 'draft') throw new Error('Email draft not found.');
  await db.update(emailDrafts)
    .set({
      accountId: input.accountId,
      toJson: jsonArray(input.to),
      ccJson: jsonArray(input.cc || []),
      bccJson: jsonArray(input.bcc || []),
      subject: input.subject,
      body: input.body,
      isHtml: Boolean(input.is_HTML),
      updatedAt: new Date(),
    })
    .where(and(eq(emailDrafts.userId, userId), eq(emailDrafts.id, draftId)));
  const updated = await getStoredEmailDraft(userId, draftId);
  if (!updated) throw new Error('Email draft not found.');
  return updated;
}

export async function markStoredEmailDraftSent(userId: string, draftId: string): Promise<StoredEmailDraft> {
  const existing = await getStoredEmailDraft(userId, draftId);
  if (!existing || existing.status !== 'draft') throw new Error('Email draft not found.');
  const now = new Date();
  await db.update(emailDrafts)
    .set({ status: 'sent', sentAt: now, updatedAt: now })
    .where(and(eq(emailDrafts.userId, userId), eq(emailDrafts.id, draftId)));
  const updated = await getStoredEmailDraft(userId, draftId);
  if (!updated) throw new Error('Email draft not found.');
  return updated;
}
