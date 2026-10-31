'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Copy, Eye, EyeOff, KeyRound, Loader2, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { API_KEY_ACTIONS, type ApiIntegrationMetadata, type ApiKeyAction, type ApiKeyMetadata } from '@/app/lib/api-keys/contracts';
import type { ClientWorkspaceResponse, ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';

const basePath = '/api/api-access/integrations';
type IntegrationPage = { integrations: ApiIntegrationMetadata[]; nextCursor: string | null };
type CredentialPage = { integration: ApiIntegrationMetadata; credentials: ApiKeyMetadata[]; nextCursor: string | null };
type IssuedKey = { integration: ApiIntegrationMetadata; credential: ApiKeyMetadata; key: string };
type Editor = { mode: 'create' | 'edit' | 'rotate'; integration?: ApiIntegrationMetadata };
type UnconfirmedIssue = { requestId: string; integrationId?: string; checked?: boolean;
  integration?: ApiIntegrationMetadata; credential?: ApiKeyMetadata; retry?: { path: string; body: unknown } };

class AccessRequestError extends Error {
  constructor(readonly code: string, readonly status: number, readonly integrationId?: string) { super(code); }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true || !payload.data) {
    throw new AccessRequestError(typeof payload?.code === 'string' ? payload.code : 'API_KEY_UNAVAILABLE', response.status,
      typeof payload?.integrationId === 'string' ? payload.integrationId : undefined);
  }
  return payload.data as T;
}

function futureDate(days: number): string { return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10); }

async function readAccessSnapshot() {
  const [page, workspaceResponse] = await Promise.all([apiRequest<IntegrationPage>(basePath),
    fetch('/api/workspaces', { cache: 'no-store', credentials: 'same-origin' })]);
  if (!workspaceResponse.ok) throw new AccessRequestError('WORKSPACES_UNAVAILABLE', workspaceResponse.status);
  const workspaceData = await workspaceResponse.json() as ClientWorkspaceResponse;
  if (!workspaceData.success || !Array.isArray(workspaceData.workspaces)) throw new Error('Workspace listing unavailable');
  return { page, workspaces: workspaceData.workspaces };
}

