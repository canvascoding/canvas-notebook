'use client';

import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import type { ComposerReferencePickerItem } from './ComposerReferencePicker';
import type { ChatInlineEditorHandle } from './ChatInlineEditor';
import { PluginExtensionAvatar } from '@/app/components/plugins/PluginExtensionAvatar';
import { deriveChatBodySelection, parseChatBody, projectChatBodyText, type ChatBodyV1, type ChatReferenceBundleV1 } from '@/app/lib/chat/chat-body-contracts';
import type { ChatExtensionOptionsTarget } from '@/app/lib/chat/extension-options-contracts';
import { ChatExtensionOptionsClientError, requestChatExtensionOptions } from '@/app/lib/chat/extension-options-client';
import type { ChatReferenceDialogRequest, ChatReferencePickerValue } from '@/app/lib/chat/composer-reference-types';
import type { ChatExtensionSelectionInput } from '@/app/lib/capabilities/extensions/contracts';
import { findInlineComposerReference } from '@/app/lib/chat/inline-references';
import { chatInlineReferenceIconKey, type ChatInlineTextRange } from '@/app/lib/chat/inline-editor';
import type { ComposerReferenceMatch } from '@/app/lib/chat/composer-references';
import type { PluginExtensionKind } from '@/app/lib/plugins/plugin-extension-contracts';
import { listWorkspaceFileReferences } from '@/app/lib/files/client';
import { getFileDisplayPath } from '@/app/lib/files/display-name';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { openedDocumentAuthScope, isOpenedDocumentAuthCurrent, subscribeOpenedDocumentAuthInvalidation } from '@/app/lib/collaboration/opened-document-registry';
import { getTransientChatAccountSelections } from '@/app/lib/chat/transient-account-selections';

type Params = { agentId: string | null; sessionId: string | null; inputBody: ChatBodyV1; workspaceId: string | null;
  resetInputHistoryNavigation: () => void; setInputBody: Dispatch<SetStateAction<ChatBodyV1>>;
  editorRef: RefObject<ChatInlineEditorHandle | null> };
export type ChatReferenceTypeFilter = 'all' | PluginExtensionKind;
export type ChatReferenceSourceStatus = { source: 'local' | 'connected' | 'remote' | 'files'; status: 'loading' | 'complete' | 'unavailable' | 'paused'; message?: string };

