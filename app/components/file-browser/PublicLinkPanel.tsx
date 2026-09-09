'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { authClient } from '@/app/lib/auth-client';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ShareExpiryField } from './ShareExpiryField';
import { expiryFromInput, isCancelledShareRequest, localExpiryInput, useScopedShareRequest } from './sharing-client';

export interface PublicLinkView {
  id: string; workspaceId?: string | null; workspaceType?: string | null; workspacePath: string; fileName: string;
  createdByUserId: string; securityMode: 'strict' | 'interactive'; expiresAt: string | null; policyRevision: number;
  publicUrl: string; shortUrl?: string; status: string;
}

export function canManagePublicLink(share: PublicLinkView, workspace: ClientWorkspaceSummary, userId?: string) {
  return workspace.permissions.canCreatePublicLinks && (share.createdByUserId === userId
    || ((share.workspaceType === 'team' || share.workspaceType === 'organization') && share.workspaceId === workspace.id)
    || (share.workspaceType === 'project' && share.workspaceId === workspace.id && workspace.permissions.canManageWorkspace));
}

function InteractiveHtmlField({ value, onChange, disabled }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const t = useTranslations('fileSharing');
  const id = useId();
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-3"><Label htmlFor={id}>{t('interactive')}</Label><Switch id={id} checked={value} onCheckedChange={onChange} disabled={disabled} /></div>
    <p className="text-xs text-muted-foreground">{t('interactiveHelp')}</p>
  </div>;
}

function PublicLinkCard({ share, workspace, canManage, onChanged }: { share: PublicLinkView; workspace: ClientWorkspaceSummary; canManage: boolean; onChanged: () => void }) {
  const t = useTranslations('fileSharing');
  const request = useScopedShareRequest(workspace.id);
  const [expiry, setExpiry] = useState(localExpiryInput(share.expiresAt));
  const [interactive, setInteractive] = useState(share.securityMode === 'interactive');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const url = share.shortUrl || share.publicUrl;
  const changed = expiry !== localExpiryInput(share.expiresAt) || interactive !== (share.securityMode === 'interactive');
  const update = async (revoke: boolean) => {
    if (busy || !canManage) return;
    setBusy(true); setError('');
    try {
      await request(`/api/security/public-shares/${encodeURIComponent(share.id)}`, { method: revoke ? 'DELETE' : 'PATCH',
        body: { policyRevision: share.policyRevision, ...(!revoke ? {
          // Preserve seconds when only the HTML policy changed.
          expiresAt: expiry === localExpiryInput(share.expiresAt) ? share.expiresAt : expiryFromInput(expiry),
          securityMode: interactive ? 'interactive' : 'strict',
        } : {}) } });
      toast.success(t(revoke ? 'revoked' : 'saved')); onChanged();
    } catch (err) { if (!isCancelledShareRequest(err)) setError(err instanceof Error ? err.message : t('error')); }
    finally { setBusy(false); }
  };
  return <article className="min-w-0 space-y-3 rounded-lg border p-3">
    <div className="break-all text-sm font-medium">{share.fileName}</div>
    <p className="select-all break-all rounded bg-muted/50 p-2 font-mono text-xs">{url}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(url); toast.success(t('copied')); } catch { toast.error(t('copyFailed')); } }}><Copy className="size-4" />{t('copy')}</Button>
      <Button size="sm" variant="outline" asChild><a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" />{t('open')}</a></Button>
    </div>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void update(false); }}>
      <ShareExpiryField value={expiry} onChange={setExpiry} disabled={busy || !canManage} />
      {/\.(html|htm)$/i.test(share.workspacePath) && <InteractiveHtmlField value={interactive} onChange={setInteractive} disabled={busy || !canManage} />}
      {error && <p role="alert" className="text-sm text-destructive">{error} <Button type="button" variant="link" size="sm" onClick={onChanged}>{t('retry')}</Button></p>}
      {canManage ? <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !changed}>{busy && <Loader2 className="size-4 animate-spin" />}{t('save')}</Button>
        <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void update(true)}>{t('revoke')}</Button>
      </div> : <p className="text-xs text-muted-foreground">{t('ownerOnly')}</p>}
    </form>
  </article>;
}

