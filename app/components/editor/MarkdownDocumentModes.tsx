'use client';

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Code2, Eye, Pencil, Maximize2, Minimize2, MoveHorizontal } from 'lucide-react';
import { collaborationDiagnosticsEnabled, collaborationEditorIssue, subscribeCollaborationDiagnostics } from '@/app/lib/collaboration/editor-presentation';
import { NotebookFocusContext } from '@/app/components/notebook/NotebookFocusContext';
import * as Y from 'yjs';
import { Button } from '@/components/ui/button';
import type { CollaborationDocument } from '@/app/lib/collaboration/client';
import { workspaceHeaders } from '@/app/lib/files/client';
import { recordExportedCollaborationRecovery } from '@/app/lib/collaboration/local-recovery';
import { useMarkdownRecoveryCopy } from '@/app/lib/collaboration/markdown-recovery-client';
import { findBlockTreeHistory } from '@/app/lib/collaboration/block-tree-history';
import { BLOCK_TREE_KEY } from '@/app/lib/collaboration/block-tree';
import { createRichMarkdownManager, restoreRichMarkdownFinalLineEnding } from '@/app/lib/markdown/rich-markdown-codec';
import { readRichDocumentJson } from '@/app/lib/collaboration/rich-document';
import { COLLABORATION_CLIENT_CAPABILITIES, isRichTextCollaborationRepresentation, supportsBlockTreeCollaboration } from '@/app/lib/collaboration/types';

export type MarkdownDocumentMode = 'read' | 'rich' | 'source';

/** Observe the authoritative document even when its editor is not mounted. */
function createLiveMarkdownStore(doc: Y.Doc | undefined, representation: string | undefined, fallback: string) {
  let cached: { content: string; available: boolean } | undefined;
  const manager = isRichTextCollaborationRepresentation(representation) ? createRichMarkdownManager() : null;
  return {
    subscribe(listener: () => void) {
      const update = () => { cached = undefined; listener(); };
      doc?.on('update', update);
      return () => doc?.off('update', update);
    },
    snapshot() {
      if (cached) return cached;
      // A first visit can hydrate an empty IndexedDB before the remote root
      // arrives. Reading it as legacy XML would create a competing body root
      // and make the subsequently received block tree unrenderable.
      if (doc && representation === 'tiptap_blocks' && !doc.share.has(BLOCK_TREE_KEY)) {
        return (cached = { content: '', available: false });
      }
      try {
        const content = !doc ? fallback : representation === 'plain_text'
          ? doc.getText('content').toString()
          : doc.getText('frontmatter').toString() + restoreRichMarkdownFinalLineEnding(
            doc.getText('bodyFinalLineEnding').toString(),
            manager!.serialize(readRichDocumentJson(doc)),
          );
        cached = { content, available: true };
      } catch { cached = { content: '', available: false }; }
      return cached;
    },
  };
}

