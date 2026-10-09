'use client';

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Code2, Eye, Pencil, Maximize2, Minimize2, MoveHorizontal } from 'lucide-react';
import { collaborationDiagnosticsEnabled, collaborationEditorIssue, subscribeCollaborationDiagnostics } from '@/app/lib/collaboration/editor-presentation';
import { NotebookFocusContext } from '@/app/components/notebook/NotebookFocusContext';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { Button } from '@/components/ui/button';
import type { CollaborationDocument } from '@/app/lib/collaboration/client';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { workspaceHeaders } from '@/app/lib/files/client';
import { recordExportedCollaborationRecovery } from '@/app/lib/collaboration/local-recovery';
import { useMarkdownRecoveryCopy } from '@/app/lib/collaboration/markdown-recovery-client';
import { findBlockTreeHistory } from '@/app/lib/collaboration/block-tree-history';
import { BLOCK_TREE_KEY } from '@/app/lib/collaboration/block-tree';
import { createRichMarkdownManager, restoreRichMarkdownFinalLineEnding, richMarkdownCodecExtensions } from '@/app/lib/markdown/rich-markdown-codec';
import { equivalentRichDocument } from '@/app/lib/markdown/core/equivalence';
import { composeCanvasMarkdownDocument, splitCanvasMarkdownForRichEditor } from '@/app/lib/markdown/obsidian-metadata';
import { readRichDocumentJson } from '@/app/lib/collaboration/rich-document';
import { COLLABORATION_CLIENT_CAPABILITIES, isRichTextCollaborationRepresentation, supportsBlockTreeCollaboration } from '@/app/lib/collaboration/types';

export type MarkdownDocumentMode = 'read' | 'rich' | 'source';

