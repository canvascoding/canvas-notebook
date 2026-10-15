'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Copy, Loader2, Users, History } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { authClient } from '@/app/lib/auth-client';
import type { FileGuestInvitationView, FileGuestPermission } from '@/app/lib/file-guests/types';
import type { WorkspaceFileMetadataTarget } from '@/app/lib/files/workspace-file-metadata-contract';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ShareExpiryField } from '../file-browser/ShareExpiryField';
import { expiryFromInput, isCancelledShareRequest, localExpiryInput, useScopedShareRequest } from '../file-browser/sharing-client';

/** A target is historical Info evidence, never permission to change a file. */
export function fileGuestTargetMatches(value: unknown, workspaceId: string, path: string): value is WorkspaceFileMetadataTarget {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const target = value as Record<string, unknown>;
  if (target.version !== 1 || target.workspaceId !== workspaceId || target.path !== path) return false;
  const fields = target.kind === 'native_file' ? ['documentId', 'lifecycleGeneration']
    : target.kind === 'filesystem' ? ['fileVersion', 'entryType'] : null;
  if (!fields || Object.keys(target).length !== 6 || !['version', 'kind', 'workspaceId', 'path', ...fields]
    .every(field => Object.prototype.hasOwnProperty.call(target, field))) return false;
  if (target.kind === 'native_file') return typeof target.documentId === 'string' && target.documentId.length > 0
    && target.documentId.length <= 256 && target.documentId === target.documentId.trim()
    && !/[\u0000-\u001f\u007f]/u.test(target.documentId)
    && Number.isSafeInteger(target.lifecycleGeneration) && Number(target.lifecycleGeneration) >= 1;
  return typeof target.fileVersion === 'string' && target.fileVersion.length <= 1024
    && /^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+(?:\.[0-9]+)?:-?[0-9]+(?:\.[0-9]+)?$/u.test(target.fileVersion)
    && (target.entryType === 'file' || target.entryType === 'directory');
}

function PermissionField({ value, onChange, canWrite, disabled }: { value: FileGuestPermission; onChange: (value: FileGuestPermission) => void; canWrite: boolean; disabled?: boolean }) {
  const t = useTranslations('fileSharing');
  const id = useId();
  return <div className="space-y-1.5"><Label htmlFor={id}>{t('permission')}</Label>
    <select id={id} className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={value} onChange={(event) => onChange(event.target.value as FileGuestPermission)} disabled={disabled}>
      <option value="read">{t('read')}</option><option value="write" disabled={!canWrite}>{t('write')}</option>
    </select>
  </div>;
}

function GuestInvitationCard({ invitation, workspace, userId, onChanged }: { invitation: FileGuestInvitationView; workspace: ClientWorkspaceSummary; userId?: string; onChanged: () => void }) {
  const t = useTranslations('fileSharing');
  const request = useScopedShareRequest(workspace.id);
  const [expiry, setExpiry] = useState(localExpiryInput(invitation.expiresAt));
  const [permission, setPermission] = useState(invitation.permission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = invitation.status === 'active';
  const canManage = workspace.permissions.canCreatePublicLinks && (workspace.permissions.canManageWorkspace || invitation.createdByUserId === userId);
  const changed = expiry !== localExpiryInput(invitation.expiresAt) || permission !== invitation.permission;
  const update = async (revoke: boolean) => {
    if (busy || !canManage) return;
    setBusy(true); setError('');
    try {
      await request(`/api/security/file-guests/${encodeURIComponent(invitation.id)}`, { method: revoke ? 'DELETE' : 'PATCH', body: {
        policyRevision: invitation.policyRevision, ...(!revoke ? {
          ...(permission !== invitation.permission ? { permission } : {}),
          expiresAt: expiry === localExpiryInput(invitation.expiresAt) ? invitation.expiresAt : expiryFromInput(expiry),
        } : {}),
      } });
      toast.success(t(revoke ? 'revoked' : 'saved')); onChanged();
    } catch (err) { if (!isCancelledShareRequest(err)) setError(err instanceof Error ? err.message : t('error')); }
    finally { setBusy(false); }
  };
  return <article className="space-y-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all text-sm font-medium">{invitation.email}</span><Badge variant={active ? 'secondary' : 'outline'}>{t(invitation.status === 'revoked' ? 'revokedStatus' : invitation.status)}</Badge></div>
    <p className="text-xs text-muted-foreground">{t('assets', { count: invitation.assetCount })}</p>
    {active ? <>
      <a href={invitation.url} target="_blank" rel="noopener noreferrer" title={t('open')} className="block break-all rounded bg-muted/50 p-2 font-mono text-xs underline">{invitation.url}</a>
      <Button size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(new URL(invitation.url, window.location.origin).href); toast.success(t('copied')); } catch { toast.error(t('copyFailed')); } }}><Copy className="size-4" />{t('copy')}</Button>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void update(false); }}>
        <PermissionField value={permission} onChange={setPermission} canWrite={workspace.permissions.canWrite} disabled={busy || !canManage} />
        <ShareExpiryField value={expiry} onChange={setExpiry} disabled={busy || !canManage} />
        {canManage ? <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={busy || !changed}>{busy && <Loader2 className="size-4 animate-spin" />}{t('save')}</Button>
          <Button size="sm" variant="ghost" type="button" className="text-destructive" disabled={busy} onClick={() => void update(true)}>{t('revoke')}</Button>
        </div> : <p className="text-xs text-muted-foreground">{t('ownerOnly')}</p>}
      </form>
    </> : <>
      <p className="text-xs text-muted-foreground">{t(invitation.permission)} · {invitation.expiresAt ? t('expires', { date: new Date(invitation.expiresAt).toLocaleString() }) : t('noExpiry')}</p>
      {canManage && invitation.status !== 'revoked' && <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void update(true)}>{t('revoke')}</Button>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button variant="link" size="sm" onClick={onChanged}>{t('retry')}</Button></p>}
  </article>;
}