export function ApiAccessSettingsPanel({ active = true }: { active?: boolean }) {
  const t = useTranslations('settings.apiAccess'), locale = useLocale();
  const [integrations, setIntegrations] = useState<ApiIntegrationMetadata[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ClientWorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState(''), [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [actions, setActions] = useState<ApiKeyAction[]>(['read']), [expiresOn, setExpiresOn] = useState(() => futureDate(90));
  const [expiryBounds, setExpiryBounds] = useState(() => ({ min: futureDate(1), max: futureDate(364) }));
  const [observedAt, setObservedAt] = useState(() => Date.now());
  const [wasActive, setWasActive] = useState(active);
  const [issued, setIssued] = useState<IssuedKey | null>(null), [showKey, setShowKey] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedIssue | null>(null);
  const [history, setHistory] = useState<CredentialPage | null>(null);
  const mounted = useRef(true), activeRef = useRef(active);
  const readEpoch = useRef(0);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) { setIssued(null); setShowKey(false); }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readEpoch.current += 1; }; }, []);
  useLayoutEffect(() => { activeRef.current = active; }, [active]);

  const errorText = useCallback((reason: unknown) => {
    if (reason instanceof AccessRequestError) {
      if (reason.status === 401) return t('sessionExpired');
      if (reason.status === 403) return t('permissionDenied');
      if (reason.status === 429) return t('rateLimited');
      if (reason.code === 'API_INTEGRATION_CHANGED') return t('changed');
      if (reason.status === 400) return t('invalidInput');
    }
    return t('unavailable');
  }, [t]);

  const reload = useCallback(() => {
    const epoch = ++readEpoch.current;
    return readAccessSnapshot().then(({ page, workspaces: available }) => {
      if (mounted.current && epoch === readEpoch.current) {
        setIntegrations(page.integrations); setNextCursor(page.nextCursor);
        setObservedAt(Date.now());
        setWorkspaces(available.filter(workspace => workspace.permissions.canRead && workspace.status === 'active'));
      }
    }).catch(reason => { if (mounted.current && epoch === readEpoch.current) setError(errorText(reason)); })
      .finally(() => { if (mounted.current && epoch === readEpoch.current) setLoading(false); });
  }, [errorText]);
  useEffect(() => { void reload(); }, [reload]);

  const openEditor = (mode: Editor['mode'], integration?: ApiIntegrationMetadata) => {
    setError(''); setNotice(''); setName(integration?.name ?? ''); setWorkspaceIds(integration?.workspaceIds ?? []);
    setActions(integration?.actions ?? ['read']); setExpiresOn(futureDate(90)); setEditor({ mode, integration });
    setExpiryBounds({ min: futureDate(1), max: futureDate(364) });
  };
  const status = (key: ApiKeyMetadata) => key.revokedAt != null ? t('revoked') : key.expiresAt <= observedAt ? t('expired') : t('active');
  const date = (timestamp: number | null) => timestamp == null ? t('neverUsed') : new Date(timestamp).toLocaleString(locale);
  const disabled = loading || busy;

  const mutate = async (path: string, method: string, body: unknown, issue?: UnconfirmedIssue, resolvesIssue = false) => {
    readEpoch.current += 1;
    setBusy(true); setError(''); setNotice('');
    if (issue && !issue.retry) issue = { ...issue, retry: { path, body } };
    if (issue) setUnconfirmed(issue);
    try {
      const result = await apiRequest<{ integration: ApiIntegrationMetadata } & Partial<IssuedKey>>(path, { method, body: JSON.stringify(body) });
      if (!mounted.current) return;
      if (issue || resolvesIssue) setUnconfirmed(null);
      setEditor(null); setHistory(null); setNotice(t('saved'));
      if (result.key) {
        if (activeRef.current) { setShowKey(false); setIssued(result as IssuedKey); }
        else if (issue) setUnconfirmed({ ...issue, integrationId: result.integration.id,
          integration: result.integration, credential: result.credential, checked: true });
      }
      await reload();
    } catch (reason) {
      if (!mounted.current) return;
      if (issue && reason instanceof AccessRequestError && [400, 401, 403, 404, 409, 429].includes(reason.status)
        && reason.code !== 'API_KEY_ALREADY_ISSUED') setUnconfirmed(null);
      else if (issue && reason instanceof AccessRequestError && reason.integrationId) setUnconfirmed({ ...issue, integrationId: reason.integrationId });
      setEditor(null); setError(errorText(reason));
    } finally { if (mounted.current) setBusy(false); }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!editor || disabled) return;
    const expiresAt = new Date(`${expiresOn}T23:59:59`).getTime();
    if (editor.mode === 'create') {
      const requestId = crypto.randomUUID();
      void mutate(basePath, 'POST', { requestId, name, workspaceIds, actions, expiresAt }, { requestId });
    } else if (editor.mode === 'rotate' && editor.integration) {
      const requestId = crypto.randomUUID(), integrationId = editor.integration.id;
      void mutate(`${basePath}/${integrationId}/credentials`, 'POST',
        { requestId, expectedRevision: editor.integration.revision, expiresAt }, { requestId, integrationId });
    } else if (editor.integration) void mutate(`${basePath}/${editor.integration.id}`, 'PATCH',
      { expectedRevision: editor.integration.revision, name, workspaceIds, actions });
  };

  const inspectIssue = async () => {
    if (!unconfirmed || disabled) return;
    setBusy(true); setError('');
    try {
      let integrationId = unconfirmed.integrationId;
      if (!integrationId) {
        const page = await apiRequest<IntegrationPage>(`${basePath}?creationRequestId=${encodeURIComponent(unconfirmed.requestId)}`);
        integrationId = page.integrations[0]?.id;
      }
      const found = integrationId ? await apiRequest<CredentialPage>(`${basePath}/${integrationId}/credentials?issuanceRequestId=${encodeURIComponent(unconfirmed.requestId)}`) : null;
      if (!mounted.current) return;
      const credential = found?.credentials[0];
      if (credential && (credential.revokedAt != null || credential.expiresAt <= Date.now())) { setUnconfirmed(null); setNotice(t('resolved')); }
      else setUnconfirmed({ ...unconfirmed, integrationId, checked: true, integration: found?.integration, credential });
      await reload();
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const loadMore = async () => {
    if (!nextCursor || disabled) return;
    setBusy(true);
    try {
      const page = await apiRequest<IntegrationPage>(`${basePath}?afterId=${encodeURIComponent(nextCursor)}`);
      if (mounted.current) { setIntegrations(current => [...current, ...page.integrations]); setNextCursor(page.nextCursor); }
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const loadHistory = async (integrationId: string, afterId?: string) => {
    setBusy(true);
    try {
      const page = await apiRequest<CredentialPage>(`${basePath}/${integrationId}/credentials${afterId ? `?afterId=${encodeURIComponent(afterId)}` : ''}`);
      if (mounted.current) setHistory(current => afterId && current?.integration.id === integrationId
        ? { ...page, credentials: [...current.credentials, ...page.credentials] } : page);
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <div className="space-y-5" data-testid="api-access-settings">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t('description')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => { setError(''); setLoading(true); void reload(); }}><RefreshCw className="mr-2 h-4 w-4" />{t('reload')}</Button>
        <Button size="sm" disabled={disabled || Boolean(unconfirmed)} onClick={() => openEditor('create')}><Plus className="mr-2 h-4 w-4" />{t('create')}</Button>
      </div>
    </div>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {unconfirmed && <section className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4" aria-label={t('unconfirmedTitle')}>
      <h3 className="text-sm font-medium">{t('unconfirmedTitle')}</h3>
      <p className="text-sm leading-6 text-muted-foreground">{t('unconfirmedDescription')}</p>
      <p className="break-all font-mono text-xs">{unconfirmed.requestId}</p>
      {unconfirmed.checked && <p className="text-sm">{unconfirmed.credential ? t('unknownKeyFound') : t('unknownKeyNotFound')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void inspectIssue()}>{t('inspect')}</Button>
        {unconfirmed.checked && !unconfirmed.credential && unconfirmed.retry && <Button size="sm" variant="outline" disabled={disabled}
          onClick={() => void mutate(unconfirmed.retry!.path, 'POST', unconfirmed.retry!.body, unconfirmed)}>{t('retrySameRequest')}</Button>}
        {unconfirmed.integration && unconfirmed.credential && <Button size="sm" variant="destructive" disabled={disabled}
          onClick={() => void mutate(`${basePath}/${unconfirmed.integration!.id}/credentials`, 'DELETE',
            { expectedRevision: unconfirmed.integration!.revision, credentialId: unconfirmed.credential!.id }, undefined, true)}>{t('revokeUnknown')}</Button>}
      </div>
    </section>}
    {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</p>}
    {!loading && integrations.length === 0 && <div className="rounded-xl border border-dashed p-6 sm:p-8">
      <KeyRound className="mb-3 h-5 w-5 text-muted-foreground" /><h3 className="font-medium">{t('emptyTitle')}</h3>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{t('emptyDescription')}</p>
    </div>}
    <div className="space-y-3">
      {integrations.map(integration => <section key={integration.id} className="min-w-0 rounded-xl border bg-card p-4 sm:p-5" aria-label={integration.name}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0"><h3 className="break-words font-medium">{integration.name}</h3>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{integration.latestCredential?.prefix ?? integration.id}</p></div>
          <span className="rounded-full border px-2.5 py-1 text-xs">{integration.latestCredential ? status(integration.latestCredential) : t('noKey')}</span>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">{t('workspaces')}</dt><dd className="mt-1 break-words">{integration.workspaceIds.map(id => workspaces.find(workspace => workspace.id === id)?.name ?? id).join(', ')}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('actionsLabel')}</dt><dd className="mt-1">{integration.actions.map(action => t(`actions.${action}`)).join(', ')}</dd></div>
          {integration.latestCredential && <><div><dt className="text-xs text-muted-foreground">{t('expires')}</dt><dd className="mt-1">{date(integration.latestCredential.expiresAt)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('lastUsed')}</dt><dd className="mt-1">{date(integration.latestCredential.lastUsedAt)}</dd></div></>}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => openEditor('edit', integration)}>{t('edit')}</Button>
          <Button variant="outline" size="sm" disabled={disabled || Boolean(unconfirmed)} onClick={() => openEditor('rotate', integration)}>{t('rotate')}</Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void loadHistory(integration.id)}>{t('history')}</Button>
          {integration.latestCredential?.revokedAt == null && integration.latestCredential && <Button variant="destructive" size="sm" disabled={disabled}
            onClick={() => void mutate(`${basePath}/${integration.id}/credentials`, 'DELETE',
              { expectedRevision: integration.revision, credentialId: integration.latestCredential!.id })}>{t('revoke')}</Button>}
        </div>
      </section>)}
    </div>
    {nextCursor && <Button variant="outline" disabled={disabled} onClick={() => void loadMore()}>{t('loadMore')}</Button>}
    {history && <section className="space-y-3 rounded-xl border p-4" aria-label={t('historyTitle', { name: history.integration.name })}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t('historyTitle', { name: history.integration.name })}</h3>
        <Button variant="ghost" size="sm" onClick={() => setHistory(null)}>{t('close')}</Button></div>
      {history.credentials.map(key => <div key={key.id} className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
        <p className="break-all font-mono">{key.prefix}</p><p>{status(key)} · {t('expires')}: {date(key.expiresAt)}</p>
      </div>)}
      {history.nextCursor && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void loadHistory(history.integration.id, history.nextCursor!)}>{t('loadMore')}</Button>}
    </section>}
    <Dialog open={Boolean(editor)} onOpenChange={open => { if (!open && !busy) setEditor(null); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader>
        <DialogTitle>{editor?.mode === 'rotate' ? t('rotateTitle') : editor?.mode === 'edit' ? t('editTitle') : t('createTitle')}</DialogTitle>
        <DialogDescription>{editor?.mode === 'rotate' ? t('rotateDescription') : t('grantDescription')}</DialogDescription>
      </DialogHeader><form onSubmit={submit} className="space-y-5">
        {editor?.mode !== 'rotate' && <>
          <div className="space-y-2"><Label htmlFor="api-access-name">{t('name')}</Label><Input id="api-access-name" value={name} maxLength={100} required disabled={busy} onChange={event => setName(event.target.value)} autoComplete="off" /></div>
          <fieldset className="space-y-2" disabled={busy}><legend className="mb-2 text-sm font-medium">{t('workspaces')}</legend>
            {workspaces.length === 0 && <p className="text-sm text-muted-foreground">{t('noWorkspaces')}</p>}
            {[...new Set([...workspaces.map(workspace => workspace.id), ...workspaceIds])].map(id => <label key={id} className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <input className="mt-0.5" type="checkbox" checked={workspaceIds.includes(id)} onChange={event => setWorkspaceIds(current => event.target.checked ? [...current, id] : current.filter(value => value !== id))} />
              <span className="min-w-0 break-words">{workspaces.find(workspace => workspace.id === id)?.name ?? id}</span></label>)}
          </fieldset>
          <fieldset className="grid gap-2 sm:grid-cols-2" disabled={busy}><legend className="mb-2 text-sm font-medium">{t('actionsLabel')}</legend>
            {API_KEY_ACTIONS.map(action => <label key={action} className="flex items-center gap-3 rounded-md border p-3 text-sm">
              <input type="checkbox" checked={actions.includes(action)} onChange={event => setActions(current => event.target.checked ? [...current, action] : current.filter(value => value !== action))} />{t(`actions.${action}`)}</label>)}
          </fieldset>
        </>}
        {editor?.mode !== 'edit' && <div className="space-y-2"><Label htmlFor="api-access-expiry">{t('expires')}</Label>
          <Input type="date" id="api-access-expiry" required min={expiryBounds.min} max={expiryBounds.max} value={expiresOn} disabled={busy} onChange={event => setExpiresOn(event.target.value)} /></div>}
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
          <Button type="submit" disabled={disabled || editor?.mode !== 'rotate' && (!name.trim() || workspaceIds.length === 0 || actions.length === 0)}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{editor?.mode === 'edit' ? t('save') : editor?.mode === 'rotate' ? t('rotate') : t('create')}</Button></div>
      </form></DialogContent>
    </Dialog>
    <Dialog open={Boolean(issued)} onOpenChange={open => { if (!open) { setIssued(null); setShowKey(false); } }}>
      <DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{t('issuedTitle')}</DialogTitle><DialogDescription>{t('issuedDescription')}</DialogDescription></DialogHeader>
        <Label htmlFor="api-access-issued">{t('key')}</Label>
        <div className="flex min-w-0 gap-2"><Input id="api-access-issued" type={showKey ? 'text' : 'password'} value={issued?.key ?? ''} readOnly autoComplete="off" data-1p-ignore className="min-w-0 font-mono text-xs" />
          <Button variant="outline" size="icon" aria-label={showKey ? t('hideKey') : t('showKey')} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button></div>
        <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => { setIssued(null); setShowKey(false); }}>{t('close')}</Button>
          <Button onClick={async () => { if (!issued) return; try { await navigator.clipboard.writeText(issued.key); setNotice(t('copied')); } catch { setError(t('copyFailed')); } }}><Copy className="mr-2 h-4 w-4" />{t('copy')}</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}
