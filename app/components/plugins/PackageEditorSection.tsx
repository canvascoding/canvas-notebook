'use client';

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, FileCode2, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { InlineNotice } from '@/components/ui/inline-notice';
import type { CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackageFileRead,
  CapabilityPackageOwnedDraftStatus, CapabilityPackagePublishedRevision, CapabilityPackageTreeEntry, CapabilityPackageValidation } from '@/app/lib/capabilities/packages/contracts';
import { usePluginEditorNavigationGuard } from './plugin-navigation-guard';
import { PluginExtensionAvatar } from './PluginExtensionAvatar';

type ScopeChoice = { type: 'user' | 'organization' | 'team'; workspaceId?: string; label: string };
type VersionSummary = Pick<CapabilityPackagePublishedRevision, 'revisionRef' | 'version' | 'publishedAt'>;
type DraftView = { draft: CapabilityPackageDraft; target: { ownership: CapabilityResourceOwnerScope;
  expectedMetadataRevision: number; expectedGrantsRevision: number } };
type FileView = { file: CapabilityPackageFileRead; text: string | null };
type OwnedDraftStatus = CapabilityPackageOwnedDraftStatus;
type PackageEditorProps = {
  resourceRef: string; workspaceId?: string | null; onUpdated?: () => void;
  initialDraftRef?: string; initiallyOpen?: boolean; initialFile?: string;
};
type ApiPayload<T> = { success: boolean; data?: T; code?: string };
class PackageRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
function textContent(file: CapabilityPackageFileRead): string | null {
  if (!file.eof || file.size > 1024 * 1024) return null;
  try {
    const bytes = fromBase64(file.content);
    if (bytes.some(byte => byte === 0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
}

/** One collapsed package editor for standalone skills and plugins; all operations use the same server actions. */
export function PackageEditorSection(props: PackageEditorProps) {
  return <PackageEditorSession key={JSON.stringify([props.resourceRef, props.workspaceId ?? '', props.initialDraftRef ?? ''])} {...props} />;
}

/** Each exact resource/workspace/draft selection owns its state and request generation. */
function PackageEditorSession({ resourceRef, workspaceId, onUpdated, initialDraftRef, initiallyOpen = false, initialFile }: PackageEditorProps) {
  const t = useTranslations('skills.packageEditor');
  const storageKey = `canvas-private-package-draft:${resourceRef}:${workspaceId || ''}`;
  const [descriptor, setDescriptor] = useState<CapabilityPackageDescriptor | null>(null);
  const [draftView, setDraftView] = useState<DraftView | null>(null);
  const [blockedDraft, setBlockedDraft] = useState<OwnedDraftStatus | null>(null);
  const [requestedKey, setRequestedKey] = useState(initiallyOpen ? storageKey : '');
  const [open, setOpen] = useState(initiallyOpen);
  const [tree, setTree] = useState<CapabilityPackageTreeEntry[]>([]);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [scopes, setScopes] = useState<ScopeChoice[]>([]);
  const [scopeChoice, setScopeChoice] = useState('user');
  const [variantName, setVariantName] = useState('');
  const [filePath, setFilePath] = useState('');
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [fileText, setFileText] = useState('');
  const [validation, setValidation] = useState<{ revision: number; value: CapabilityPackageValidation } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishedVariant, setPublishedVariant] = useState<{ name: string; kind: 'skill' | 'plugin'; scope: string } | null>(null);
  const generation = useRef(0);
  const loadRevision = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const upload = useRef<HTMLInputElement | null>(null);
  const resumedDraft = useRef(initialDraftRef);
  const dirty = fileView?.text !== null && fileView?.text !== undefined && fileText !== fileView.text;
  const requestedInitialFile = useRef(initialFile);
  const attemptedInitialFiles = useRef(new Set<string>());
  const currentEditor = useRef({ dirty, pending, filePath });
  useLayoutEffect(() => {
    requestedInitialFile.current = initialFile;
    currentEditor.current = { dirty, pending, filePath };
  }, [initialFile, dirty, pending, filePath]);
  const newFile = fileView?.file.checksum === '';
  usePluginEditorNavigationGuard({ dirty, pending });

  const apiPath = useCallback((suffix: string, query?: Record<string, string | number>) => {
    const parameters = new URLSearchParams();
    if (workspaceId) parameters.set('workspaceId', workspaceId);
    for (const [key, value] of Object.entries(query || {})) parameters.set(key, String(value));
    return `/api/capabilities/packages${suffix}${parameters.size ? `?${parameters}` : ''}`;
  }, [workspaceId]);
  const request = useCallback(async <T,>(suffix: string, options?: RequestInit, query?: Record<string, string | number>): Promise<T> => {
    const current = generation.current;
    const response = await fetch(apiPath(suffix, query), { cache: 'no-store', ...options });
    const payload = await response.json() as ApiPayload<T>;
    if (current !== generation.current) throw new DOMException('The selected package changed.', 'AbortError');
    if (!response.ok || !payload.success || !payload.data) throw new PackageRequestError(response.status, payload.code || 'PACKAGE_SNAPSHOT_UNAVAILABLE');
    return payload.data;
  }, [apiPath]);
  const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rememberDraft = (reference: string | null) => {
    resumedDraft.current = reference ?? undefined;
    if (reference) localStorage.setItem(storageKey, reference);
    else localStorage.removeItem(storageKey);
  };
  const errorMessage = useCallback((failure: unknown) => failure instanceof PackageRequestError
    ? t(failure.status === 409 ? 'conflict' : failure.status === 403 || failure.status === 404 ? 'accessError' : 'requestError')
    : t('requestError'), [t]);

  const loadDraft = useCallback(async (reference: string, signal?: AbortSignal, expected?: OwnedDraftStatus) => {
    const result = await request<DraftView & { files: CapabilityPackageTreeEntry[] }>(`/drafts/${encodeURIComponent(reference)}/tree`, { signal });
    if (result.draft.draftRef !== reference || expected && result.draft.resourceRef !== expected.resourceRef) {
      throw new PackageRequestError(403, 'PACKAGE_ACCESS_DENIED');
    }
    return result;
  }, [request]);
  const load = useCallback(async () => {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const current = generation.current;
    const revision = ++loadRevision.current;
    setLoading(true);
    let owned: OwnedDraftStatus | null = null;
    try {
      const reference = encodeURIComponent(resourceRef);
      let saved = resumedDraft.current || localStorage.getItem(storageKey);
      const explicitResume = Boolean(initialDraftRef && saved === initialDraftRef);
      if (saved) {
        try {
          const status = (await request<{ status: OwnedDraftStatus }>(`/drafts/${encodeURIComponent(saved)}/status`, { signal: controller.signal })).status;
          if (status.draftRef !== saved || !status.sourceResourceRef || explicitResume && status.sourceResourceRef !== resourceRef) {
            throw new PackageRequestError(403, 'PACKAGE_ACCESS_DENIED');
          }
          owned = status;
        }
        catch (failure) {
          if (!explicitResume && failure instanceof PackageRequestError && failure.status === 404) { localStorage.removeItem(storageKey); saved = null; }
          else throw failure;
        }
      }
      // Whole-package checks stay sequential so opening a large package does not allocate several inventories at once.
      const packageData = await request<{ package: CapabilityPackageDescriptor }>(`/${reference}`, { signal: controller.signal });
      if (owned && packageData.package.resource.resourceRef !== owned.sourceResourceRef) {
        owned = null;
        throw new PackageRequestError(403, 'PACKAGE_ACCESS_DENIED');
      }
      const scopeData = await request<{ scopes: ScopeChoice[] }>('/scopes', { signal: controller.signal });
      const versionData = await request<{ versions: VersionSummary[] }>(`/${reference}/versions`, { signal: controller.signal });
      let draftData: (DraftView & { files: CapabilityPackageTreeEntry[] }) | null = null;
      if (saved) {
        try { draftData = await loadDraft(saved, controller.signal, owned ?? undefined); }
        catch (failure) {
          if (!(failure instanceof PackageRequestError && [403, 404].includes(failure.status) && owned)) throw failure;
        }
      }
      const treeData = draftData || (owned ? { files: [] } : packageData.package.published
        ? { files: packageData.package.published.files.map(file => ({ ...file, type: 'file' as const })) }
        : await request<{ files: CapabilityPackageTreeEntry[] }>(`/${reference}/tree`, { signal: controller.signal }));
      if (current !== generation.current || revision !== loadRevision.current || controller.signal.aborted) return;
      const initialPath = requestedInitialFile.current;
      let initialView: FileView | null = null;
      if (initialPath && !attemptedInitialFiles.current.has(initialPath) && !currentEditor.current.dirty && !currentEditor.current.pending
        && !currentEditor.current.filePath && (!owned || draftData) && treeData.files.some(file => file.type === 'file' && file.path === initialPath)) {
        attemptedInitialFiles.current.add(initialPath);
        const capturedFile = treeData.files.find(file => file.type === 'file' && file.path === initialPath);
        const selected = await request<{file: CapabilityPackageFileRead; draft?: CapabilityPackageDraft}>(draftData
          ? `/drafts/${encodeURIComponent(draftData.draft.draftRef)}/file` : `/${reference}/file`, {signal: controller.signal},
        {path: initialPath, maxBytes: 1024 * 1024, ...(draftData || !packageData.package.published ? {} : {revisionRef: packageData.package.published.revisionRef})});
        if (current !== generation.current || revision !== loadRevision.current || controller.signal.aborted) return;
        if (selected.file.path !== initialPath || capturedFile?.type !== 'file' || selected.file.checksum !== capturedFile.checksum
          || selected.file.size !== capturedFile.size || draftData && (selected.draft?.draftRef !== draftData.draft.draftRef
            || selected.draft?.draftRevision !== draftData.draft.draftRevision)) throw new PackageRequestError(409, 'PACKAGE_REVISION_CONFLICT');
        initialView = {file: selected.file, text: textContent(selected.file)};
      }
      setDescriptor(packageData.package); setScopes(scopeData.scopes); setVersions(versionData.versions);
      setSelectedVersion(packageData.package.published?.revisionRef || '');
      setDraftView(draftData); setBlockedDraft(draftData ? null : owned); setTree(treeData.files); setError(null); setValidation(null);
      if (initialView && !currentEditor.current.dirty && !currentEditor.current.pending && !currentEditor.current.filePath) {
        setFilePath(initialView.file.path); setFileView(initialView); setFileText(initialView.text || '');
      } else if (!draftData) { setFilePath(''); setFileView(null); setFileText(''); }
    } catch (failure) {
      if (current === generation.current && revision === loadRevision.current && !controller.signal.aborted) {
        setError(errorMessage(failure));
        setDescriptor(null); setVersions([]);
        if (owned || failure instanceof PackageRequestError && [403, 404].includes(failure.status)) {
          setDraftView(null); setBlockedDraft(owned); setTree([]); setFilePath(''); setFileView(null); setFileText(''); setValidation(null);
        }
      }
    } finally {
      if (current === generation.current && revision === loadRevision.current && !controller.signal.aborted) setLoading(false);
    }
  }, [errorMessage, initialDraftRef, loadDraft, request, resourceRef, storageKey]);

  useEffect(() => {
    startTransition(() => {
      setDescriptor(null); setDraftView(null); setBlockedDraft(null); setFilePath(''); setFileView(null); setFileText(''); setNotice(null);
      setPublishedVariant(null); setPending(false); setLoading(false);
      if (requestedKey === storageKey) void load();
    });
    return () => { generation.current += 1; readController.current?.abort(); };
  }, [load, requestedKey, storageKey]);

  const perform = async (operation: () => Promise<void>) => {
    const current = generation.current;
    setPending(true); setError(null); setNotice(null);
    try { await operation(); }
    catch (failure) {
      if (current === generation.current) {
        setError(errorMessage(failure));
        if (draftView && failure instanceof PackageRequestError && (failure.status === 403 || failure.status === 404)) await load();
      }
    }
    finally { if (current === generation.current) setPending(false); }
  };
  const refreshDraft = async (reference: string) => {
    const result = await loadDraft(reference);
    setDraftView(result); setBlockedDraft(null); setTree(result.files); setValidation(null);
  };
  const createDraft = async (operation: 'edit' | 'fork') => {
    if (!descriptor) return;
    const resource = descriptor.resource, head = descriptor.state;
    const choice = scopes.find(value => (value.type === 'team' ? `team:${value.workspaceId}` : value.type) === scopeChoice);
    if (operation === 'fork' && !choice) return;
    const input = operation === 'edit' ? { operation, resourceRef: resource.resourceRef,
      expectedMetadataRevision: resource.metadataRevision, expectedGrantsRevision: resource.grantsRevision,
      expectedPackageRevision: head?.packageRevision || 0, expectedPublishedRevisionRef: head?.currentPublishedRevisionRef || null }
      : { operation, resourceRef: resource.resourceRef, targetName: variantName.trim(),
        ownership: choice!.type === 'team' ? { type: 'team', workspaceId: choice!.workspaceId } : { type: choice!.type },
        expectedSourceMetadataRevision: resource.metadataRevision, expectedSourceGrantsRevision: resource.grantsRevision,
        expectedSourcePackageRevision: head?.packageRevision || 0, expectedSourcePublishedRevisionRef: head?.currentPublishedRevisionRef || null };
    const result = await request<{ draft: CapabilityPackageDraft }>('/drafts', { method: 'POST', ...json(input) });
    rememberDraft(result.draft.draftRef); await refreshDraft(result.draft.draftRef);
    setFilePath(''); setFileView(null); setFileText(''); setPublishedVariant(null);
    setNotice(t('draftCreated'));
  };
  const fileSuffix = (reference?: string) => reference ? `/drafts/${encodeURIComponent(reference)}/file`
    : `/${encodeURIComponent(resourceRef)}/file`;
  const openFile = async (selected: string) => {
    const result = await request<{ file: CapabilityPackageFileRead }>(fileSuffix(draftView?.draft.draftRef), undefined,
      { path: selected, maxBytes: 1024 * 1024, ...(draftView || !selectedVersion ? {} : { revisionRef: selectedVersion }) });
    const text = textContent(result.file);
    setFilePath(selected); setFileView({ file: result.file, text }); setFileText(text || '');
  };
  const reloadDraftEditor = async () => {
    if (!draftView) { await load(); return; }
    const selected = filePath, localText = fileText, retainText = dirty;
    let result: DraftView & { files: CapabilityPackageTreeEntry[] };
    try { result = await loadDraft(draftView.draft.draftRef); }
    catch (failure) {
      if (failure instanceof PackageRequestError && (failure.status === 403 || failure.status === 404)) { await load(); return; }
      throw failure;
    }
    if (selected && result.files.some(file => file.type === 'file' && file.path === selected)) {
      const latest = await request<DraftView & { file: CapabilityPackageFileRead }>(fileSuffix(result.draft.draftRef), undefined,
        { path: selected, maxBytes: 1024 * 1024 });
      const text = textContent(latest.file);
      // Keep the original editor and CAS together when the current file cannot replace its text base.
      if (retainText && text === null) throw new PackageRequestError(409, 'PACKAGE_REVISION_CONFLICT');
      setDraftView(latest); setTree(result.files); setValidation(null);
      setFileView({ file: latest.file, text }); setFileText(retainText ? localText : text || '');
    } else {
      setDraftView(result); setTree(result.files); setValidation(null);
      if (!retainText) { setFilePath(''); setFileView(null); setFileText(''); }
      else setFileView({ file: { path: selected, encoding: 'base64', content: '', size: 0, checksum: '', offset: 0, byteLength: 0, eof: true }, text: '' });
    }
    if (retainText) setNotice(t('reloadReview'));
  };
  const saveFile = async (content: string, selected = filePath) => {
    if (!draftView) return;
    const result = await request<{ draft: CapabilityPackageDraft }>(fileSuffix(draftView.draft.draftRef), { method: 'PUT',
      ...json({ path: selected, encoding: 'base64', content, expectedDraftRevision: draftView.draft.draftRevision }) });
    await refreshDraft(result.draft.draftRef);
    const read = await request<{ file: CapabilityPackageFileRead }>(fileSuffix(result.draft.draftRef), undefined, { path: selected, maxBytes: 1024 * 1024 });
    const text = textContent(read.file);
    setFilePath(selected); setFileView({ file: read.file, text }); setFileText(text || ''); setNotice(t('fileSaved'));
  };
  const downloadFile = async () => {
    if (!fileView) return;
    const chunks: Uint8Array[] = [];
    let file = fileView.file;
    while (true) {
      chunks.push(fromBase64(file.content));
      if (file.eof) break;
      const result = await request<{ file: CapabilityPackageFileRead }>(fileSuffix(draftView?.draft.draftRef), undefined,
        { path: filePath, offset: file.offset + file.byteLength, ...(draftView || !selectedVersion ? {} : { revisionRef: selectedVersion }) });
      if (result.file.checksum !== fileView.file.checksum || result.file.size !== fileView.file.size || result.file.byteLength === 0) throw new Error('Changed file');
      file = result.file;
    }
    const url = URL.createObjectURL(new Blob(chunks.map(chunk => new Uint8Array(chunk).buffer), { type: file.mediaType || 'application/octet-stream' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filePath.split('/').at(-1) || 'package-file'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const publish = async () => {
    if (!draftView) return;
    const draft = draftView.draft;
    const result = await request<{ state: { resourceRef: string }; published: CapabilityPackagePublishedRevision }>(`/drafts/${encodeURIComponent(draft.draftRef)}/publish`,
      { method: 'POST', ...json({ draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
        expectedPackageRevision: draft.basePackageRevision, expectedPublishedRevisionRef: draft.basePublishedRevisionRef,
        expectedMetadataRevision: draftView.target.expectedMetadataRevision, expectedGrantsRevision: draftView.target.expectedGrantsRevision }) });
    rememberDraft(null); setDraftView(null); setValidation(null); setFilePath(''); setFileView(null); setFileText('');
    if (draft.operation === 'fork') setPublishedVariant({ name: draft.name, kind: draft.kind,
      scope: draftView.target.ownership.type === 'user' ? 'user' : 'organization' });
    await load(); setNotice(t('published', { name: draft.name, version: result.published.version })); onUpdated?.();
  };
  const files = tree.filter((entry): entry is Extract<CapabilityPackageTreeEntry, { type: 'file' }> => entry.type === 'file');
  const owner = draftView?.target.ownership || blockedDraft?.targetOwnership || descriptor?.resource.ownership;
  const scopeLabel = owner?.type === 'team' ? scopes.find(scope => scope.workspaceId === owner.workspaceId)?.label || t('team')
    : owner?.type === 'organization' ? t('organization') : owner?.type === 'system' ? t('core') : t('personal');

  return <section data-testid="package-editor" className="rounded-lg border bg-muted/10">
    <details key={storageKey} open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setRequestedKey(storageKey); }}>
      <summary className="cursor-pointer list-none px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex min-w-0 items-center gap-2"><FileCode2 className="h-4 w-4 shrink-0" />
          <span className="flex-1 font-medium">{t('title')}</span>
          <span className="truncate text-xs text-muted-foreground">{descriptor?.published?.version || descriptor?.sourceStamp.version || ''}</span>
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{t('summary')}</span>
      </summary>
      <div className="space-y-4 border-t p-4">
        {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</p> : null}
        {error ? <InlineNotice variant="destructive" size="compact" role="alert">{error}</InlineNotice> : null}
        {notice ? <InlineNotice size="compact" role="status">{notice}</InlineNotice> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-start gap-3">
          {draftView || blockedDraft || descriptor ? <PluginExtensionAvatar name={draftView?.draft.name || blockedDraft?.name || descriptor?.resource.displayName || descriptor?.sourceStamp.name || ''}
            identity={JSON.stringify([draftView?.draft.draftRef || blockedDraft?.draftRef || resourceRef, workspaceId ?? '', draftView?.draft.draftRevision || blockedDraft?.draftRevision || descriptor?.sourceStamp.artifactRevision])} size="sm" /> : null}
          <div className="min-w-0 text-sm"><p className="font-medium">{draftView || blockedDraft
            ? t('draftName', { name: draftView?.draft.name || blockedDraft!.name }) : t('publishedPackage')}</p>
            <p className="text-xs text-muted-foreground">{scopeLabel}{draftView ? ` · ${t('privateDraft')}` : ''}</p></div>
          </div>
          <Button variant="outline" size="sm" disabled={pending || loading} data-testid="package-reload"
            onClick={() => void perform(reloadDraftEditor)}>
            <RefreshCw className="h-4 w-4" />{t('reload')}
          </Button>
        </div>
        {descriptor?.readOnly ? <p className="text-sm text-muted-foreground">{t('readOnly')}</p> : null}
        {!draftView && !blockedDraft && descriptor?.state?.currentPublishedRevisionRef && descriptor.access.canManage && !descriptor.readOnly
          ? <div className="space-y-2 rounded-md border p-3">
            <Label className="flex items-center justify-between gap-3" htmlFor={`package-activation-${resourceRef}`}>
              <span>{t('defaultActivation')}</span>
              <Switch id={`package-activation-${resourceRef}`} checked={descriptor.defaultEnabled} disabled={pending || loading}
                data-testid="package-default-activation" onCheckedChange={enabled => void perform(async () => {
                  const head = descriptor.state!;
                  await request(`/${encodeURIComponent(resourceRef)}/activation`, { method: 'PATCH', ...json({ enabled,
                    expectedDefaultEnabled: descriptor.defaultEnabled, expectedPackageRevision: head.packageRevision,
                    expectedPublishedRevisionRef: head.currentPublishedRevisionRef, expectedMetadataRevision: descriptor.resource.metadataRevision,
                    expectedGrantsRevision: descriptor.resource.grantsRevision }) });
                  await load(); onUpdated?.();
                })} />
            </Label>
            <p className="text-xs text-muted-foreground">{t('activationHint')}</p>
          </div> : null}
        {!draftView && !blockedDraft && descriptor ? <div className="space-y-3">
          {descriptor.access.canEdit && !descriptor.readOnly ? <Button size="sm" disabled={pending || loading}
            data-testid="package-create-edit" onClick={() => void perform(() => createDraft('edit'))}>{t('editPackage')}</Button> : null}
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">{t('createVariant')}</summary>
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">{t('variantHint')}</p>
              <div className="space-y-1"><Label htmlFor={`package-variant-${resourceRef}`}>{t('name')}</Label>
                <Input id={`package-variant-${resourceRef}`} value={variantName} onChange={event => setVariantName(event.target.value)}
                  disabled={pending} data-testid="package-variant-name" autoComplete="off" /></div>
              <div className="space-y-1"><Label htmlFor={`package-scope-${resourceRef}`}>{t('scope')}</Label>
                <select id={`package-scope-${resourceRef}`} className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={scopeChoice} onChange={event => setScopeChoice(event.target.value)} disabled={pending} data-testid="package-variant-scope">
                  {scopes.map(scope => <option key={scope.type === 'team' ? scope.workspaceId : scope.type}
                    value={scope.type === 'team' ? `team:${scope.workspaceId}` : scope.type}>
                    {scope.type === 'team' ? `${t('team')}: ${scope.label}` : scope.type === 'organization' ? t('organization') : t('personal')}
                  </option>)}
                </select></div>
              <Button size="sm" disabled={pending || !variantName.trim() || !scopes.length} data-testid="package-create-fork"
                onClick={() => void perform(() => createDraft('fork'))}>{t('createDraft')}</Button>
            </div>
          </details>
        </div> : null}
        {!draftView && versions.length ? <div className="space-y-1"><Label htmlFor={`package-version-${resourceRef}`}>{t('version')}</Label>
          <select id={`package-version-${resourceRef}`} value={selectedVersion} disabled={pending || loading} data-testid="package-version"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm" onChange={event => {
              const selected = event.target.value;
              void perform(async () => {
                const result = await request<{ files: CapabilityPackageTreeEntry[] }>(`/${encodeURIComponent(resourceRef)}/tree`, undefined, { revisionRef: selected });
                setSelectedVersion(selected); setTree(result.files); setFilePath(''); setFileView(null); setFileText('');
              });
            }}>
            {versions.map(version => <option key={version.revisionRef} value={version.revisionRef}>
              {version.version} · {new Date(version.publishedAt).toLocaleString()}
            </option>)}
          </select></div> : null}
        {files.length ? <div className="space-y-3">
          <div className="space-y-1"><Label htmlFor={`package-file-${resourceRef}`}>{t('files', { count: files.length })}</Label>
            <select id={`package-file-${resourceRef}`} value={filePath} disabled={pending || dirty} data-testid="package-file-picker"
              className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm" onChange={event => void perform(() => openFile(event.target.value))}>
              <option value="">{t('chooseFile')}</option>
              {newFile ? <option value={filePath}>{filePath}</option> : null}
              {files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
            </select></div>
          {fileView ? <div className="space-y-2">
            <p className="break-all text-xs text-muted-foreground">{filePath} · {fileView.file.size.toLocaleString()} {t('bytes')}</p>
            {fileView.text !== null ? <Textarea value={fileText} onChange={event => setFileText(event.target.value)}
              readOnly={!draftView} disabled={pending} aria-label={t('fileContent')} data-testid="package-file-content"
              className="min-h-56 max-h-[60vh] resize-y font-mono text-xs" spellCheck={false} />
              : <p className="text-sm text-muted-foreground">{t('binaryFile')}</p>}
            {dirty ? <details className="rounded-md border p-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">{t('currentSavedFile')}</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">{fileView.text}</pre>
            </details> : null}
            <div className="flex flex-wrap gap-2">
              {draftView && fileView.text !== null ? <Button size="sm" disabled={pending || !dirty} data-testid="package-save-file"
                onClick={() => void perform(() => saveFile(toBase64(new TextEncoder().encode(fileText))))}>{t('saveFile')}</Button> : null}
              <Button variant="outline" size="sm" disabled={pending} onClick={() => void perform(downloadFile)}><Download className="h-4 w-4" />{t('download')}</Button>
              {draftView ? <Button variant="outline" size="sm" disabled={pending || dirty} data-testid="package-delete-file"
                onClick={() => void perform(async () => {
                  await request(fileSuffix(draftView.draft.draftRef), { method: 'DELETE', ...json({ path: filePath, expectedDraftRevision: draftView.draft.draftRevision }) });
                  await refreshDraft(draftView.draft.draftRef); setFilePath(''); setFileView(null); setFileText('');
                })}><Trash2 className="h-4 w-4" />{t('deleteFile')}</Button> : null}
            </div>
          </div> : null}
        </div> : null}
        {draftView ? <div className="space-y-3 border-t pt-3">
          <div className="space-y-1"><Label htmlFor={`package-upload-path-${resourceRef}`}>{t('uploadPath')}</Label>
            <Input id={`package-upload-path-${resourceRef}`} value={filePath} onChange={event => {
              setFilePath(event.target.value); if (!newFile) { setFileView(null); setFileText(''); }
            }} disabled={pending || dirty && !newFile} data-testid="package-upload-path" placeholder="scripts/run.py" autoComplete="off" /></div>
          <input ref={upload} type="file" className="sr-only" aria-label={t('upload')} data-testid="package-upload-input" onChange={event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file) return;
            void perform(async () => {
              if (file.size > 32 * 1024 * 1024) throw new PackageRequestError(413, 'PACKAGE_LIMIT_EXCEEDED');
              await saveFile(toBase64(new Uint8Array(await file.arrayBuffer())), filePath.trim());
            });
          }} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={pending || !filePath.trim() || dirty} onClick={() => upload.current?.click()}>
              <Upload className="h-4 w-4" />{t('upload')}
            </Button>
            <Button variant="outline" size="sm" disabled={pending || !filePath.trim() || dirty || files.some(file => file.path === filePath.trim())}
              data-testid="package-new-text-file" onClick={() => {
                setFilePath(filePath.trim());
                setFileView({ file: { path: filePath.trim(), encoding: 'base64', content: '', size: 0,
                  checksum: '', offset: 0, byteLength: 0, eof: true }, text: '' }); setFileText('');
              }}>{t('newTextFile')}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('versionHint')}</p>
          {dirty ? <p className="text-xs text-muted-foreground">{t('unsaved')}</p> : null}
          {validation ? <InlineNotice variant={validation.value.valid ? 'default' : 'destructive'} size="compact" role="status">
            {validation.value.valid ? t('valid', { version: validation.value.version || '', count: validation.value.files.length })
              : validation.value.errors.join(' ')}
          </InlineNotice> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={pending || dirty} data-testid="package-validate" onClick={() => void perform(async () => {
              const result = await request<DraftView & { validation: CapabilityPackageValidation }>(`/drafts/${encodeURIComponent(draftView.draft.draftRef)}/validate`, { method: 'POST' });
              setDraftView(result); setValidation({ revision: result.draft.draftRevision, value: result.validation });
            })}>{t('validate')}</Button>
            <Button size="sm" disabled={pending || dirty || !validation?.value.valid || validation.revision !== draftView.draft.draftRevision}
              data-testid="package-publish" onClick={() => void perform(publish)}>{t('publish')}</Button>
            <Button variant="outline" size="sm" disabled={pending} data-testid="package-discard" onClick={() => void perform(async () => {
              await request(`/drafts/${encodeURIComponent(draftView.draft.draftRef)}`, { method: 'DELETE', ...json({ expectedDraftRevision: draftView.draft.draftRevision }) });
              rememberDraft(null); setDraftView(null); setFilePath(''); setFileView(null); setFileText(''); await load(); setNotice(t('discarded'));
            })}>{t('discard')}</Button>
          </div>
        </div> : null}
        {blockedDraft ? <div className="space-y-2 border-t pt-3">
          <p className="text-sm text-muted-foreground">{t('revokedDraft')}</p>
          <Button variant="outline" size="sm" disabled={pending} data-testid="package-discard" onClick={() => void perform(async () => {
            await request(`/drafts/${encodeURIComponent(blockedDraft.draftRef)}`, { method: 'DELETE', ...json({ expectedDraftRevision: blockedDraft.draftRevision }) });
            rememberDraft(null); setBlockedDraft(null); setFileView(null); setFileText(''); await load(); setNotice(t('discarded'));
          })}>{t('discard')}</Button>
        </div> : null}
        {publishedVariant ? <p className="text-sm"><a className="underline underline-offset-4" href={`/plugins?${new URLSearchParams({ view: 'installed',
          scope: publishedVariant.scope, ...(publishedVariant.kind === 'plugin' ? { plugin: publishedVariant.name, source: 'installed' }
            : { area: 'skills', q: publishedVariant.name }) })}`}>
          {t('openVariant', { name: publishedVariant.name })}
        </a></p> : null}
      </div>
    </details>
  </section>;
}
