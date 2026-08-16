'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, Inbox, Loader2, Pencil, Plus, RefreshCw, Save, ShieldAlert, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type Workspace = { id: string; name: string; type: string };

type WorkspaceMailbox = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  status: string;
  accountId: string;
  emailAddress: string;
  displayName: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  smtpUsername: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean | null;
  imapUsername: string | null;
};

type MailboxForm = {
  workspaceId: string;
  emailAddress: string;
  displayName: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  imapUsername: string;
  imapPassword: string;
};

const EMPTY_FORM: MailboxForm = {
  workspaceId: '', emailAddress: '', displayName: '', smtpHost: '', smtpPort: '587', smtpSecure: false,
  smtpUsername: '', smtpPassword: '', imapHost: '', imapPort: '993', imapSecure: true, imapUsername: '', imapPassword: '',
};

function formFromMailbox(mailbox: WorkspaceMailbox): MailboxForm {
  return {
    workspaceId: mailbox.workspaceId,
    emailAddress: mailbox.emailAddress,
    displayName: mailbox.displayName || '',
    smtpHost: mailbox.smtpHost || '',
    smtpPort: mailbox.smtpPort ? String(mailbox.smtpPort) : '587',
    smtpSecure: mailbox.smtpSecure ?? false,
    smtpUsername: mailbox.smtpUsername || '',
    smtpPassword: '',
    imapHost: mailbox.imapHost || '',
    imapPort: mailbox.imapPort ? String(mailbox.imapPort) : '993',
    imapSecure: mailbox.imapSecure ?? true,
    imapUsername: mailbox.imapUsername || '',
    imapPassword: '',
  };
}