export function useLiveMarkdown(collaboration: CollaborationDocument | null, fallback: string) {
  // An empty startup instance has no authoritative root yet. Project only the
  // hydrated document, and create a fresh store when that state becomes known.
  const doc = collaboration?.clientState.indexedDbHydrated ? collaboration.doc : undefined;
  const representation = collaboration?.session?.representation;
  const store = useMemo(() => createLiveMarkdownStore(doc, representation, fallback), [doc, representation, fallback]);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

export function MarkdownModeBar({ mode, onChange, readOnly, wide, onWideChange, documentControls = true, actions }: {
  mode: MarkdownDocumentMode; onChange: (mode: MarkdownDocumentMode) => void; readOnly: boolean;
  wide: boolean; onWideChange: (wide: boolean) => void;
  documentControls?: boolean; actions?: ReactNode;
}) {
  const t = useTranslations('notebook.editorModes');
  const focus = useContext(NotebookFocusContext);
  return <div className="markdown-mode-bar flex shrink-0 items-center gap-1 border-b bg-background px-3 py-1.5" role="group" aria-label={t('label')}>
    {([{ mode: 'read', icon: Eye }, { mode: 'rich', icon: Pencil }, { mode: 'source', icon: Code2 }] as const).map((item) =>
      <Button key={item.mode} variant={mode === item.mode ? 'secondary' : 'ghost'} size="sm"
        className="h-8 gap-1.5 px-2.5" aria-pressed={mode === item.mode}
        disabled={readOnly && item.mode === 'rich'} onClick={() => onChange(item.mode)}>
        <item.icon className="size-3.5" aria-hidden="true" />{t(item.mode)}
      </Button>)}
    <div className="ml-auto flex items-center gap-1">
      {documentControls && <Button size="icon-sm" variant={wide ? 'secondary' : 'ghost'} aria-label={t('wide')}
        title={t('wide')} aria-pressed={wide} onClick={() => onWideChange(!wide)} disabled={mode === 'source'}>
        <MoveHorizontal className="size-4" aria-hidden="true" />
      </Button>}
      {documentControls && focus && <Button size="icon-sm" variant={focus.focused ? 'secondary' : 'ghost'}
        className="hidden md:inline-flex" aria-label={t(focus.focused ? 'exitFocus' : 'focus')}
        title={t(focus.focused ? 'exitFocus' : 'focus')} aria-pressed={focus.focused}
        onClick={() => focus.setFocused(!focus.focused)}>
        {focus.focused ? <Minimize2 className="size-4" aria-hidden="true" /> : <Maximize2 className="size-4" aria-hidden="true" />}
      </Button>}
      {actions}
    </div>
  </div>;
}

export function MarkdownRichMigration({ collaboration, filePath, onReady, onStart, onBusyChange, autoStart = false }: {
  collaboration: CollaborationDocument; filePath: string; onReady: () => void;
  onStart?: () => void; onBusyChange?: (busy: boolean) => void; autoStart?: boolean;
}) {
  const t = useTranslations('notebook.editorModes');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const running = useRef(false);
  const autoAttempted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const canStart = collaboration.connection === 'live' && collaboration.durability !== 'degraded';
  const migrate = useCallback(async () => {
    if (running.current || !canStart) return;
    running.current = true;
    setBusy(true); setBlocked(false);
    onBusyChange?.(true);
    let migrated = false;
    try {
      await collaboration.requestCheckpoint();
      collaboration.provider?.disconnect();
      for (let attempt = 0; attempt < 3 && !migrated; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 350));
        const response = await fetch('/api/files/collaboration/session', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders(collaboration.registryKey.split('\0')[0]) },
          body: JSON.stringify({ path: filePath, representation: 'auto', allowRichMigration: true,
            ...COLLABORATION_CLIENT_CAPABILITIES,
            expectedLifecycleGeneration: collaboration.session?.lifecycleGeneration }),
        });
        const result = await response.json();
        migrated = response.ok && result.success === true && result.representation === 'tiptap_blocks'
          && supportsBlockTreeCollaboration(result);
      }
      // Refresh the authoritative session even if the user switched back to Read.
      // The chosen mode belongs to the parent and must not be reset by this request.
      if (migrated) onReady(); else if (mounted.current) setBlocked(true);
    } catch { if (mounted.current) setBlocked(true); }
    finally {
      if (!migrated) collaboration.provider?.connect();
      running.current = false;
      onBusyChange?.(false);
      if (mounted.current) setBusy(false);
    }
  }, [canStart, collaboration, filePath, onReady, onBusyChange]);
  useEffect(() => {
    if (!autoStart || !canStart || autoAttempted.current) return;
    autoAttempted.current = true;
    void migrate();
  }, [autoStart, canStart, migrate]);
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
    <Button variant="outline" size="sm" disabled={busy || !canStart} onClick={() => {
      autoAttempted.current = true;
      onStart?.();
      void migrate();
    }}>{t(busy ? 'migrationBusy' : 'migration')}</Button>
    {blocked && <span role="status">{t('migrationBlocked')}</span>}
  </div>;
}

