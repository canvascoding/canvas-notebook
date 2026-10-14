'use client';

import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import type { ComposerReferencePickerItem } from './ComposerReferencePicker';
import type { ChatInlineEditorHandle } from './ChatInlineEditor';
import { PluginExtensionAvatar } from '@/app/components/plugins/PluginExtensionAvatar';
import { deriveChatBodySelection, parseChatBody, projectChatBodyText, type ChatBodyV1, type ChatReferenceBundleV1 } from '@/app/lib/chat/chat-body-contracts';
import type { ChatExtensionOptionsTarget } from '@/app/lib/chat/extension-options-contracts';
import { requestChatExtensionOptions } from '@/app/lib/chat/extension-options-client';
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
  const [itemsState, setItems] = useState<{ scope: string; items: ComposerReferencePickerItem<ChatReferencePickerValue>[] } | null>(null);
  const referencePickerItems = useMemo(() => itemsState?.scope === scope ? itemsState.items : [], [itemsState, scope]);
  const [selectedReferenceIndex, setSelectedIndex] = useState(0);
  const [referenceTypeFilter, setReferenceTypeFilter] = useState<ChatReferenceTypeFilter>('all');
  const [isLoadingReferenceItems, setLoading] = useState(false), [referencePickerError, setError] = useState<string | null>(null);
  const [pendingState, setPendingReference] = useState<ChatReferenceDialogRequest | null>(null);
  const pendingReference = pendingState?.issuedScope === scope ? pendingState : null;
  const latest = useRef({ scope, target, pendingReference });
  useLayoutEffect(() => { latest.current = { scope, target, pendingReference }; epoch.current++; }, [scope, target, pendingReference]);
  useLayoutEffect(() => { bodyRef.current = inputBody; }, [inputBody]);
  const closeReferencePicker = useCallback(() => { epoch.current++; setMatch(null); setItems(null); setSelectedIndex(0); setLoading(false); setError(null); }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setMatch(current => current?.scope !== scope ? null : current);
      setItems(current => current?.scope !== scope ? null : current);
      setPendingReference(current => current?.issuedScope !== scope ? null : current);
    }, 0);
    return () => clearTimeout(timer);
  }, [scope]);

  const handleSelectionChange = useCallback((range: ChatInlineTextRange) => {
    const match = findInlineComposerReference(bodyRef.current, range);
    setMatch(previous => JSON.stringify(previous) === JSON.stringify(match ? { scope, value: match } : null) ? previous : match ? { scope, value: match } : null);
    if (!match) closeReferencePicker();
  }, [closeReferencePicker, scope]);
  const handleInputChange = useCallback((body: ChatBodyV1) => {
    bodyRef.current = body; resetInputHistoryNavigation(); setInputBody(body);
    handleSelectionChange(editorRef.current?.getSelection() ?? { from: 0, to: 0 });
  }, [editorRef, handleSelectionChange, resetInputHistoryNavigation, setInputBody]);
  const openReferencePicker = useCallback(() => {
    const end = editorRef.current?.getSelection().to ?? 0;
    editorRef.current?.setSelection(end);
    setReferenceTypeFilter('all');
    const preceding = projectChatBodyText(bodyRef.current)[end - 1];
    const trigger = preceding && !/\s|[([{"'`,;]/u.test(preceding) ? ' /' : '/';
    editorRef.current?.replaceText(trigger, { from: end, to: end });
    editorRef.current?.focus();
  }, [editorRef]);

  useEffect(() => {
    if (!activeReferenceMatch || !target || !workspaceId) return;
    const controller = new AbortController(), version = ++epoch.current, match = activeReferenceMatch;
    const timer = setTimeout(() => {
      setLoading(true); setError(null);
      void (async () => {
        const items: ComposerReferencePickerItem<ChatReferencePickerValue>[] = [], errors: string[] = [];
        const tasks = await Promise.allSettled([
          match.kind === 'file' ? Promise.resolve(null) : requestChatExtensionOptions({ operation: 'search', target,
            q: match.query, types: referenceTypeFilter === 'all' ? ['plugin', 'skill', 'integration', 'mcp'] : [referenceTypeFilter],
            stock: 'all', source: 'all', scope: 'all', audience: null, teamId: null, cursor: null, selected: null, limit: 30 }, controller.signal),
          match.kind === 'capability' || referenceTypeFilter !== 'all' ? Promise.resolve([]) : listWorkspaceFileReferences({
            query: match.query, limit: 30, workspaceId, signal: controller.signal }),
        ]);
        const extensions = tasks[0];
        if (extensions.status === 'fulfilled' && extensions.value) {
          const result = extensions.value, recentKeys = new Set<string>();
          for (const recent of result.recents) {
            const selection = recent.bodyBundle.primary.selection, key = chatInlineReferenceIconKey(selection);
            recentKeys.add(key);
            items.push({ id: `recent:${key}`, kind: selection.kind === 'composio' ? 'integration' : selection.kind,
              label: recent.bodyBundle.caption, secondaryLabel: t('referenceRecent') + ' · ' + (selection.kind === 'composio' ? 'Composio' : selection.kind),
              icon: createElement(PluginExtensionAvatar, { name: recent.bodyBundle.caption, identity: `${scope}:${key}`, icon: recent.publicIcon, size: 'sm' }),
              payload: { type: 'recent', recent } });
          }
          for (const option of result.items) {
            if (option.selection && recentKeys.has(chatInlineReferenceIconKey(option.selection))) continue;
            const item = option.item;
            items.push({ id: item.id, kind: item.kind, label: item.displayName, secondaryLabel: option.eligibility.reason?.message ?? item.description,
              icon: createElement(PluginExtensionAvatar, { name: item.displayName, identity: `${scope}:${item.id}`, icon: item.icon, size: 'sm' }),
              payload: { type: 'extension', option } });
          }
          errors.push(...result.coverage.filter(row => row.status === 'unavailable').map(row => row.error?.message ?? row.source));
        } else if (extensions.status === 'rejected') errors.push(String(extensions.reason?.message ?? extensions.reason));
        const files = tasks[1];
        if (files.status === 'fulfilled') items.push(...files.value.map(file => ({ id: `file:${file.path}`, kind: 'file' as const,
          label: getFileDisplayPath(file.path), secondaryLabel: 'File', payload: file,
          icon: getFileIconComponent({ name: file.name, path: file.path, type: file.type }) })));
        else errors.push(String(files.reason?.message ?? files.reason));
        if (controller.signal.aborted || epoch.current !== version || latest.current.scope !== scope || !isOpenedDocumentAuthCurrent(auth)) return;
        setItems({ scope, items }); setSelectedIndex(0); setError(errors.join(' · ') || null); setLoading(false);
      })().catch(error => { if (!controller.signal.aborted && epoch.current === version && latest.current.scope === scope) { setError(String(error.message ?? error)); setItems(null); setLoading(false); } });
    }, activeReferenceMatch.query ? 120 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [activeReferenceMatch, target, scope, workspaceId, referenceTypeFilter, t, auth]);

  const handleReferenceSelect = useCallback((item: ComposerReferencePickerItem<ChatReferencePickerValue>) => {
    if (!activeReferenceMatch || !target || latest.current.scope !== scope || !isOpenedDocumentAuthCurrent(auth) || !referencePickerItems.includes(item)) return;
    const range = { from: activeReferenceMatch.startIndex, to: activeReferenceMatch.endIndex }, payload = item.payload;
    closeReferencePicker();
    if (payload.type === 'file' || payload.type === 'directory') {
      editorRef.current?.replaceText(`@"${payload.path}" `, range); editorRef.current?.focus(); return;
    }
    if (payload.type === 'extension') setPendingReference({ issuedScope: scope, target, originalBody: bodyRef.current, range, option: payload.option });
    else if (payload.type === 'recent') setPendingReference({ issuedScope: scope, target, originalBody: bodyRef.current, range, recent: payload.recent });
  }, [activeReferenceMatch, closeReferencePicker, editorRef, target, scope, auth, referencePickerItems]);

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
  }, [editorRef, pendingReference, receipts, scope, t, auth]);
  const prepareIntakeSelection = useCallback(async (body: ChatBodyV1): Promise<ChatExtensionSelectionInput | null> => {
    if (latest.current.scope !== scope || !isOpenedDocumentAuthCurrent(auth)) throw new Error(t('referenceChatChanged'));
    const selection = deriveChatBodySelection(body);
    if (!selection) return null;
    return { ...selection, selections: selection.selections.map(entry => {
      if (entry.selection.kind !== 'composio' || entry.selection.target.kind !== 'personal' || entry.selection.target.accountBinding !== 'account') return entry;
      const current = receipts.get(chatInlineReferenceIconKey(entry.selection));
      if (!current || current.expiresAt <= Date.now()) {
        if (latest.current.target) setPendingReference({ issuedScope: scope, target: latest.current.target, originalBody: bodyRef.current, range: null, confirmSelection: entry.selection });
        throw new Error(t('referenceAccountConfirmationRequired'));
      }
      return { ...entry, accountSelectionRef: current.receipt };
    }) };
  }, [receipts, t, scope, auth]);
  return { target, activeReferenceMatch, closeReferencePicker, handleInputChange, handleSelectionChange, handleReferenceSelect,
    isLoadingReferenceItems, referencePickerError, referencePickerItems, selectedReferenceIndex,
    selectNextReference: () => setSelectedIndex(value => Math.min(referencePickerItems.length - 1, value + 1)),
    selectPreviousReference: () => setSelectedIndex(value => Math.max(0, value - 1)),
    referenceTypeFilter, setReferenceTypeFilter, openReferencePicker, pendingReference,
    closeReferenceDialog: () => { setPendingReference(null); editorRef.current?.focus(); }, acceptReference, prepareIntakeSelection };
}