export function WorkspaceMailboxesSettingsPanel() {
  const t = useTranslations('settings.workspaceMailboxes');
  const [mailboxes, setMailboxes] = useState<WorkspaceMailbox[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [form, setForm] = useState<MailboxForm>(EMPTY_FORM);
  const [editingMailbox, setEditingMailbox] = useState<WorkspaceMailbox | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isImapOpen, setIsImapOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/admin/workspace-email-mailboxes', { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.load'));
      setMailboxes(Array.isArray(payload.data?.mailboxes) ? payload.data.mailboxes : []);
      setWorkspaces(Array.isArray(payload.data?.workspaces) ? payload.data.workspaces : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const update = <Key extends keyof MailboxForm>(key: Key, value: MailboxForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const openCreate = () => {
    setEditingMailbox(null);
    setForm(EMPTY_FORM);
    setIsImapOpen(false);
    setError(null);
    setMessage(null);
    setIsEditorOpen(true);
  };

  const openEdit = (mailbox: WorkspaceMailbox) => {
    setEditingMailbox(mailbox);
    setForm(formFromMailbox(mailbox));
    setIsImapOpen(Boolean(mailbox.imapHost));
    setError(null);
    setMessage(null);
    setIsEditorOpen(true);
  };

  const save = async () => {
    setAction('save');
    setError(null);
    setMessage(null);
    try {
      const endpoint = editingMailbox
        ? `/api/admin/workspace-email-mailboxes/${encodeURIComponent(editingMailbox.id)}`
        : '/api/admin/workspace-email-mailboxes';
      const response = await fetch(endpoint, {
        method: editingMailbox ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.save'));
      setMessage(t('saved'));
      setIsEditorOpen(false);
      setEditingMailbox(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setAction(null);
    }
  };

  const test = async (mailbox: WorkspaceMailbox) => {
    setAction(`test:${mailbox.id}`);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/workspace-email-mailboxes/${encodeURIComponent(mailbox.id)}/test`, { method: 'POST', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.test'));
      setMessage(t('tested', { address: mailbox.emailAddress }));
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : t('errors.test'));
    } finally {
      setAction(null);
    }
  };

  const remove = async (mailbox: WorkspaceMailbox) => {
    if (!window.confirm(t('removeConfirm', { address: mailbox.emailAddress }))) return;
    setAction(`remove:${mailbox.id}`);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/workspace-email-mailboxes/${encodeURIComponent(mailbox.id)}`, { method: 'DELETE', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.remove'));
      setMessage(t('removed', { address: mailbox.emailAddress }));
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t('errors.remove'));
    } finally {
      setAction(null);
    }
  };

  const isBusy = action !== null;

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base"><Inbox className="h-4 w-4" />{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
          <Button type="button" size="sm" onClick={openCreate} disabled={isLoading || isBusy}>
            <Plus className="mr-2 h-4 w-4" />{t('add')}
          </Button>
        </div>
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-6 text-muted-foreground">{t('sharedHint')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <div className="flex gap-2 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
        {message && <div className="flex gap-2 border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{message}</div>}

        {isEditorOpen && (
          <section className="space-y-4 rounded-xl border border-primary/30 bg-primary/[0.03] p-4 sm:p-5" aria-label={editingMailbox ? t('edit') : t('add')}>
            <div className="flex items-center justify-between gap-3">
              <div><h3 className="font-medium">{editingMailbox ? t('edit') : t('add')}</h3><p className="mt-1 text-sm text-muted-foreground">{t('editorDescription')}</p></div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setIsEditorOpen(false)} disabled={isBusy}>{t('cancel')}</Button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2"><Label htmlFor="workspace-mailbox-workspace">{t('workspace')}</Label><select id="workspace-mailbox-workspace" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.workspaceId} onChange={(event) => update('workspaceId', event.target.value)} disabled={isBusy}><option value="">{t('selectWorkspace')}</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></div>
              <div className="space-y-2"><Label htmlFor="workspace-mailbox-address">{t('emailAddress')}</Label><Input id="workspace-mailbox-address" type="email" value={form.emailAddress} onChange={(event) => update('emailAddress', event.target.value)} disabled={isBusy} placeholder="support@example.com" /></div>
              <div className="space-y-2"><Label htmlFor="workspace-mailbox-name">{t('displayName')}</Label><Input id="workspace-mailbox-name" value={form.displayName} onChange={(event) => update('displayName', event.target.value)} disabled={isBusy} placeholder="Support" /></div>
              <div className="space-y-2"><Label htmlFor="workspace-mailbox-smtp-host">{t('smtpHost')}</Label><Input id="workspace-mailbox-smtp-host" value={form.smtpHost} onChange={(event) => update('smtpHost', event.target.value)} disabled={isBusy} placeholder="smtp.example.com" /></div>
              <div className="space-y-2"><Label htmlFor="workspace-mailbox-smtp-port">{t('smtpPort')}</Label><Input id="workspace-mailbox-smtp-port" inputMode="numeric" value={form.smtpPort} onChange={(event) => update('smtpPort', event.target.value)} disabled={isBusy} /></div>
              <div className="space-y-2"><Label htmlFor="workspace-mailbox-smtp-user">{t('smtpUsername')}</Label><Input id="workspace-mailbox-smtp-user" autoComplete="username" value={form.smtpUsername} onChange={(event) => update('smtpUsername', event.target.value)} disabled={isBusy} /></div>
              <div className="space-y-2"><Label htmlFor="workspace-mailbox-smtp-password">{t('smtpPassword')}</Label><Input id="workspace-mailbox-smtp-password" type="password" autoComplete="new-password" value={form.smtpPassword} onChange={(event) => update('smtpPassword', event.target.value)} disabled={isBusy} placeholder={editingMailbox ? t('passwordUnchanged') : undefined} /></div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background p-3 md:col-span-2"><div><Label htmlFor="workspace-mailbox-smtp-secure">{t('smtpSecure')}</Label><p className="text-xs text-muted-foreground">{t('smtpSecureHint')}</p></div><Switch id="workspace-mailbox-smtp-secure" checked={form.smtpSecure} onCheckedChange={(checked) => update('smtpSecure', checked)} disabled={isBusy} /></div>
            </div>
            <Collapsible open={isImapOpen} onOpenChange={setIsImapOpen}>
              <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm" disabled={isBusy}>{t('imapOptional')}<ChevronDown className={`ml-2 h-4 w-4 transition-transform ${isImapOpen ? 'rotate-180' : ''}`} /></Button></CollapsibleTrigger>
              <CollapsibleContent className="mt-4 grid gap-4 border-t border-border pt-4 md:grid-cols-2">
                <div className="space-y-2"><Label htmlFor="workspace-mailbox-imap-host">{t('imapHost')}</Label><Input id="workspace-mailbox-imap-host" value={form.imapHost} onChange={(event) => update('imapHost', event.target.value)} disabled={isBusy} placeholder="imap.example.com" /></div>
                <div className="space-y-2"><Label htmlFor="workspace-mailbox-imap-port">{t('imapPort')}</Label><Input id="workspace-mailbox-imap-port" inputMode="numeric" value={form.imapPort} onChange={(event) => update('imapPort', event.target.value)} disabled={isBusy} /></div>
                <div className="space-y-2"><Label htmlFor="workspace-mailbox-imap-user">{t('imapUsername')}</Label><Input id="workspace-mailbox-imap-user" autoComplete="username" value={form.imapUsername} onChange={(event) => update('imapUsername', event.target.value)} disabled={isBusy} /></div>
                <div className="space-y-2"><Label htmlFor="workspace-mailbox-imap-password">{t('imapPassword')}</Label><Input id="workspace-mailbox-imap-password" type="password" autoComplete="new-password" value={form.imapPassword} onChange={(event) => update('imapPassword', event.target.value)} disabled={isBusy} placeholder={editingMailbox ? t('passwordUnchanged') : undefined} /></div>
                <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background p-3 md:col-span-2"><div><Label htmlFor="workspace-mailbox-imap-secure">{t('imapSecure')}</Label></div><Switch id="workspace-mailbox-imap-secure" checked={form.imapSecure} onCheckedChange={(checked) => update('imapSecure', checked)} disabled={isBusy} /></div>
              </CollapsibleContent>
            </Collapsible>
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setIsEditorOpen(false)} disabled={isBusy}>{t('cancel')}</Button><Button type="button" onClick={() => void save()} disabled={isBusy}>{action === 'save' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t('save')}</Button></div>
          </section>
        )}

        {isLoading ? <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</div>
          : mailboxes.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm leading-6 text-muted-foreground">{t('empty')}</div>
          : <div className="space-y-3">{mailboxes.map((mailbox) => (
            <article key={mailbox.id} className="rounded-xl border border-border bg-card p-4 shadow-xs sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-medium">{mailbox.emailAddress}</h3><Badge variant="outline">{mailbox.workspaceName}</Badge>{mailbox.imapHost ? <Badge variant="secondary">IMAP</Badge> : <Badge variant="secondary">{t('sendOnly')}</Badge>}</div>{mailbox.displayName && <p className="mt-1 text-sm text-muted-foreground">{mailbox.displayName}</p>}<p className="mt-3 text-xs text-muted-foreground">SMTP · {mailbox.smtpHost}:{mailbox.smtpPort}</p></div>
                <div className="flex shrink-0 flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={() => void test(mailbox)} disabled={isBusy}>{action === `test:${mailbox.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}{t('test')}</Button><Button type="button" size="sm" variant="outline" onClick={() => openEdit(mailbox)} disabled={isBusy}><Pencil className="mr-2 h-4 w-4" />{t('edit')}</Button><Button type="button" size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => void remove(mailbox)} disabled={isBusy}>{action === `remove:${mailbox.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}{t('remove')}</Button></div></div>
            </article>
          ))}</div>}
      </CardContent>
    </Card>
  );
}
