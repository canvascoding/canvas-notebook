'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Document as OfficeDocument } from '@eigenpal/docx-js-editor/core';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { workspaceHeaders } from '@/app/lib/files/client';
import { registerDocumentTransitionGuard } from '@/app/lib/files/document-transition';
import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
import { createDocxClient, docxBase64ToBytes, docxBytesToBase64 } from '@/app/lib/office/docx-client';
import { createDocxRecoveryStore, type DocxRecoveryRecord } from '@/app/lib/office/docx-recovery';
import { DocxSaveSession, type DocxSaveState } from '@/app/lib/office/docx-save-session';
import { serializeDocxForEditor } from '@/app/lib/office/serialize-docx-for-editor';
import { useEditorStore } from '@/app/store/editor-store';
import { useFileStore } from '@/app/store/file-store';
import { DocxEditorWrapper } from './DocxEditor';

type Version = { contentHash: string; createdAt: number; status: string };
type History = { lineageId: string | null; lineages: { id: string; status: 'active' | 'archived'; createdAt: number }[]; versions: Version[] };

function downloadBytes(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function DocxWorkspaceEditor({ path, workspaceId }: { path: string; workspaceId: string | null }) {
  const t = useTranslations('officeDocx');
  const sessionRef = useRef<DocxSaveSession<OfficeDocument> | null>(null);
  const recoveryStore = useRef(createDocxRecoveryStore<OfficeDocument>());
  const [documentSeed, setDocumentSeed] = useState<OfficeDocument | null>(null);
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const [state, setState] = useState<DocxSaveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [compatibility, setCompatibility] = useState<string[] | null>(null);
  const [recovery, setRecovery] = useState<DocxRecoveryRecord<OfficeDocument> | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [history, setHistory] = useState<History | null>(null);
  const lifecycleRef = useRef(0);

  useEffect(() => {
    if (!workspaceId) return;
    const lifecycle = ++lifecycleRef.current;
    let active = true;
    let controller: DocxSaveSession<OfficeDocument> | null = null;
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const client = createDocxClient({ workspaceId, workspaceHeaders: workspaceHeaders(workspaceId) });
    const current = () => active && lifecycleRef.current === lifecycle;
    const unregister = registerDocumentTransitionGuard(workspaceId, path, {
      hasPendingChanges: () => controller?.getState().pending ?? false,
      prepare: async () => { if (controller) await controller.flush(); },
    });
    const synchronize = (next: DocxSaveState) => {
      if (!current()) return;
      setState(next);
      const file = useFileStore.getState();
      if (file.currentFileWorkspaceId !== workspaceId || file.currentFile?.path !== path) return;
      const previous = useEditorStore.getState();
      useEditorStore.setState({ isDirty: next.dirty, isSaving: next.saving,
        saveError: next.error?.message ?? next.recoveryError?.message ?? null,
        ...(!next.dirty && previous.isDirty ? { lastSavedAt: Date.now() } : {}),
      });
    };
    void (async () => {
      try {
        const loaded = await client.read(path, abort.signal);
        const { parseDocx } = await import('@eigenpal/docx-js-editor/core');
        const document = await parseDocx(loaded.bytes);
        if (!current()) return;
        setDocumentSeed(document);
        setError(null); setNotice(null); setExternalChange(false); setState(null); setHistory(null);
        useEditorStore.getState().setActiveFile(path, '');
        if (!loaded.editorCompatibility?.editable) {
          setCompatibility(loaded.editorCompatibility?.reasons ?? []);
          return;
        }
        setCompatibility(null);
        controller = new DocxSaveSession({
          identity: { accountId: loaded.accountId, workspaceId, path, lineageId: loaded.lineageId, sessionId: crypto.randomUUID() },
          baseline: loaded.baseline, originalBytes: loaded.bytes, initialDocument: document,
          serialize: serializeDocxForEditor, client, recovery: recoveryStore.current, onState: synchronize,
        });
        sessionRef.current = controller;
        const retained = await controller.getRecovery();
        if (!current()) return;
        setRecovery(retained);
        await controller.start();
      } catch (failure) {
        if (current()) setError(failure instanceof Error ? failure.message : 'Could not open the Word document.');
      }
    })();
    const watcher = getFileWatcherClient();
    watcher.acquire();
    const checkExternal = async () => {
      if (!current() || !controller) return;
      if (controller.getState().saving) { watchTimer = setTimeout(() => void checkExternal(), 500); return; }
      if (controller.getState().error) return;
      try {
        const latest = await client.read(path, abort.signal);
        if (current() && latest.baseline.sha256 !== controller.getBaseline().sha256) setExternalChange(true);
      } catch { /* Save/lease errors keep the draft; a watcher must never replace it. */ }
    };
    const onFile = (event: Event) => {
      const detail = (event as CustomEvent<FileEvent>).detail;
      if (!detail || (detail.workspaceId && detail.workspaceId !== workspaceId)) return;
      if (detail.relativePath !== path && detail.path !== path) return;
      if (detail.type === 'unlink') { if (current()) setExternalChange(true); return; }
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => void checkExternal(), 800);
    };
    watcher.addEventListener('filechange', onFile);
    return () => {
      active = false; abort.abort(); unregister();
      lifecycleRef.current = lifecycle + 1;
      if (watchTimer) clearTimeout(watchTimer);
      watcher.removeEventListener('filechange', onFile); watcher.releaseConnection();
      controller?.dispose();
      if (sessionRef.current === controller) sessionRef.current = null;
    };
  }, [workspaceId, path, reload]);

  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault(); event.stopImmediatePropagation();
      const controller = sessionRef.current;
      void controller?.flush().catch((failure) => { if (sessionRef.current === controller) setError(failure.message); });
    };
    window.addEventListener('keydown', save, true);
    return () => window.removeEventListener('keydown', save, true);
  }, []);

  const run = async (operation: () => Promise<void>) => {
    const lifecycle = lifecycleRef.current;
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); } catch (failure) {
      if (lifecycleRef.current === lifecycle) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (lifecycleRef.current === lifecycle) setBusy(false); }
  };
  const saveCopy = async () => {
    const session = sessionRef.current;
    if (!session || !workspaceId) return;
    const bytes = await session.exportCopy();
    const copyPath = path.replace(/\.docx$/i, ` (${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}).docx`);
    const response = await fetch('/api/files/write', { method: 'POST', credentials: 'same-origin',
      headers: { ...workspaceHeaders(workspaceId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: copyPath, content: docxBytesToBase64(bytes), createOnly: true, sessionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error ?? 'Could not save the document copy.');
    if (sessionRef.current === session) setNotice(t('copySaved', { path: copyPath }));
  };
  const downloadVersion = async (version: Version) => {
    if (!workspaceId) return;
    const lifecycle = lifecycleRef.current;
    const response = await fetch(`/api/files/office/versions?path=${encodeURIComponent(path)}&contentHash=${version.contentHash}&lineageId=${encodeURIComponent(history?.lineageId ?? '')}`, { headers: workspaceHeaders(workspaceId), cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error ?? 'Could not recover the version.');
    if (lifecycle === lifecycleRef.current) downloadBytes(docxBase64ToBytes(result.data.content), path.split('/').pop() ?? 'document.docx');
  };
  const reopen = async () => {
    const lifecycle = lifecycleRef.current;
    const controller = sessionRef.current;
    const snapshot = controller?.getState();
    if (controller && snapshot && snapshot.generation > snapshot.savedGeneration) await controller.preserveDraft();
    if (lifecycle !== lifecycleRef.current) return;
    controller?.dispose(); sessionRef.current = null;
    setRecovery(null); setState(null); setError(null); setNotice(null);
    setCompatibility(null); setExternalChange(false); setHistory(null);
    setDocumentSeed(null); setReload(value => value + 1);
  };
  const readOnly = !state || state.readOnly || !!compatibility || externalChange;
  const status = state?.saving ? 'saving' : state?.error || state?.recoveryError ? 'paused' : readOnly ? 'readOnly' : state.dirty ? 'pending' : 'saved';
  const loadHistory = async (lineageId?: string) => {
    if (!workspaceId) return;
    const lifecycle = lifecycleRef.current;
    const result = await createDocxClient({ workspaceId, workspaceHeaders: workspaceHeaders(workspaceId) }).versions(path, undefined, lineageId) as History;
    if (lifecycle === lifecycleRef.current) setHistory({ ...result, versions: result.versions.slice(0, 100) });
  };
  const historyPanel = history && <div className="max-h-48 shrink-0 overflow-auto border-b px-3 py-2 text-xs">
    <div className="flex justify-between"><span>{t('versionsHint')}</span><Button size="sm" variant="ghost" onClick={() => setHistory(null)}>{t('close')}</Button></div>
    {history.lineages.length > 1 && <select aria-label={t('historySelection')} disabled={busy} value={history.lineageId ?? ''} onChange={event => void run(() => loadHistory(event.target.value))} className="my-2 rounded border bg-background px-2 py-1">
      {history.lineages.map(lineage => <option key={lineage.id} value={lineage.id}>{t(lineage.status === 'active' ? 'currentDocument' : 'previousDocument')} · {new Date(lineage.createdAt).toLocaleString()}</option>)}
    </select>}
    {history.versions.length === 0 && <p>{t('noVersions')}</p>}
    {history.versions.map((version, index) => <button key={`${version.contentHash}:${version.createdAt}:${index}`} disabled={busy} className="block py-1 underline" onClick={() => void run(() => downloadVersion(version))}>{new Date(version.createdAt).toLocaleString()} · {version.contentHash.slice(0, 8)}</button>)}
  </div>;

  if (!workspaceId) return <div className="p-4 text-sm">{t('workspaceMissing')}</div>;
  if (!documentSeed) return <div className="flex h-full flex-col gap-2 p-4 text-sm">{error || history ? <><p>{error ?? t('openFailed')}</p><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => void run(reopen)}>{t('retry')}</Button><Button variant="outline" disabled={busy} onClick={() => void run(() => loadHistory())}>{t('versions')}</Button></div>{historyPanel}</> : <div className="flex items-center justify-center gap-2"><Loader2 className="h-5 w-5 animate-spin" />{t('loading')}</div>}</div>;
  return <div className="flex h-full min-h-0 flex-col" data-testid="docx-workspace-editor">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2 text-xs">
      <span role="status" aria-live="polite" data-testid="docx-save-status" className="mr-auto">{t(status)}</span>
      {state && <Button size="sm" variant="outline" disabled={busy || state.saving || readOnly} onClick={() => void run(() => sessionRef.current!.flush())}>{t('save')}</Button>}
      {state && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(saveCopy)}>{t('saveCopy')}</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => loadHistory())}>{t('versions')}</Button>
    </div>
    {(error || state?.error || state?.recoveryError || compatibility || externalChange || notice) && <div className="space-y-2 border-b bg-muted/40 px-3 py-2 text-sm" role="alert">
      {compatibility && <p>{t('unsupported')} {compatibility.join(' ')}</p>}
      {(error || state?.error) && <p>{error ?? state?.error?.message}</p>}
      {state?.recoveryError && <p>{t('recoveryFailed')} {state.recoveryError.message}</p>}
      {externalChange && <p>{t('externalChange')}</p>}
      {notice && <p>{notice}</p>}
      {!compatibility && (error || state?.error || state?.recoveryError) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
        const controller = sessionRef.current;
        if (!controller || (!controller.getState().leaseExpiresAt && controller.getState().generation === 0)) await reopen();
        else await controller.retry();
      })}>{t('retry')}</Button>}
      {(externalChange || state?.readOnly) && <Button size="sm" variant="ghost" disabled={busy || state?.saving} onClick={() => void run(reopen)}>{t(state?.pending ? 'reloadKeepDraft' : 'reload')}</Button>}
      {state?.dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
        const bytes = await sessionRef.current!.exportCopy(); downloadBytes(bytes, path.split('/').pop() ?? 'recovery.docx');
      })}>{t('downloadDraft')}</Button>}
    </div>}
    {recovery && <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
      <span className="mr-auto">{t('recoveryAvailable')}</span>
      <Button size="sm" variant="outline" disabled={busy || state?.dirty} onClick={() => void run(async () => {
        const controller = sessionRef.current!;
        const document = await controller.restoreRecovery(recovery);
        if (sessionRef.current === controller) { setDocumentSeed(document); setDocumentGeneration(value => value + 1); setRecovery(null); }
      })}>{t('recover')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
        const lifecycle = lifecycleRef.current;
        await recoveryStore.current.discard(recovery);
        if (lifecycle === lifecycleRef.current) setRecovery(null);
      })}>{t('discardRecovery')}</Button>
    </div>}
    {historyPanel}
    <div className="min-h-0 flex-1"><DocxEditorWrapper key={documentGeneration} path={path} document={documentSeed} mode={readOnly ? 'viewing' : 'editing'} onSaveRequest={() => {
      const controller = sessionRef.current;
      void controller?.flush().catch((failure) => { if (sessionRef.current === controller) setError(failure.message); });
    }} onChange={(document) => {
      const controller = sessionRef.current;
      if (!controller || readOnly) return;
      try { controller.change(document); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    }} /></div>
  </div>;
}
