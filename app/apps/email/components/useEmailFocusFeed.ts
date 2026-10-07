'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmailClassificationFeed, EmailClassificationFeedItem, EmailFeedMode, EmailFeedView } from '@/app/lib/email/classification/feed-types';
import type { EmailMailboxScope } from '@/app/lib/email/classification/mailbox-types';
import type { EmailCategory } from '@/app/lib/email/classification/types';

export interface EmailFocusFeedError { code: string; status: number }
export interface UseEmailFocusFeedInput {
  userId: string; enabled: boolean; scope: EmailMailboxScope; mode: EmailFeedMode; view: EmailFeedView;
  category?: EmailCategory | null; search: string; limit?: number;
}
type FeedState = {
  key: string; feed: EmailClassificationFeed | null; loading: boolean; loadingMore: boolean;
  error: EmailFocusFeedError | null; hasUpdates: boolean;
};
type RequestContext = {
  key: string; cancelled: boolean; controllers: Set<AbortController>; foreground: AbortController | null;
  poll: AbortController | null; feed: EmailClassificationFeed | null; confirmedAt: number; authorityTimer: number | null;
};

/** Re-read the current snapshot: fresh authorization without consuming a new snapshot on every poll. */
function snapshotStartCursor(feed: EmailClassificationFeed): string {
  return btoa(JSON.stringify({ v: 1, id: feed.snapshot.id, after: 0 })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
function feedURL(input: UseEmailFocusFeedInput, cursor?: string) {
  const query = new URLSearchParams({ scope: input.scope.kind, mode: input.mode, view: input.view, limit: String(input.limit ?? 50) });
  if (input.scope.kind === 'mailbox') query.set('mailboxRef', input.scope.mailboxRef);
  if (input.category) query.set('category', input.category);
  if (input.search.trim()) query.set('search', input.search.trim().slice(0, 300));
  if (cursor) query.set('cursor', cursor);
  return `/api/email/classification/feed?${query}`;
}

/** The visible snapshot changes only after navigation, a user refresh, paging or a user mutation. */
export function useEmailFocusFeed(input: UseEmailFocusFeedInput) {
  const { userId, enabled, mode, view, category, search, scope, limit = 50 } = input;
  const mailboxRef = scope.kind === 'mailbox' ? scope.mailboxRef : '';
  const key = JSON.stringify([userId, enabled, scope.kind, mailboxRef, mode, view, category ?? '', search.trim().slice(0, 300), limit]);
  const active = enabled && Boolean(userId);
  const [state, setState] = useState<FeedState>({ key: '', feed: null, loading: false, loadingMore: false, error: null, hasUpdates: false });
  const contextRef = useRef<RequestContext | null>(null);
  const clearUnconfirmed = useCallback((context: RequestContext) => {
    if (context.cancelled || contextRef.current !== context) return;
    if (context.authorityTimer !== null) window.clearTimeout(context.authorityTimer);
    context.authorityTimer = null;
    for (const controller of context.controllers) controller.abort();
    context.feed = null;
    setState({ key: context.key, feed: null, loading: false, loadingMore: false, error: { code: 'EMAIL_FEED_UNAVAILABLE', status: 503 }, hasUpdates: false });
  }, []);

  const request = useCallback(async (context: RequestContext, selection: UseEmailFocusFeedInput, kind: 'replace' | 'more' | 'poll') => {
    if (context.cancelled || contextRef.current !== context) return;
    if (kind === 'poll' && (context.foreground || context.poll || !context.feed)) return;
    if (kind === 'more' && (!context.feed?.nextCursor || context.foreground)) return;
    const controller = new AbortController();
    if (kind !== 'poll') {
      context.foreground?.abort(); context.poll?.abort(); context.foreground = controller;
      setState(previous => ({ key: context.key, feed: previous.key === context.key ? previous.feed : null,
        loading: kind === 'replace', loadingMore: kind === 'more', error: null, hasUpdates: previous.key === context.key && previous.hasUpdates }));
    } else context.poll = controller;
    context.controllers.add(controller);
    const current = () => !context.cancelled && contextRef.current === context && !controller.signal.aborted;
    const deadline = window.setTimeout(() => { if (current()) clearUnconfirmed(context); }, 30_000);
    try {
      const cursor = kind === 'poll' ? snapshotStartCursor(context.feed!) : kind === 'more' ? context.feed!.nextCursor! : undefined;
      const response = await fetch(feedURL(selection, cursor), { credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) {
        throw { code: response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', status: response.status } satisfies EmailFocusFeedError;
      }
      const payload = await response.json();
      if (!current()) return;
      if (!response.ok || !payload.success) {
        throw { code: typeof payload.code === 'string' ? payload.code : response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'EMAIL_FEED_UNAVAILABLE', status: response.status } satisfies EmailFocusFeedError;
      }
      if (!payload.data?.snapshot?.id || !Array.isArray(payload.data.items)) throw { code: 'EMAIL_FEED_UNAVAILABLE', status: 503 } satisfies EmailFocusFeedError;
      const page = payload.data as EmailClassificationFeed;
      context.confirmedAt = Date.now();
      if (context.authorityTimer !== null) window.clearTimeout(context.authorityTimer);
      context.authorityTimer = window.setTimeout(() => clearUnconfirmed(context), 60_000);
      if (kind === 'poll') {
        setState(previous => previous.key === context.key ? { ...previous, error: null, hasUpdates: previous.hasUpdates || page.hasUpdates } : previous);
        return;
      }
      const previousItems = kind === 'more' ? context.feed!.items : [];
      const existing = new Set(previousItems.map(item => item.selectionKey));
      const feed = { ...page, items: [...previousItems, ...page.items.filter(item => !existing.has(item.selectionKey))] };
      context.feed = feed;
      setState({ key: context.key, feed, loading: false, loadingMore: false, error: null, hasUpdates: page.hasUpdates });
    } catch (failure) {
      if (!current()) return;
      const candidate = failure as Partial<EmailFocusFeedError>;
      const error: EmailFocusFeedError = { code: typeof candidate?.code === 'string' ? candidate.code : 'EMAIL_FEED_UNAVAILABLE', status: typeof candidate?.status === 'number' ? candidate.status : 503 };
      // An unsuccessful recheck cannot confirm that a previously visible origin remains readable.
      if (context.authorityTimer !== null) window.clearTimeout(context.authorityTimer);
      context.authorityTimer = null;
      context.feed = null;
      setState({ key: context.key, feed: null, loading: false, loadingMore: false, error, hasUpdates: error.status === 409 });
    } finally {
      window.clearTimeout(deadline);
      context.controllers.delete(controller);
      if (context.foreground === controller) context.foreground = null;
      if (context.poll === controller) context.poll = null;
    }
  }, [clearUnconfirmed]);

  useEffect(() => {
    const context: RequestContext = { key, cancelled: false, controllers: new Set(), foreground: null, poll: null, feed: null, confirmedAt: 0, authorityTimer: null };
    contextRef.current = context;
    if (!active) return () => { context.cancelled = true; };
    const selection: UseEmailFocusFeedInput = { userId, enabled, scope: scope.kind === 'mailbox' ? { kind: 'mailbox', mailboxRef } : { kind: scope.kind }, mode, view, category, search, limit };
    const start = window.setTimeout(() => { void request(context, selection, 'replace'); }, search.trim() ? 250 : 0);
    const checkRights = () => {
      if (document.visibilityState !== 'visible') return;
      if (context.feed && Date.now() - context.confirmedAt >= 60_000) { clearUnconfirmed(context); return; }
      void request(context, selection, 'poll');
    };
    const poll = window.setInterval(checkRights, 30_000);
    document.addEventListener('visibilitychange', checkRights); window.addEventListener('focus', checkRights);
    return () => {
      context.cancelled = true; window.clearTimeout(start); window.clearInterval(poll);
      if (context.authorityTimer !== null) window.clearTimeout(context.authorityTimer);
      document.removeEventListener('visibilitychange', checkRights); window.removeEventListener('focus', checkRights);
      for (const controller of context.controllers) controller.abort(); context.controllers.clear();
    };
  }, [key, active, userId, enabled, scope.kind, mailboxRef, mode, view, category, search, limit, request, clearUnconfirmed]);

  const reload = useCallback(() => {
    const context = contextRef.current;
    if (active && context?.key === key) void request(context, input, 'replace');
  }, [active, key, input, request]);
  const loadMore = useCallback(() => {
    const context = contextRef.current;
    if (active && context?.key === key) void request(context, input, 'more');
  }, [active, key, input, request]);
  const updateItem = useCallback((detail: EmailClassificationFeedItem) => {
    const context = contextRef.current;
    if (!active || context?.key !== key || !context.feed) return;
    const item: EmailClassificationFeedItem = { messageRef: detail.messageRef, selectionKey: detail.selectionKey, origin: detail.origin,
      message: detail.message, classification: detail.classification, personalFocus: detail.personalFocus };
    const feed = { ...context.feed, items: context.feed.items.map(previous => previous.messageRef === item.messageRef ? item : previous) };
    context.feed = feed;
    setState(previous => previous.key === key ? { ...previous, feed, hasUpdates: true } : previous);
  }, [active, key]);

  const current = active && state.key === key ? state : null;
  return { feed: current?.feed ?? null, items: current?.feed?.items ?? [], loading: active && (!current || current.loading),
    loadingMore: current?.loadingMore ?? false, error: current?.error ?? null, hasUpdates: current?.hasUpdates ?? false,
    hasMore: Boolean(current?.feed?.nextCursor), reload, loadMore, updateItem };
}
