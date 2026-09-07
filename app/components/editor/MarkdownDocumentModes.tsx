'use client';

import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Code2, Eye, Pencil, Maximize2, Minimize2, MoveHorizontal } from 'lucide-react';
import { NotebookFocusContext } from '@/app/components/notebook/NotebookFocusContext';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import { Button } from '@/components/ui/button';
import type { CollaborationDocument } from '@/app/lib/collaboration/client';
import { workspaceHeaders, writeWorkspaceFile } from '@/app/lib/files/client';
import { recordExportedCollaborationRecovery } from '@/app/lib/collaboration/local-recovery';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { createRichMarkdownManager, restoreRichMarkdownFinalLineEnding } from '@/app/lib/markdown/rich-markdown-codec';

export type MarkdownDocumentMode = 'read' | 'rich' | 'source';

/** Observe the authoritative document even when its editor is not mounted. */
function createLiveMarkdownStore(doc: Y.Doc | undefined, representation: string | undefined, fallback: string) {
  let cached: { content: string; available: boolean } | undefined;
  const manager = representation === 'tiptap_xml' ? createRichMarkdownManager() : null;
  return {
    subscribe(listener: () => void) {
      const update = () => { cached = undefined; listener(); };
      doc?.on('update', update);
      return () => doc?.off('update', update);
    },
    snapshot() {
      if (cached) return cached;
      try {
        const content = !doc ? fallback : representation === 'plain_text'
          ? doc.getText('content').toString()
          : doc.getText('frontmatter').toString() + restoreRichMarkdownFinalLineEnding(
            doc.getText('bodyFinalLineEnding').toString(),
            manager!.serialize(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('body'))),
          );
        cached = { content, available: true };
      } catch { cached = { content: '', available: false }; }
      return cached;
    },
  };
}

export function useLiveMarkdown(collaboration: CollaborationDocument | null, fallback: string) {
  const doc = collaboration?.doc;
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
            expectedLifecycleGeneration: collaboration.session?.lifecycleGeneration }),
        });
        const result = await response.json();
        migrated = response.ok && result.success === true && result.representation === 'tiptap_xml';
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

export function MarkdownSaveState({ collaboration, content, available, filePath }: {
  collaboration: CollaborationDocument | null; content: string; available: boolean; filePath?: string;
}) {
  const t = useTranslations('notebook');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  if (!collaboration) return null;
  const { connection, durability, clientState, session } = collaboration;
  const error = collaboration.error || retryError;
  const blocked = durability === 'degraded' || connection === 'denied';
  const connectionKey = connection === 'live' ? 'connected' : connection === 'read_only' ? 'readOnly'
    : connection === 'offline' ? 'offline' : connection === 'denied' ? 'denied' : 'connecting';
  const durabilityKey = durability === 'checkpointed_file' ? 'checkpointedFile'
    : durability === 'persisted_yjs' ? 'persistedYjs' : durability === 'local_pending' ? 'localPending'
      : durability === 'checkpoint_pending' ? 'checkpointPending' : 'serverReceived';
  const diagnostic = JSON.stringify({ documentId: session?.documentId, generation: session?.lifecycleGeneration,
    connection, durability, documentSequence: clientState.documentSequence,
    checkpointSequence: clientState.checkpointSequence, unsyncedChanges: clientState.unsyncedChanges, error }, null, 2);
  return <div className="shrink-0 border-b px-3 py-2 text-xs" data-testid="markdown-save-state">
    <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
      <span>{connectionKey === 'connected' ? t('editorModes.connected') : t(`collaboration.${connectionKey}`)}</span><span aria-hidden="true">·</span>
      <span>{blocked ? t('editorModes.saveBlocked') : t(`collaboration.${durabilityKey}`)}</span>
    </div>
    {(error || blocked || !available) && <div className="mt-2 space-y-2">
      <p role="alert">{t('editorModes.recovery')}</p>
      <div className="flex flex-wrap gap-2">
        {blocked && available && filePath && session?.permission === 'write' && workspaceId
          && collaboration.registryKey.startsWith(`${workspaceId}\0`) && <Button
          variant="outline" size="sm" disabled={recovering} onClick={async () => {
            const copyPath = filePath.replace(/(\.[^/.]+)?$/u, `.recovered-${crypto.randomUUID()}$1`);
            setRecovering(true); setRetryError(null);
            try {
              await writeWorkspaceFile(copyPath, content, { workspaceId, expectedSha256: null, baseRevisionId: null });
              if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
                const opened = await useFileStore.getState().revealAndLoadFile(copyPath, { workspaceId });
                if (opened.status === 'failed') throw new Error(opened.error);
              }
            } catch (failure) { setRetryError(failure instanceof Error ? failure.message : String(failure)); }
            finally { setRecovering(false); }
          }}>{t(recovering ? 'editorModes.recoveringCopy' : 'editorModes.recoverCopy')}</Button>}
        {available && <Button variant="outline" size="sm" onClick={() => download(content, filePath?.split('/').pop() || 'document.md', 'text/markdown;charset=utf-8')}>
          <Download className="size-3.5" />{t('editorModes.backup')}
        </Button>}
        <Button variant="outline" size="sm" onClick={() => {
          const snapshot = new Uint8Array(Y.encodeStateAsUpdate(collaboration.doc));
          download(snapshot, 'canvas-recovery.yjs', 'application/octet-stream');
          recordExportedCollaborationRecovery(collaboration.doc, snapshot);
        }}>
          {t('editorModes.snapshot')}
        </Button>
        {!blocked && connection === 'live' && session?.permission === 'write' && <Button variant="outline" size="sm" disabled={retrying} onClick={async () => {
          setRetrying(true); setRetryError(null);
          try { await collaboration.requestCheckpoint(); } catch (failure) { setRetryError(String(failure)); }
          finally { setRetrying(false); }
        }}>{t('editorModes.retry')}</Button>}
      </div>
      {retryError && <p role="alert">{retryError}</p>}
      <details><summary className="cursor-pointer">{t('editorModes.diagnostics')}</summary>
        <pre className="mt-2 select-text overflow-auto whitespace-pre-wrap rounded border p-2">{diagnostic}</pre>
      </details>
    </div>}
  </div>;
}