/** Observe the authoritative document even when its editor is not mounted. */
function createLiveMarkdownStore(doc: Y.Doc | undefined, representation: string | undefined, fallback: string) {
  let cached: { content: string; available: boolean; isLossless: () => boolean } | undefined;
  const manager = isRichTextCollaborationRepresentation(representation) ? createRichMarkdownManager() : null;
  const unavailable = () => ({ content: '', available: false, isLossless: () => false });
  return {
    subscribe(listener: () => void) {
      const update = () => { cached = undefined; listener(); };
      doc?.on('update', update);
      // React rechecks after subscribing; include updates received since render.
      cached = undefined;
      return () => doc?.off('update', update);
    },
    snapshot() {
      if (cached) return cached;
      // A first visit can hydrate an empty IndexedDB before the remote root
      // arrives. Reading it as legacy XML would create a competing body root
      // and make the subsequently received block tree unrenderable.
      if (doc && representation === 'tiptap_blocks' && !doc.share.has(BLOCK_TREE_KEY)) {
        return (cached = unavailable());
      }
      try {
        const richJson = doc && manager ? readRichDocumentJson(doc) : null;
        const content = !doc ? fallback : representation === 'plain_text'
          ? doc.getText('content').toString()
          : doc.getText('frontmatter').toString() + restoreRichMarkdownFinalLineEnding(
            doc.getText('bodyFinalLineEnding').toString(),
            manager!.serialize(richJson!),
          );
        let lossless: boolean | undefined;
        cached = { content, available: true, isLossless: () => {
          if (!richJson || !manager) return true;
          if (lossless !== undefined) return lossless;
          // Validate the derived view on demand, never inside the native input
          // transaction. Cache the answer for this exact serialized snapshot.
          try {
            const parts = splitCanvasMarkdownForRichEditor(content);
            const parsed = getSchema(richMarkdownCodecExtensions()).nodeFromJSON(manager.parse(parts.body));
            parsed.check();
            const roundtrip = composeCanvasMarkdownDocument(parts.prefix,
              restoreRichMarkdownFinalLineEnding(parts.body, manager.serialize(parsed.toJSON())));
            return (lossless = roundtrip === content && equivalentRichDocument(richJson, parsed.toJSON()));
          } catch { return (lossless = false); }
        } };
      } catch { cached = unavailable(); }
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

export function MarkdownModeBar({ mode, onChange, readOnly, sourceAvailable = true, wide, onWideChange, documentControls = true, actions }: {
  mode: MarkdownDocumentMode; onChange: (mode: MarkdownDocumentMode) => void; readOnly: boolean;
  sourceAvailable?: boolean;
  wide: boolean; onWideChange: (wide: boolean) => void;
  documentControls?: boolean; actions?: ReactNode;
}) {
  const t = useTranslations('notebook.editorModes');
  const focus = useContext(NotebookFocusContext);
  return <div className="markdown-mode-bar flex shrink-0 items-center gap-1 border-b bg-background px-3 py-1.5" role="group" aria-label={t('label')}>
    {([{ mode: 'read', icon: Eye }, { mode: 'rich', icon: Pencil }, { mode: 'source', icon: Code2 }] as const)
      .filter((item) => item.mode !== 'source' || sourceAvailable).map((item) =>
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

export function MarkdownSaveState({ collaboration, content, available, isSourceLossless, filePath, onReload, placement = 'overlay' }: {
  collaboration: CollaborationDocument | null; content: string; available: boolean; isSourceLossless?: () => boolean;
  filePath?: string; onReload?: () => void; placement?: 'overlay' | 'inline';
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
  const locationRequest = collaboration?.requestLocationRevalidation;
  const locationAvailable = Boolean(locationRequest && (collaboration?.canRevalidateLocation || collaboration?.revalidatingLocation));
  const locationFile = useFileStore((state) => state.currentFile);
  const locationFileWorkspace = useFileStore((state) => state.currentFileWorkspaceId);
  const locationTreeGeneration = useFileStore((state) => state.treeGeneration);
  const locationWorkspace = useWorkspaceStore((state) => state.activeWorkspaceId);
  const locationSession = collaboration?.session;
  const locationWorkspaceOwner = locationSession?.guestAccess ? null : locationWorkspace;
  const locationFileOwner = locationSession?.guestAccess ? null : locationFile;
  const locationFileWorkspaceOwner = locationSession?.guestAccess ? null : locationFileWorkspace;
  const locationTreeOwner = locationSession?.guestAccess ? null : locationTreeGeneration;
  // Provider/session refreshes may change the callback, permission and denied
  // state while one reconnect is pending. Only the open document owns its result.
  const locationScope = useMemo(() => ({ doc: collaboration?.doc, registryKey: collaboration?.registryKey,
    documentId: locationSession?.documentId, documentName: locationSession?.documentName,
    generation: locationSession?.lifecycleGeneration, representation: locationSession?.representation,
    schemaVersion: locationSession?.schemaVersion, richTextSchemaVersion: locationSession?.richTextSchemaVersion,
    blockTreeFormatVersion: locationSession?.blockTreeFormatVersion, userId: locationSession?.user.id,
    guestId: locationSession?.guestAccess?.invitationId, guestWorkspace: locationSession?.guestAccess?.workspaceId,
    workspaceId: locationWorkspaceOwner, fileWorkspaceId: locationFileWorkspaceOwner, treeGeneration: locationTreeOwner,
    editorIdentity: locationFileOwner?.editorIdentity, openedPath: locationFileOwner?.path, filePath,
  }), [collaboration?.doc, collaboration?.registryKey, locationSession?.documentId, locationSession?.documentName,
    locationSession?.lifecycleGeneration, locationSession?.representation, locationSession?.schemaVersion,
    locationSession?.richTextSchemaVersion, locationSession?.blockTreeFormatVersion, locationSession?.user.id,
    locationSession?.guestAccess?.invitationId, locationSession?.guestAccess?.workspaceId,
    locationWorkspaceOwner, locationFileWorkspaceOwner, locationTreeOwner, locationFileOwner?.editorIdentity, locationFileOwner?.path, filePath]);
  const activeLocationRequest = useRef<{ scope: typeof locationScope; running: boolean; allowed: boolean;
    request: typeof locationRequest } | null>(null);
  const [locationState, setLocationState] = useState<{ scope: typeof locationScope; busy: boolean; error: boolean } | null>(null);
  const locationRecovered = !collaboration?.clientState.failure
    && (collaboration?.durability === 'checkpointed_file' || collaboration?.durability === 'persisted_yjs');
  if (locationState && locationState.scope !== locationScope) setLocationState(null);
  else if (locationRecovered && locationState?.error) setLocationState({ ...locationState, error: false });
  useLayoutEffect(() => {
    activeLocationRequest.current = { scope: locationScope, running: false, allowed: false, request: undefined };
    return () => { if (activeLocationRequest.current?.scope === locationScope) activeLocationRequest.current = null; };
  }, [locationScope]);
  useLayoutEffect(() => {
    if (activeLocationRequest.current?.scope !== locationScope) return;
    activeLocationRequest.current.request = locationRequest;
    activeLocationRequest.current.allowed =
      collaboration?.canRevalidateLocation === true && !collaboration.revalidatingLocation && !recovery.busy;
  }, [locationScope, locationRequest, collaboration?.canRevalidateLocation, collaboration?.revalidatingLocation, recovery.busy]);
  const isLocationCurrent = () => {
    if (activeLocationRequest.current?.scope !== locationScope || !locationScope.doc || locationScope.doc.isDestroyed
      || !filePath || !locationScope.documentId) return false;
    if (locationScope.guestId) return Boolean(locationScope.guestWorkspace
      && locationScope.registryKey?.startsWith(`${locationScope.guestWorkspace}\0`));
    const current = useFileStore.getState();
    return Boolean(locationScope.workspaceId && locationScope.fileWorkspaceId === locationScope.workspaceId
      && locationScope.registryKey?.startsWith(`${locationScope.workspaceId}\0`)
      && useWorkspaceStore.getState().activeWorkspaceId === locationScope.workspaceId
      && current.currentFileWorkspaceId === locationScope.workspaceId && current.treeGeneration === locationScope.treeGeneration
      && current.currentFile?.path === filePath && current.currentFile.editorIdentity === locationScope.editorIdentity
      && !current.currentFile.unavailable && current.currentFile.collaboration?.crdtCapable
      && (!current.currentFile.collaboration.document?.id || current.currentFile.collaboration.document.id === locationScope.documentId));
  };
  const locationBusy = Boolean(collaboration?.revalidatingLocation || locationState?.scope === locationScope && locationState.busy);
  const locationError = !locationRecovered && locationState?.scope === locationScope && locationState.error;
  const showLocationAction = Boolean(locationRequest && (locationAvailable || locationBusy));
  const canRetry = collaboration?.connection === 'live' && collaboration.ready && recovery.canCreate
    && !showLocationAction && failureKind !== 'lifecycle' && failureKind !== 'authentication' && failureKind !== 'startup';
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
  const error = collaboration.error || retryError || recovery.error || (locationError ? t('editorModes.locationRevalidationFailed') : null);
  const blocked = durability === 'degraded' || connection === 'denied';
  if (!issue && !retryError && !recovery.error && !diagnostics && !showLocationAction && !locationError) return null;
  const canExportMarkdown = hydrated && available && (isSourceLossless?.() ?? true);
  const diagnostic = JSON.stringify({ documentId: session?.documentId, generation: session?.lifecycleGeneration,
    connection, durability, documentSequence: clientState.documentSequence,
    checkpointSequence: clientState.checkpointSequence, unsyncedChanges: clientState.unsyncedChanges,
    indexedDbHydrated: hydrated, remoteSynced: clientState.remoteSynced,
    failure: clientState.failure, projectionError: clientState.projectionError, error,
    retryError, recoveryError: recovery.error, revalidatingLocation: locationBusy, locationRevalidationFailed: Boolean(locationError) }, null, 2);
  return <aside className={`${placement === 'inline'
    ? 'relative mx-3 my-3 max-h-[40%] w-auto shrink-0'
    : 'absolute right-3 top-14 z-30 max-h-[calc(100%-4rem)] w-[min(28rem,calc(100%-1.5rem))]'} overflow-auto rounded-lg border bg-background p-3 text-xs shadow-lg`} data-testid="markdown-save-state" aria-label={t(diagnostics ? 'editorModes.diagnostics' : 'editorModes.attention')}>
    {(issue || retryError || recovery.error || showLocationAction || locationError) && <div className="space-y-2">
      {(issue || retryError || recovery.error || locationError) && <p role="alert" className="text-sm font-medium">{t(issue === 'unavailable' ? 'editorModes.unavailable' : `editorModes.failure.${issue ?? 'unknown'}`)}</p>}
      {!hydrated ? <p>{t('editorModes.recoveryNotLoaded')}</p>
        : !collaboration.ready ? <p>{t('editorModes.recoveryLocalOnly')}</p>
          : issue === 'validation' || issue === 'unavailable' ? <p>{t('editorModes.recovery')}</p> : null}
      <div className="flex flex-wrap gap-2">
        {showLocationAction && <Button variant="outline" size="sm" data-testid="markdown-location-revalidation"
          disabled={locationBusy || recovery.busy || collaboration.canRevalidateLocation !== true} onClick={async () => {
            const active = activeLocationRequest.current;
            if (!isLocationCurrent() || active?.scope !== locationScope || active.running || !active.allowed || !active.request) return;
            active.running = true;
            setLocationState({ scope: locationScope, busy: true, error: false });
            try { await active.request(); }
            catch {
              if (isLocationCurrent()) {
                setLocationState({ scope: locationScope, busy: true, error: true });
              }
            } finally {
              if (activeLocationRequest.current?.scope === locationScope) {
                activeLocationRequest.current.running = false;
                setLocationState((previous) => previous?.scope === locationScope ? { ...previous, busy: false } : previous);
              }
            }
          }}>{t(locationBusy ? 'editorModes.revalidatingLocation' : 'editorModes.revalidateLocation')}</Button>}
        {onReload && !showLocationAction && (issue === 'authentication' || issue === 'lifecycle' || issue === 'startup') && <Button variant="outline" size="sm" onClick={onReload}>{t('editorModes.reopen')}</Button>}
        {canCorrectStructure && <Button variant="outline" size="sm" disabled={retrying || recovery.busy || locationBusy} onClick={() => {
          if (!recovery.isCurrent() || activeCorrection.current !== correctionScope
            || activeRetry.current?.scope !== retryScope || activeRetry.current.running || recovery.busy) return;
          blockHistory?.undoLastLocalChange();
        }}>{t('editorModes.undoRecovery')}</Button>}
        {blocked && canExportMarkdown && recovery.canCreate && <Button
          variant="outline" size="sm" disabled={recovery.busy || retrying || locationBusy} onClick={() => void recovery.createCopy()}>
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
      {locationError && <p role="alert" data-testid="markdown-location-revalidation-error">{t('editorModes.locationRevalidationFailed')}</p>}
      {recovery.error && <p role="alert">{t('editorModes.recoveryFailed')}</p>}
      {recovery.copyPath && <p role="status">{t('editorModes.recoveryCopyChanged', { path: recovery.copyPath })}</p>}
    </div>}
    {diagnostics && <details className="mt-2" open><summary className="cursor-pointer">{t('editorModes.diagnostics')}</summary>
      <pre className="mt-2 select-text overflow-auto whitespace-pre-wrap rounded border p-2">{diagnostic}</pre>
    </details>}
  </aside>;
}