function GuestVersionHistory({ path, workspace }: { path: string; workspace: ClientWorkspaceSummary }) {
  const t = useTranslations('fileSharing');
  const request = useScopedShareRequest(workspace.id);
  const sequence = useRef(0);
  const [data, setData] = useState<{ versions: Array<{ id: string; createdAt: string }>; stateFingerprint: string } | null>(null);
  const [selected, setSelected] = useState<{ id: string; content: string; createdAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    const current = ++sequence.current;
    setBusy(true); setError(''); setSelected(null);
    try {
      const result = await request<NonNullable<typeof data>>(`/api/security/file-guests/versions?${new URLSearchParams({ path })}`);
      if (current === sequence.current) setData(result);
    } catch (err) { if (current === sequence.current && !isCancelledShareRequest(err)) setError(err instanceof Error ? err.message : t('error')); }
    finally { if (current === sequence.current) setBusy(false); }
  };
  const inspect = async (versionId: string) => {
    setBusy(true); setError('');
    try { const result = await request<{ version: NonNullable<typeof selected> }>(`/api/security/file-guests/versions?${new URLSearchParams({ path, versionId })}`); setSelected(result.version); }
    catch (err) { if (!isCancelledShareRequest(err)) setError(err instanceof Error ? err.message : t('error')); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!data || !selected || busy) return;
    setBusy(true); setError('');
    try {
      await request('/api/security/file-guests/versions', { method: 'POST', body: { path, versionId: selected.id, stateFingerprint: data.stateFingerprint } });
      toast.success(t('restored')); await load();
    } catch (err) { if (!isCancelledShareRequest(err)) { setError(err instanceof Error ? err.message : t('error')); setData(null); } }
    finally { setBusy(false); }
  };
  return <section className="space-y-3 border-t pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-medium"><History className="size-4" />{t('versions')}</h3><Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{t(data ? 'refresh' : 'inspectVersion')}</Button></div>
    <p className="text-xs text-muted-foreground">{t('versionsHelp')}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {selected ? <div className="space-y-3">
      <p className="text-sm font-medium">{new Date(selected.createdAt).toLocaleString()}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/20 p-3 text-xs" tabIndex={0}>{selected.content}</pre>
      <p className="text-xs text-muted-foreground">{t('restoreHelp')}</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setSelected(null)} disabled={busy}>{t('back')}</Button><Button size="sm" onClick={() => void restore()} disabled={busy || !data}>{t('restore')}</Button></div>
    </div> : data && <ul className="space-y-2">{data.versions.length ? data.versions.map((version) => <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"><span>{new Date(version.createdAt).toLocaleString()}</span><Button variant="ghost" size="sm" onClick={() => void inspect(version.id)} disabled={busy}>{t('inspectVersion')}</Button></li>) : <li className="text-sm text-muted-foreground">{t('noVersions')}</li>}</ul>}
  </section>;
}

export function FileGuestManagementPanel({ path, workspace, loadTarget }: {
  path: string;
  workspace: ClientWorkspaceSummary;
  /** Shares the dialog's genuine scoped Info request; true always refreshes it. */
  loadTarget: (refresh?: boolean) => Promise<WorkspaceFileMetadataTarget>;
}) {
  const t = useTranslations('fileSharing');
  const { data: session } = authClient.useSession();
  const request = useScopedShareRequest(workspace.id);
  const sequence = useRef(0);
  const invalidateLoads = useCallback(() => { sequence.current++; }, []);
  const [invitations, setInvitations] = useState<FileGuestInvitationView[]>([]);
  const [expectedTarget, setExpectedTarget] = useState<WorkspaceFileMetadataTarget | null>(null);
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<FileGuestPermission>('read');
  const [expiry, setExpiry] = useState(() => localExpiryInput(new Date(Date.now() + 30 * 86400000).toISOString()));
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const emailId = useId();
  const load = useCallback(async (refresh = false) => {
    const current = ++sequence.current;
    setLoading(true); setError(''); setExpectedTarget(null); setInvitations([]);
    try {
      const [target, payload] = await Promise.all([
        loadTarget(refresh),
        request<{ invitations: FileGuestInvitationView[] }>(`/api/security/file-guests?${new URLSearchParams({ path })}`),
      ]);
      if (!fileGuestTargetMatches(target, workspace.id, path)) throw new Error(t('loadFailed'));
      if (current === sequence.current) {
        setExpectedTarget(Object.freeze({ ...target })); setInvitations(payload.invitations);
      }
    } catch (err) {
      if (current === sequence.current) {
        setExpectedTarget(null); setInvitations([]);
        if (!isCancelledShareRequest(err)) setError(err instanceof Error ? err.message : t('loadFailed'));
      }
    }
    finally { if (current === sequence.current) setLoading(false); }
  }, [loadTarget, path, request, t, workspace.id]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; invalidateLoads(); };
  }, [invalidateLoads, load]);
  const targetCurrent = fileGuestTargetMatches(expectedTarget, workspace.id, path);
  const create = async () => {
    if (busy || loading || !targetCurrent || !expectedTarget) return;
    setBusy(true); setError('');
    try {
      await request('/api/security/file-guests', { method: 'POST', body: { path, expectedTarget,
        email, permission, expiresAt: expiryFromInput(expiry) } });
      setEmail(''); toast.success(t('inviteCreated')); await load(true);
    } catch (err) {
      setExpectedTarget(null);
      if (!isCancelledShareRequest(err)) setError(err instanceof Error ? err.message : t('error'));
    }
    finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <p className="text-sm">{t('guestHelp')}</p>
    <p className="text-xs text-muted-foreground">{t('emailSetup')} <Link href="/settings?tab=integrations" className="underline">{t('integrations')}</Link></p>
    <form className="space-y-3 rounded-lg border bg-muted/20 p-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="space-y-1.5"><Label htmlFor={emailId}>{t('email')}</Label><Input id={emailId} type="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy || loading} /></div>
      <PermissionField value={permission} onChange={setPermission} canWrite={workspace.permissions.canWrite} disabled={busy || loading} />
      <ShareExpiryField value={expiry} onChange={setExpiry} disabled={busy || loading} />
      <p className="text-xs text-muted-foreground">{t('inviteHelp')}</p>
      <Button type="submit" disabled={busy || loading || !targetCurrent || !email.trim()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4" />}{t('invite')}</Button>
    </form>
    {error && <div role="alert" className="text-sm text-destructive">{error} <Button variant="link" size="sm" onClick={() => void load(true)} disabled={busy}>{t('retry')}</Button></div>}
    <div className="space-y-2 text-xs text-muted-foreground"><p>{t('assetsHelp')}</p><p>{t('policyHelp')}</p><p>{t('lifecycleHelp')}</p></div>
    {loading ? <Loader2 aria-label={t('refresh')} className="size-5 animate-spin" /> : invitations.length ? invitations.map((invitation) => <GuestInvitationCard key={`${invitation.id}:${invitation.policyRevision}`} invitation={invitation} workspace={workspace} userId={session?.user.id} onChanged={() => void load(true)} />) : <p className="text-sm text-muted-foreground">{t('noGuests')}</p>}
    {workspace.permissions.canWrite && invitations.length > 0 && <GuestVersionHistory path={path} workspace={workspace} />}
  </div>;
}
