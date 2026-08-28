'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Inbox, Loader2, Pencil, Plus, RefreshCw, Save, ShieldAlert, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { MailboxConnectionForm, type MailboxConnectionDraft } from '@/app/components/email/MailboxConnectionForm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Mailbox = { id: string; workspaceName: string | null; emailAddress: string; displayName: string | null; smtpHost: string | null; smtpPort: number | null; smtpSecure: boolean | null; smtpUsername: string | null; imapHost: string | null; imapPort: number | null; imapSecure: boolean | null; imapUsername: string | null };
const emptyForm: MailboxConnectionDraft = { emailAddress: '', displayName: '', smtpHost: '', smtpPort: '587', smtpSecure: false, smtpUsername: '', smtpPassword: '', imapEnabled: true, imapHost: '', imapPort: '993', imapSecure: true, imapUsername: '', imapPassword: '' };
const formFromMailbox = (mailbox: Mailbox): MailboxConnectionDraft => ({ emailAddress: mailbox.emailAddress, displayName: mailbox.displayName || '', smtpHost: mailbox.smtpHost || '', smtpPort: mailbox.smtpPort ? String(mailbox.smtpPort) : '587', smtpSecure: mailbox.smtpSecure ?? false, smtpUsername: mailbox.smtpUsername || '', smtpPassword: '', imapEnabled: Boolean(mailbox.imapHost), imapHost: mailbox.imapHost || '', imapPort: mailbox.imapPort ? String(mailbox.imapPort) : '993', imapSecure: mailbox.imapSecure ?? true, imapUsername: mailbox.imapUsername || '', imapPassword: '' });

export function WorkspaceMailboxesSettingsPanel() {
  const t = useTranslations('settings.workspaceMailboxes');
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const busy = action !== null;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/workspace-email-mailboxes', { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.load'));
      setMailboxes(Array.isArray(payload.data?.mailboxes) ? payload.data.mailboxes : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('errors.load')); } finally { setLoading(false); }
  }, [t]);
  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);
  const mailboxPayload = () => ({ ...form, imapHost: form.imapEnabled ? form.imapHost : '', imapPort: form.imapEnabled ? form.imapPort : '', imapUsername: form.imapEnabled ? form.imapUsername : '', imapPassword: form.imapEnabled ? form.imapPassword : '' });
  const showCreate = () => { setEditing(null); setForm(emptyForm); setError(null); setMessage(null); setOpen(true); };
  const showEdit = (mailbox: Mailbox) => { setEditing(mailbox); setForm(formFromMailbox(mailbox)); setError(null); setMessage(null); setOpen(true); };
  const testDraft = async () => {
    setAction('test-draft'); setError(null); setMessage(null);
    try {
      const response = await fetch('/api/admin/workspace-email-mailboxes/test', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...mailboxPayload(), accountId: editing?.id }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.test'));
      setMessage(t('draftTested'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('errors.test')); } finally { setAction(null); }
  };
  const save = async () => {
    setAction('save'); setError(null); setMessage(null);
    try {
      const endpoint = editing ? `/api/admin/workspace-email-mailboxes/${encodeURIComponent(editing.id)}` : '/api/admin/workspace-email-mailboxes';
      const response = await fetch(endpoint, { method: editing ? 'PATCH' : 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...mailboxPayload(), verifyConnection: true }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.save'));
      setMessage(t('saved')); setOpen(false); setEditing(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('errors.save')); } finally { setAction(null); }
  };
  const testStored = async (mailbox: Mailbox) => {
    setAction(`test:${mailbox.id}`); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/admin/workspace-email-mailboxes/${encodeURIComponent(mailbox.id)}/test`, { method: 'POST', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.test'));
      setMessage(t('tested', { address: mailbox.emailAddress }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('errors.test')); } finally { setAction(null); }
  };
  const remove = async (mailbox: Mailbox) => {
    if (!window.confirm(t('removeConfirm', { address: mailbox.emailAddress }))) return;
    setAction(`remove:${mailbox.id}`); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/admin/workspace-email-mailboxes/${encodeURIComponent(mailbox.id)}`, { method: 'DELETE', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.remove'));
      setMessage(t('removed', { address: mailbox.emailAddress })); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('errors.remove')); } finally { setAction(null); }
  };
  return <><Card><CardHeader className="gap-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><CardTitle className="flex items-center gap-2 text-base"><Inbox className="h-4 w-4" />{t('title')}</CardTitle><CardDescription>{t('description')}</CardDescription></div><Button type="button" size="sm" onClick={showCreate} disabled={loading || busy}><Plus className="mr-2 h-4 w-4" />{t('add')}</Button></div><p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-6 text-muted-foreground">{t('sharedHint')}</p></CardHeader><CardContent className="space-y-4">{error && <div className="flex gap-2 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}{message && <div className="flex gap-2 border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{message}</div>}{loading ? <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</div> : mailboxes.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm leading-6 text-muted-foreground">{t('empty')}</div> : <div className="space-y-3">{mailboxes.map((mailbox) => <article key={mailbox.id} className="rounded-xl border border-border bg-card p-4 shadow-xs sm:p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-medium">{mailbox.emailAddress}</h3><Badge variant="outline">{mailbox.workspaceName || t('unassigned')}</Badge>{mailbox.imapHost ? <Badge variant="secondary">IMAP</Badge> : <Badge variant="secondary">{t('sendOnly')}</Badge>}</div>{mailbox.displayName && <p className="mt-1 text-sm text-muted-foreground">{mailbox.displayName}</p>}<p className="mt-3 text-xs text-muted-foreground">SMTP · {mailbox.smtpHost}:{mailbox.smtpPort}</p></div><div className="flex shrink-0 flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={() => void testStored(mailbox)} disabled={busy}>{action === `test:${mailbox.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}{t('test')}</Button><Button type="button" size="sm" variant="outline" onClick={() => showEdit(mailbox)} disabled={busy}><Pencil className="mr-2 h-4 w-4" />{t('edit')}</Button><Button type="button" size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => void remove(mailbox)} disabled={busy}>{action === `remove:${mailbox.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}{t('remove')}</Button></div></div></article>)}</div>}</CardContent></Card><Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}><DialogContent className="max-h-[calc(100dvh-2rem)] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>{editing ? t('edit') : t('add')}</DialogTitle><DialogDescription>{t('editorDescription')}</DialogDescription></DialogHeader>{error && <p className="text-sm text-destructive">{error}</p>}<MailboxConnectionForm value={form} onChange={setForm} disabled={busy} isEditing={Boolean(editing)} /><div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t('cancel')}</Button><Button type="button" variant="outline" onClick={() => void testDraft()} disabled={busy}>{action === 'test-draft' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('test')}</Button><Button type="button" onClick={() => void save()} disabled={busy}>{action === 'save' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t('testAndSave')}</Button></div></DialogContent></Dialog></>;
}