export function PublicLinkPanel({ paths, workspace, onPublished }: { paths: string[]; workspace: ClientWorkspaceSummary; onPublished?: () => void }) {
  const t = useTranslations('fileSharing');
  const { data: session } = authClient.useSession();
  const request = useScopedShareRequest(workspace.id);
  const sequence = useRef(0);
  const [shares, setShares] = useState<PublicLinkView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [skipped, setSkipped] = useState<Array<{ path: string; reason: string }>>([]);
  const [expiry, setExpiry] = useState(() => localExpiryInput(new Date(Date.now() + 30 * 86400000).toISOString()));
  const [interactive, setInteractive] = useState(false);
  const pathsKey = JSON.stringify(paths);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ status: 'active', limit: '1000' });
      (JSON.parse(pathsKey) as string[]).forEach((path) => params.append('path', path));
      const payload = await request<{ shares: PublicLinkView[] }>(`/api/security/public-shares?${params}`);
      if (current === sequence.current) setShares(payload.shares);
    } catch (err) { if (current === sequence.current && !isCancelledShareRequest(err)) setError(err instanceof Error ? err.message : t('loadFailed')); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [pathsKey, request, t]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  const newPaths = paths.filter((path) => !shares.some((share) => share.workspacePath === path.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '')));
  const canCreate = workspace.permissions.canCreatePublicLinks;
  const changed = () => { onPublished?.(); void load(); };
  const create = async () => {
    if (busy || loading || error || !canCreate || !newPaths.length) return;
    setBusy(true); setSkipped([]);
    try {
      const payload = await request<{ shares: PublicLinkView[]; skipped: Array<{ path: string; reason: string }> }>('/api/security/public-shares', {
        method: 'POST', body: { paths: newPaths, expiresAt: expiryFromInput(expiry), securityMode: paths.length === 1 && interactive ? 'interactive' : 'strict' },
      });
      setSkipped(payload.skipped || []); changed();
    } catch (err) { if (!isCancelledShareRequest(err)) setError(err instanceof Error ? err.message : t('createFailed')); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <p className="rounded-lg border bg-muted/30 p-3 text-sm">{t('publicHelp')}</p>
    <p className="text-xs text-muted-foreground">{t('lifecycleHelp')}</p>
    {!canCreate && <p role="status" className="text-sm">{t('noPermission')}</p>}
    {loading ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{t('refresh')}</p>
      : error ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p><Button variant="outline" onClick={() => void load()}>{t('retry')}</Button></div>
      : <>
        {shares.length > 0 && <div className="space-y-3"><h3 className="text-sm font-medium">{t('existingLinks')}</h3>{shares.map((share) => <PublicLinkCard key={`${share.id}:${share.policyRevision}`} share={share} workspace={workspace} canManage={canManagePublicLink(share, workspace, session?.user.id)} onChanged={changed} />)}</div>}
        {newPaths.length > 0 && canCreate && <form className="space-y-3 rounded-lg border p-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <h3 className="text-sm font-medium">{t('newLinks')}</h3>
          <ul className="max-h-28 overflow-y-auto text-xs">{newPaths.map((path) => <li key={path} className="break-all font-mono">{path}</li>)}</ul>
          <ShareExpiryField value={expiry} onChange={setExpiry} disabled={busy} />
          {paths.length === 1 && /\.(html|htm)$/i.test(paths[0]) && <InteractiveHtmlField value={interactive} onChange={setInteractive} disabled={busy} />}
          <Button type="submit" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{t('createLinks')}</Button>
        </form>}
      </>}
    {skipped.length > 0 && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm"><p>{t('partial')}</p><ul>{skipped.map((item) => <li className="break-words" key={item.path}>{item.path}: {item.reason}</li>)}</ul></div>}
  </div>;
}