export function useComposerReferences({ agentId, sessionId, inputBody, workspaceId, resetInputHistoryNavigation,
  setInputBody, editorRef }: Params) {
  const t = useTranslations('chat');
  const target = useMemo<ChatExtensionOptionsTarget | null>(() => !workspaceId || !agentId ? null : sessionId
    ? { kind: 'turn', sessionId, expectedAgentId: agentId, expectedWorkspaceId: workspaceId }
    : { kind: 'draft_turn', agentId, workspaceId }, [agentId, sessionId, workspaceId]);
  const auth = useSyncExternalStore(subscribeOpenedDocumentAuthInvalidation, openedDocumentAuthScope, () => null);
  const scope = JSON.stringify([auth?.userId, auth?.sessionId, auth?.epoch, target]);
  const receiptScope = JSON.stringify([auth?.userId, auth?.sessionId, auth?.epoch, workspaceId, agentId]);
  const bodyRef = useRef(inputBody), epoch = useRef(0);
  const receipts = useMemo(() => getTransientChatAccountSelections(receiptScope), [receiptScope]);
  const [matchState, setMatch] = useState<{ scope: string; value: ComposerReferenceMatch } | null>(null);
  const activeReferenceMatch = matchState?.scope === scope ? matchState.value : null;
  const [referenceTypeFilter, setReferenceTypeFilter] = useState<ChatReferenceTypeFilter>('all');
  const queryKey = JSON.stringify([scope, activeReferenceMatch?.kind, activeReferenceMatch?.query, referenceTypeFilter]);
  const [itemsState, setItems] = useState<{ key: string; items: ComposerReferencePickerItem<ChatReferencePickerValue>[] } | null>(null);
  const referencePickerItems = useMemo(() => itemsState?.key === queryKey ? itemsState.items : [], [itemsState, queryKey]);
  const [focus, setFocus] = useState<{ key: string; id: string } | null>(null);
  const selectedReferenceIndex = Math.max(0, focus?.key === queryKey ? referencePickerItems.findIndex(item => item.id === focus.id) : 0);
  const [sourceState, setSources] = useState<{ key: string; statuses: ChatReferenceSourceStatus[] } | null>(null);
  const referenceSourceStatuses = sourceState?.key === queryKey ? sourceState.statuses : [];
  const sourceRetries = useRef(new Map<ChatReferenceSourceStatus['source'], () => void>());
  const [loadingState, setLoading] = useState(false), [referencePickerError, setError] = useState<string | null>(null);
  const isLoadingReferenceItems = Boolean(activeReferenceMatch && (sourceState?.key !== queryKey || loadingState));
  const [pendingState, setPendingReference] = useState<ChatReferenceDialogRequest | null>(null);
  const pendingReference = pendingState?.issuedScope === scope ? pendingState : null;
  const latest = useRef({ scope, target, pendingReference });
  useLayoutEffect(() => { latest.current = { scope, target, pendingReference }; epoch.current++; }, [scope, target, pendingReference]);
  useLayoutEffect(() => { bodyRef.current = inputBody; }, [inputBody]);
  const closeReferencePicker = useCallback(() => { epoch.current++; setMatch(null); setItems(null); setFocus(null); setLoading(false); setError(null); }, [setMatch, setItems, setFocus, setLoading, setError]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setMatch(current => current?.scope !== scope ? null : current);
      setPendingReference(current => current?.issuedScope !== scope ? null : current);
    }, 0);
    return () => clearTimeout(timer);
  }, [scope]);

  const handleSelectionChange = useCallback((range: ChatInlineTextRange) => {
    const match = findInlineComposerReference(bodyRef.current, range);
    setMatch(previous => JSON.stringify(previous) === JSON.stringify(match ? { scope, value: match } : null) ? previous : match ? { scope, value: match } : null);
    if (!match) closeReferencePicker();
  }, [closeReferencePicker, scope, setMatch]);
  const handleInputChange = useCallback((body: ChatBodyV1) => {
    if (latest.current.pendingReference && JSON.stringify(body) !== JSON.stringify(latest.current.pendingReference.originalBody)) {
      latest.current.pendingReference = null; setPendingReference(null);
    }
    bodyRef.current = body; resetInputHistoryNavigation(); setInputBody(body);
    handleSelectionChange(editorRef.current?.getSelection() ?? { from: 0, to: 0 });
  }, [editorRef, handleSelectionChange, resetInputHistoryNavigation, setInputBody, setPendingReference]);
  const openReferencePicker = useCallback(() => {
    const end = editorRef.current?.getSelection().to ?? 0;
    editorRef.current?.setSelection(end);
    setReferenceTypeFilter('all');
    const preceding = projectChatBodyText(bodyRef.current)[end - 1];
    const trigger = preceding && !/\s|[([{"'`,;]/u.test(preceding) ? ' @' : '@';
    editorRef.current?.replaceText(trigger, { from: end, to: end });
    editorRef.current?.focus();
  }, [editorRef, setReferenceTypeFilter]);

  useEffect(() => {
    if (!activeReferenceMatch || !target || !workspaceId) return;
    const controller = new AbortController(), version = ++epoch.current, match = activeReferenceMatch;
    const current = () => !controller.signal.aborted && epoch.current === version && latest.current.scope === scope && isOpenedDocumentAuthCurrent(auth);
    const results = new Map<ChatReferenceSourceStatus['source'], ComposerReferencePickerItem<ChatReferencePickerValue>[]>();
    const statuses = new Map<ChatReferenceSourceStatus['source'], ChatReferenceSourceStatus>();
    const generations = new Map<ChatReferenceSourceStatus['source'], number>();
    type Pages = { cursor: string | null; seen: Set<string | null>; items: Map<string, ComposerReferencePickerItem<ChatReferencePickerValue>>; errors: Set<string>; finished: boolean; reset: boolean };
    const pages = new Map<ChatReferenceSourceStatus['source'], Pages>();
    const priorityOrder: string[] = [];
    let previousItems: ComposerReferencePickerItem<ChatReferencePickerValue>[] = [];
    let connectedStarted = false, connectedResponded = false, catalogStarted = false;
    const identityOf = (item: ComposerReferencePickerItem<ChatReferencePickerValue>) => {
      const payload = item.payload;
      const selection = payload.type === 'extension' ? payload.option.selection : payload.type === 'recent' ? payload.recent.bodyBundle.primary.selection : null;
      return selection ? chatInlineReferenceIconKey(selection) : item.id;
    };
    const publish = () => {
      if (!current()) return;
      // A connected refresh supersedes its local snapshot, while still-ready
      // rows retain their position. Catalog arrivals never promote or reorder it.
      const local = new Map<string, ComposerReferencePickerItem<ChatReferencePickerValue>>();
      const refreshedIds = new Set((results.get('connected') ?? []).map(item => item.id));
      for (const source of ['local', 'connected'] as const) for (const item of results.get(source) ?? []) {
        if (source === 'local' && (connectedResponded || refreshedIds.has(item.id))) continue;
        const identity = identityOf(item), existing = local.get(identity);
        if (existing?.payload.type === 'recent' && existing.section === 'ready' && item.section === 'ready') continue;
        if (!existing || source === 'connected' || existing.payload.type !== 'recent') local.set(identity, item);
      }
      const ready = [...local.entries()].filter(([, item]) => item.section === 'ready');
      for (const [identity] of ready) if (!priorityOrder.includes(identity)) priorityOrder.push(identity);
      ready.sort(([left, leftItem], [right, rightItem]) => Number(rightItem.payload.type === 'recent') - Number(leftItem.payload.type === 'recent')
        || (leftItem.payload.type === 'recent' && rightItem.payload.type === 'recent' ? rightItem.payload.recent.lastAcceptedAt - leftItem.payload.recent.lastAcceptedAt : 0)
        || priorityOrder.indexOf(left) - priorityOrder.indexOf(right));
      const ordered = [...ready.map(([, item]) => item), ...(results.get('files') ?? []),
        ...(catalogStarted ? [...local.values()].filter(item => item.section !== 'ready') : []), ...(results.get('remote') ?? [])];
      const exact = new Set<string>(), ids = new Set<string>();
      const items = ordered.filter(item => {
        const identity = identityOf(item);
        if (exact.has(identity) || ids.has(item.id)) return false;
        exact.add(identity); ids.add(item.id); return true;
      });
      setItems({ key: queryKey, items });
      const before = previousItems;
      setFocus(previous => {
        if (previous?.key === queryKey) {
          if (items.some(item => item.id === previous.id)) return previous;
          const selected = before.find(item => item.id === previous.id);
          const replacement = selected && items.find(item => identityOf(item) === identityOf(selected));
          if (replacement) return { key: queryKey, id: replacement.id };
        }
        return items[0] ? { key: queryKey, id: items[0].id } : null;
      });
      previousItems = items;
      const states = [...statuses.values()];
      setSources({ key: queryKey, statuses: states }); setLoading(states.some(row => row.status === 'loading'));
      setError(states.filter(row => row.status === 'unavailable').map(row => row.message ?? row.source).join(' · ') || null);
    };
    const timer = setTimeout(() => {
      const load = (source: ChatReferenceSourceStatus['source']) => {
        if (!current()) return;
        if (statuses.get(source)?.status === 'loading' && generations.has(source)) return;
        const generation = (generations.get(source) ?? 0) + 1;
        generations.set(source, generation);
        const sourceCurrent = () => current() && generations.get(source) === generation;
        let state = pages.get(source);
        if (!state || state.finished || state.reset) {
          state = { cursor: null, seen: new Set(), items: new Map(), errors: new Set(), finished: false, reset: false };
          pages.set(source, state);
        }
        const paging = state;
        statuses.set(source, { source, status: 'loading' }); publish();
        void (async () => {
          if (source === 'files') {
            const files = await listWorkspaceFileReferences({ query: match.query, limit: 30, workspaceId, signal: controller.signal });
            if (!sourceCurrent()) return;
            results.set(source, files.map(file => ({ id: `file:${file.path}`, kind: 'file' as const, label: getFileDisplayPath(file.path),
              secondaryLabel: 'File', section: 'files' as const, payload: file, icon: getFileIconComponent({ name: file.name, path: file.path, type: file.type }) })));
            statuses.set(source, { source, status: 'complete' }); publish(); return;
          }
          const errors = paging.errors;
          for (let page = 0; page < 20; page++) {
            const cursor = paging.cursor;
            const result = await requestChatExtensionOptions({ operation: 'search', target, phase: source,
              q: match.query, types: referenceTypeFilter === 'all' ? ['plugin', 'skill', 'integration', 'mcp'] : [referenceTypeFilter],
              stock: 'all', source: 'all', scope: 'all', audience: null, teamId: null, cursor, selected: null, limit: 50 }, controller.signal);
            if (!sourceCurrent()) return;
            const items: ComposerReferencePickerItem<ChatReferencePickerValue>[] = [];
            const recentKeys = new Set<string>();
          for (const recent of result.recents) {
            if (recent.chatAvailability !== 'ready') continue;
            const selection = recent.bodyBundle.primary.selection, key = chatInlineReferenceIconKey(selection);
            recentKeys.add(key);
            items.push({ id: `recent:${key}`, kind: selection.kind === 'composio' ? 'integration' : selection.kind==='core_plugin'?'plugin':selection.kind==='core_skill'?'skill':selection.kind,
              label: recent.bodyBundle.caption, secondaryLabel: t('referenceRecent') + ' · ' + (selection.kind === 'composio' ? 'Composio' : selection.kind==='core_plugin'?'plugin':selection.kind==='core_skill'?'skill':selection.kind),
              section: source !== 'remote' && recent.chatAvailability === 'ready' ? 'ready' : 'catalog',
              icon: createElement(PluginExtensionAvatar, { name: recent.bodyBundle.caption, identity: `${scope}:${key}`, icon: recent.publicIcon, size: 'sm' }),
              payload: { type: 'recent', recent } });
          }
          for (const option of result.items) {
            if (option.selection && recentKeys.has(chatInlineReferenceIconKey(option.selection))) continue;
            const item = option.item;
            items.push({ id: item.id, kind: item.kind, label: item.displayName, secondaryLabel: option.eligibility.reason?.message ?? item.description,
              section: source !== 'remote' && option.chatAvailability === 'ready' ? 'ready' : 'catalog',
              ...(option.chatAvailability !== 'ready' ? { catalogAction: item.stock === 'available' && (item.kind === 'plugin' || item.kind === 'skill') ? 'install' as const
                : (item.kind === 'integration' || item.kind === 'mcp') && !item.connections?.length ? 'connect' as const : 'setup' as const } : {}),
              icon: createElement(PluginExtensionAvatar, { name: item.displayName, identity: `${scope}:${item.id}`, icon: item.icon, size: 'sm' }),
              payload: { type: 'extension', option } });
          }
            for (const row of result.coverage) if (row.status === 'unavailable' || row.status === 'partial' && row.error?.retryable) errors.add(row.error?.message ?? row.source);
            const next = result.pagination.nextCursor;
            if (source !== 'remote' && result.pagination.hasNextPage && (!next || next === cursor || paging.seen.has(next))) {
              paging.reset = true;
              throw new Error('The search cursor repeated or is missing. Retry starts a fresh search.');
            }
            paging.seen.add(cursor);
            for (const item of items) paging.items.set(item.id, item);
            paging.finished = source === 'remote' || !result.pagination.hasNextPage;
            paging.cursor = paging.finished ? null : next;
            if (source === 'connected' && paging.finished) connectedResponded = true;
            results.set(source, [...paging.items.values()]);
            statuses.set(source, paging.finished ? errors.size ? { source, status: 'unavailable', message: [...errors].join(' · ') } : { source, status: 'complete' }
              : page === 19 ? { source, status: 'paused' } : { source, status: 'loading' });
            publish();
            if (paging.finished) return;
          }
        })().catch(reason => { if (sourceCurrent()) {
          if (reason instanceof ChatExtensionOptionsClientError && (reason.status === 409 || reason.status === 400) && /CURSOR/u.test(reason.code)) {
            pages.delete(source); results.delete(source);
          }
          statuses.set(source, { source, status: 'unavailable', message: String(reason?.message ?? reason) }); publish();
        } })
          .finally(() => {
            if (!sourceCurrent()) return;
            if (statuses.get(source)?.status === 'paused') return;
            if (source === 'local' && !connectedStarted) { connectedStarted = true; load('connected'); }
            else if (source === 'connected' && !catalogStarted) { catalogStarted = true; load('remote'); }
          });
      };
      sourceRetries.current = new Map();
      const sources: ChatReferenceSourceStatus['source'][] = match.kind === 'file' ? [] : ['local'];
      if (match.kind !== 'capability' && referenceTypeFilter === 'all') sources.push('files');
      for (const source of sources) statuses.set(source, { source, status: 'loading' });
      publish();
      for (const source of ['local', 'connected', 'remote', 'files'] as const) sourceRetries.current.set(source, () => { if (statuses.has(source)) load(source); });
      for (const source of sources) load(source);
    }, activeReferenceMatch.query ? 120 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [activeReferenceMatch, target, scope, workspaceId, referenceTypeFilter, t, auth, queryKey]);

  const handleReferenceSelect = useCallback((item: ComposerReferencePickerItem<ChatReferencePickerValue>, configure = false) => {
    if (!activeReferenceMatch || !target || latest.current.scope !== scope || !isOpenedDocumentAuthCurrent(auth) || !referencePickerItems.includes(item)) return;
    const range = { from: activeReferenceMatch.startIndex, to: activeReferenceMatch.endIndex }, payload = item.payload;
    closeReferencePicker();
    if (payload.type === 'file' || payload.type === 'directory') {
      editorRef.current?.replaceText(`@"${payload.path}" `, range); editorRef.current?.focus(); return;
    }
    latest.current.pendingReference = null;
    const accountSelections = Object.fromEntries([...receipts].filter(([, entry]) => entry.expiresAt > Date.now()));
    if (payload.type === 'extension') setPendingReference({ requestId: crypto.randomUUID(), issuedScope: scope, target, originalBody: bodyRef.current, range, option: payload.option, configure, accountSelections });
    else if (payload.type === 'recent') setPendingReference({ requestId: crypto.randomUUID(), issuedScope: scope, target, originalBody: bodyRef.current, range, recent: payload.recent, configure, accountSelections });
  }, [activeReferenceMatch, closeReferencePicker, editorRef, target, scope, auth, referencePickerItems, receipts, setPendingReference]);

  const acceptReference = useCallback((bundle: ChatReferenceBundleV1, intake: ChatExtensionSelectionInput | null,
    receiptExpiries: Readonly<Record<string, number>> = {}) => {
    const pending = pendingReference;
    if (!pending || pending.issuedScope !== scope || latest.current.scope !== scope || !isOpenedDocumentAuthCurrent(auth) || latest.current.pendingReference !== pending
      || JSON.stringify(pending.target) !== JSON.stringify(latest.current.target)) throw new Error(t('referenceChatChanged'));
    if (pending.confirmSelection) {
      if (!intake?.selections.some(entry => chatInlineReferenceIconKey(entry.selection) === chatInlineReferenceIconKey(pending.confirmSelection!)))
        throw new Error(t('referenceConfirmExactAccount'));
    } else {
      if (JSON.stringify(bodyRef.current) !== JSON.stringify(pending.originalBody)) throw new Error(t('referenceInputChanged'));
      parseChatBody({ ...bodyRef.current, parts: [...bodyRef.current.parts,
        { type: 'extension_reference', occurrenceId: crypto.randomUUID(), bundleId: bundle.id }], bundles: [...bodyRef.current.bundles, bundle] });
      if (!editorRef.current?.insertReference(bundle, pending.range ?? undefined)) throw new Error(t('referenceInsertFailed'));
    }
    for (const entry of intake?.selections ?? []) if (entry.accountSelectionRef) {
      const key = chatInlineReferenceIconKey(entry.selection), expiresAt = receiptExpiries[key];
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) receipts.set(key,
        { receipt: entry.accountSelectionRef, expiresAt: Math.min(expiresAt, Date.now() + 4 * 60_000) });
    }
    setPendingReference(null); editorRef.current?.focus();
  }, [editorRef, pendingReference, receipts, scope, t, auth, setPendingReference]);
  const prepareIntakeSelection = useCallback(async (body: ChatBodyV1): Promise<ChatExtensionSelectionInput | null> => {
    if (latest.current.scope !== scope || !isOpenedDocumentAuthCurrent(auth)) throw new Error(t('referenceChatChanged'));
    if (latest.current.pendingReference) throw new Error(t('loadingReferences'));
    const selection = deriveChatBodySelection(body);
    if (!selection) return null;
    return { ...selection, selections: selection.selections.map(entry => {
      if (entry.selection.kind !== 'composio' || entry.selection.target.kind !== 'personal' || entry.selection.target.accountBinding !== 'account') return entry;
      const current = receipts.get(chatInlineReferenceIconKey(entry.selection));
      if (!current || current.expiresAt <= Date.now()) {
        if (latest.current.target) setPendingReference({ requestId: crypto.randomUUID(), issuedScope: scope, target: latest.current.target, originalBody: bodyRef.current, range: null, confirmSelection: entry.selection });
        throw new Error(t('referenceAccountConfirmationRequired'));
      }
      return { ...entry, accountSelectionRef: current.receipt };
    }) };
  }, [receipts, t, scope, auth, setPendingReference]);
  return { target, activeReferenceMatch, closeReferencePicker, handleInputChange, handleSelectionChange, handleReferenceSelect,
    isLoadingReferenceItems, referencePickerError, referencePickerItems, selectedReferenceIndex,
    selectNextReference: () => { const item = referencePickerItems[Math.min(referencePickerItems.length - 1, selectedReferenceIndex + 1)]; if (item) setFocus({ key: queryKey, id: item.id }); },
    selectPreviousReference: () => { const item = referencePickerItems[Math.max(0, selectedReferenceIndex - 1)]; if (item) setFocus({ key: queryKey, id: item.id }); },
    referenceSourceStatuses, retryReferenceSource: (source: ChatReferenceSourceStatus['source']) => sourceRetries.current.get(source)?.(),
    configureReference: (item: ComposerReferencePickerItem<ChatReferencePickerValue>) => handleReferenceSelect(item, true),
    referenceTypeFilter, setReferenceTypeFilter, openReferencePicker, pendingReference,
    closeReferenceDialog: () => { latest.current.pendingReference = null; setPendingReference(null); editorRef.current?.focus(); }, acceptReference, prepareIntakeSelection };
}
