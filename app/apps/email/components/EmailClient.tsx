'use client';

import { useState } from 'react';
import { Inbox } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { EmailAccountsCard } from '@/app/components/settings/IntegrationsSettingsClient';

export function EmailClient() {
  const t = useTranslations('emails');
  const [accountsOpen, setAccountsOpen] = useState(true);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
      <section className="border border-border bg-card px-4 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
            <Inbox className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-semibold tracking-tight">{t('title')}</h2>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('description')}</p>
          </div>
        </div>
      </section>

      <EmailAccountsCard isOpen={accountsOpen} onOpenChange={setAccountsOpen} />
    </div>
  );
}
