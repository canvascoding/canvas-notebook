'use client';

import Link from 'next/link';
import { Building2, Mail, ArrowRight, Settings } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { EmailAccount } from './email-client-types';

export type EmailMailboxSetup = {
  canManageBusiness: boolean;
  manageableWorkspaces: Array<{ id: string; name: string }>;
};

/** Explains ownership before asking for credentials; setup never blocks the rest of the app. */
export function EmailSetupGuide({ setup, account, onPersonalSetup, onCompose, denied = false }: {
  setup: EmailMailboxSetup;
  account?: EmailAccount | null;
  onPersonalSetup(): void;
  onCompose?(): void;
  denied?: boolean;
}) {
  const t = useTranslations('emailMailboxes');
  const locale = useLocale();
  const settingsHref = `/${locale}/settings?tab=system-email`;
  const workspaces = account?.workspaceId
    ? setup.manageableWorkspaces.filter(workspace => workspace.id === account.workspaceId)
    : setup.manageableWorkspaces;
  const shared = Boolean(account?.workspaceId);
  const sendOnly = account?.connectionState === 'send_only';
  const reconnect = account?.connectionState === 'reconnect_required';
  const workspaceLinks = workspaces.map(workspace => <Button key={workspace.id} variant="outline" className="h-auto min-h-9 w-full justify-between gap-2 whitespace-normal py-2 text-left" asChild>
    <Link href={`/${locale}/settings?tab=workspace&workspaceManagement=1&mailboxWorkspaceId=${encodeURIComponent(workspace.id)}`}>
      <span>{t('assignWorkspace', { name: workspace.name })}</span><ArrowRight className="size-4 shrink-0" />
    </Link>
  </Button>);
  const sharedActions = <div className="space-y-3">
    {setup.canManageBusiness && <Button data-testid="email-setup-business" className="h-auto min-h-9 w-full whitespace-normal py-2" asChild><Link href={settingsHref}><Settings className="size-4 shrink-0" />{t('manageBusiness')}</Link></Button>}
    {workspaceLinks.length > 0 && <div className="space-y-2"><p className="text-xs text-muted-foreground">{t('assignmentHint')}</p>{workspaceLinks}</div>}
    {!setup.canManageBusiness && <p className="text-sm leading-6 text-muted-foreground">{t(workspaces.length ? 'askConnectionAdmin' : 'askAdmin')}</p>}
  </div>;

  if (account) return <section data-testid={reconnect || denied ? 'email-mailbox-repair' : sendOnly ? 'email-mailbox-send-only' : 'email-mailbox-settings'} className="mx-auto w-full max-w-2xl space-y-4 rounded-md border border-border bg-card p-4 sm:p-6">
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{shared ? `${t('workspace')} · ${account.workspaceName || ''}` : t('personal')}</p>
      <h3 className="break-words text-base font-semibold">{account.emailAddress}</h3>
      <h4 className="font-medium">{t(denied ? 'accessChangedTitle' : reconnect ? 'reconnectTitle' : sendOnly ? 'sendOnlyTitle' : 'manageMailboxTitle')}</h4>
      <p className="text-sm leading-6 text-muted-foreground">{t(denied ? 'accessChangedDescription' : reconnect ? 'reconnectDescription' : sendOnly ? 'sendOnlyDescription' : shared ? 'sharedOwnership' : 'personalOwnership')}</p>
    </div>
    {shared ? sharedActions : <Button data-testid="email-setup-personal-repair" className="h-auto min-h-9 whitespace-normal" onClick={onPersonalSetup}><Settings className="size-4 shrink-0" />{t('managePersonal')}</Button>}
    {sendOnly && account.capabilities?.canWrite !== false && !denied && onCompose && <Button variant="outline" onClick={onCompose}>{t('composeNow')}</Button>}
    <details className="border-t border-border pt-3 text-sm"><summary className="cursor-pointer font-medium">{t('connectionHelp')}</summary><p className="mt-2 leading-6 text-muted-foreground">{t('connectionHelpDescription')}</p></details>
  </section>;

  return <section data-testid="email-setup-guide" className="space-y-5">
    <header className="space-y-2">
      <h2 className="text-xl font-semibold tracking-tight">{t('setupTitle')}</h2>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t('setupDescription')}</p>
    </header>
    <div className="grid gap-3 md:grid-cols-2">
      <article className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2"><Mail className="size-5 text-primary" /><h3 className="font-semibold">{t('personal')}</h3></div>
        <p className="text-sm leading-6 text-muted-foreground">{t('personalOwnership')}</p>
        <Button data-testid="email-setup-personal" className="mt-auto h-auto min-h-9 whitespace-normal py-2" onClick={onPersonalSetup}>{t('connectPersonal')}<ArrowRight className="size-4 shrink-0" /></Button>
      </article>
      <article className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2"><Building2 className="size-5 text-primary" /><h3 className="font-semibold">{t('sharedTitle')}</h3></div>
        <p className="text-sm leading-6 text-muted-foreground">{t('sharedOwnership')}</p>
        <div className="mt-auto">{sharedActions}</div>
      </article>
    </div>
    <details className="rounded-md border border-border px-4 py-3 text-sm"><summary className="cursor-pointer font-medium">{t('connectionHelp')}</summary><p className="mt-2 leading-6 text-muted-foreground">{t('connectionHelpDescription')}</p></details>
    <div className="flex flex-wrap items-center gap-3"><Button data-testid="email-setup-later" variant="ghost" asChild><Link href={`/${locale}`}>{t('setupLater')}</Link></Button><p className="text-xs text-muted-foreground">{t('setupLaterHint')}</p></div>
  </section>;
}