function download(content: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function MarkdownSaveState({ collaboration, content, available, filePath, onReload }: {
  collaboration: CollaborationDocument | null; content: string; available: boolean; filePath?: string; onReload?: () => void;
}) {
  const t = useTranslations('notebook');
  const recovery = useMarkdownRecoveryCopy(collaboration, filePath);
  const diagnostics = useSyncExternalStore(subscribeCollaborationDiagnostics, collaborationDiagnosticsEnabled, () => false);
  const issue = collaborationEditorIssue(collaboration, available);
  const diagnosticScope = `${collaboration?.session?.documentId}:${collaboration?.session?.lifecycleGeneration}:${issue ?? ''}:${collaboration?.clientState.failure?.code ?? ''}`;
  const loggedIssue = useRef<string | null>(null);
  useEffect(() => {
    if (!issue) { loggedIssue.current = null; return; }
    if (loggedIssue.current === diagnosticScope) return;
    loggedIssue.current = diagnosticScope;
    console.warn('[collaboration-editor]', { event: 'editor_attention', documentId: collaboration?.session?.documentId,
      generation: collaboration?.session?.lifecycleGeneration, kind: issue, code: collaboration?.clientState.failure?.code ?? null });
  }, [diagnosticScope, issue, collaboration?.session?.documentId, collaboration?.session?.lifecycleGeneration, collaboration?.clientState.failure?.code]);
  const failureKind = collaboration?.clientState.failure?.kind;
  const canRetry = collaboration?.connection === 'live' && collaboration.ready && recovery.canCreate
    && failureKind !== 'lifecycle' && failureKind !== 'authentication' && failureKind !== 'startup';
  const retryScope = useMemo(() => ({ document: recovery.actionScope, canRetry }), [recovery.actionScope, canRetry]);
  const activeRetry = useRef<{ scope: typeof retryScope; running: boolean } | null>(null);
  const [retryState, setRetryState] = useState<{ scope: typeof retryScope; busy: boolean; error: string | null } | null>(null);
  const checkpointRecovered = collaboration?.durability === 'checkpointed_file' || collaboration?.durability === 'persisted_yjs';
  if (retryState && retryState.scope !== retryScope) setRetryState(null);
  else if (checkpointRecovered && retryState?.error) setRetryState({ ...retryState, error: null });
  useLayoutEffect(() => {
    activeRetry.current = { scope: retryScope, running: false };
    return () => { if (activeRetry.current?.scope === retryScope) activeRetry.current = null; };
  }, [retryScope]);
  const retrying = retryState?.scope === retryScope && retryState.busy;
  const retryError = !checkpointRecovered && retryState?.scope === retryScope ? retryState.error : null;
  const blockHistory = collaboration?.session?.representation === 'tiptap_blocks' ? findBlockTreeHistory(collaboration.doc) : null;
  const subscribeHistory = useCallback((listener: () => void) => blockHistory?.subscribe(listener) ?? (() => {}), [blockHistory]);
  const historySnapshot = useCallback(() => blockHistory?.can('undo') ?? false, [blockHistory]);
  const hasLocalUndo = useSyncExternalStore(subscribeHistory, historySnapshot, () => false);
  const canCorrectStructure = collaboration?.ready && recovery.canCreate && hasLocalUndo
    && (failureKind === 'validation' || (!available && !failureKind));
  const correctionScope = useMemo(() => ({ document: recovery.actionScope, failureKind, canCorrectStructure }),
    [recovery.actionScope, failureKind, canCorrectStructure]);
  const activeCorrection = useRef<typeof correctionScope | null>(null);
  useLayoutEffect(() => {
    activeCorrection.current = correctionScope;
    return () => { if (activeCorrection.current === correctionScope) activeCorrection.current = null; };
  }, [correctionScope]);
  if (!collaboration) return null;
  const { connection, durability, clientState, session } = collaboration;
  const hydrated = clientState.indexedDbHydrated;
  const canExportMarkdown = hydrated && available;
  const error = collaboration.error || retryError || recovery.error;
  const blocked = durability === 'degraded' || connection === 'denied';
  if (!issue && !retryError && !recovery.error && !diagnostics) return null;
  const diagnostic = JSON.stringify({ documentId: session?.documentId, generation: session?.lifecycleGeneration,
    connection, durability, documentSequence: clientState.documentSequence,
    checkpointSequence: clientState.checkpointSequence, unsyncedChanges: clientState.unsyncedChanges,
    indexedDbHydrated: hydrated, remoteSynced: clientState.remoteSynced,
    failure: clientState.failure, projectionError: clientState.projectionError, error,
    retryError, recoveryError: recovery.error }, null, 2);
  return <aside className="absolute right-3 top-14 z-30 max-h-[calc(100%-4rem)] w-[min(28rem,calc(100%-1.5rem))] overflow-auto rounded-lg border bg-background p-3 text-xs shadow-lg" data-testid="markdown-save-state" aria-label={t(diagnostics ? 'editorModes.diagnostics' : 'editorModes.attention')}>
    {(issue || retryError || recovery.error) && <div className="space-y-2">
      <p role="alert" className="text-sm font-medium">{t(issue === 'unavailable' ? 'editorModes.unavailable' : `editorModes.failure.${issue ?? 'unknown'}`)}</p>
      {!hydrated ? <p>{t('editorModes.recoveryNotLoaded')}</p>
        : !collaboration.ready ? <p>{t('editorModes.recoveryLocalOnly')}</p>
          : issue === 'validation' || issue === 'unavailable' ? <p>{t('editorModes.recovery')}</p> : null}
      <div className="flex flex-wrap gap-2">
        {onReload && (issue === 'authentication' || issue === 'lifecycle' || issue === 'startup') && <Button variant="outline" size="sm" onClick={onReload}>{t('editorModes.reopen')}</Button>}
        {canCorrectStructure && <Button variant="outline" size="sm" disabled={retrying || recovery.busy} onClick={() => {
          if (!recovery.isCurrent() || activeCorrection.current !== correctionScope
            || activeRetry.current?.scope !== retryScope || activeRetry.current.running || recovery.busy) return;
          blockHistory?.undoLastLocalChange();
        }}>{t('editorModes.undoRecovery')}</Button>}
        {blocked && canExportMarkdown && recovery.canCreate && <Button
          variant="outline" size="sm" disabled={recovery.busy || retrying} onClick={() => void recovery.createCopy()}>
          {t(recovery.busy ? 'editorModes.recoveringCopy' : 'editorModes.recoverCopy')}</Button>}
        {canExportMarkdown && <Button variant="outline" size="sm" onClick={() => download(content, filePath?.split('/').pop() || 'document.md', 'text/markdown;charset=utf-8')}>
          <Download className="size-3.5" />{t('editorModes.backup')}
        </Button>}
        {hydrated && <Button variant="outline" size="sm" onClick={() => {
          const snapshot = new Uint8Array(Y.encodeStateAsUpdate(collaboration.doc));
          download(snapshot, 'canvas-recovery.yjs', 'application/octet-stream');
          recordExportedCollaborationRecovery(collaboration.doc, snapshot);
        }}>
          {t('editorModes.snapshot')}
        </Button>}
        {canRetry && <Button variant="outline" size="sm" disabled={retrying || recovery.busy} onClick={async () => {
          if (activeRetry.current?.scope !== retryScope || activeRetry.current.running) return;
          activeRetry.current.running = true;
          setRetryState({ scope: retryScope, busy: true, error: null });
          try { await collaboration.requestCheckpoint(); }
          catch (failure) {
            if (activeRetry.current?.scope === retryScope) setRetryState({ scope: retryScope, busy: true,
              error: failure instanceof Error ? failure.message : String(failure) });
          } finally {
            if (activeRetry.current?.scope === retryScope) {
              activeRetry.current.running = false;
              setRetryState((previous) => previous?.scope === retryScope ? { ...previous, busy: false } : previous);
            }
          }
        }}>{t('editorModes.retry')}</Button>}
      </div>
      {retryError && <p role="alert">{t('editorModes.retryFailed')}</p>}
      {recovery.error && <p role="alert">{t('editorModes.recoveryFailed')}</p>}
      {recovery.copyPath && <p role="status">{t('editorModes.recoveryCopyChanged', { path: recovery.copyPath })}</p>}
    </div>}
    {diagnostics && <details className="mt-2" open><summary className="cursor-pointer">{t('editorModes.diagnostics')}</summary>
      <pre className="mt-2 select-text overflow-auto whitespace-pre-wrap rounded border p-2">{diagnostic}</pre>
    </details>}
  </aside>;
}
