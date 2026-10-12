'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { loadEmailReplyRecipientSuggestions } from '@/app/lib/email/recipient-discovery-client';
import type { EmailReplyRecipientSuggestions } from '@/app/lib/email/recipient-discovery-types';
import { EmailRecipientSource, EmailRecipientSourceDetails } from './EmailRecipientInput';
import { composeRecipientExclusions } from './email-compose-utils';

export function EmailReplyRecipientSuggestions({ accountId, mailboxWorkspaceId, messageId, folder, exclude, disabled, onAdd }: {
  accountId?: string; mailboxWorkspaceId?: string | null; messageId: string; folder?: string; exclude: string[]; disabled?: boolean;
  onAdd(address: string, field: 'to' | 'cc'): void;
}) {
  const t = useTranslations('EmailRecipients');
  const scopeKey = JSON.stringify([accountId, mailboxWorkspaceId || null, messageId, folder]);
  const excluded = composeRecipientExclusions(exclude);
  const excludeKey = JSON.stringify(excluded);
  const key = JSON.stringify([scopeKey, excludeKey, Boolean(disabled)]);
  const currentKey = useRef(key);
  useLayoutEffect(() => { currentKey.current = key; }, [key]);
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ scope: string; key?: string; loading?: boolean; error?: boolean; result?: EmailReplyRecipientSuggestions } | null>(null);
  useEffect(() => () => { request.current?.abort(); }, [key]);
  const current = !disabled && state?.scope === scopeKey ? state : null;
  const candidates = current?.result?.optionalAdditionalRecipients.filter(candidate => !excluded.includes(candidate.address.toLowerCase())).slice(0, 5) || [];
  const load = async () => {
    if (!accountId || disabled) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setState({ scope: scopeKey, key, loading: true });
    try {
      const result = await loadEmailReplyRecipientSuggestions({ accountId, mailboxWorkspaceId, messageId, folder, replyMode: 'reply', exclude: JSON.parse(excludeKey).slice(0, 50) }, controller.signal);
      if (!controller.signal.aborted && currentKey.current === key) setState({ scope: scopeKey, result });
    } catch {
      if (!controller.signal.aborted && currentKey.current === key) setState({ scope: scopeKey, error: true });
    }
  };
  return <div className="space-y-2">
    <Button type="button" variant="ghost" size="sm" disabled={disabled || !accountId || current?.loading && current.key === key} onClick={() => void load()}>
      {current?.loading && current.key === key ? <Loader2 className="size-3.5 animate-spin" /> : <Users className="size-3.5" />}{t('moreParticipants')}
    </Button>
    {current?.error ? <p role="status" className="text-xs text-muted-foreground">{t('unavailable')}</p> : null}
    {current?.result ? <div className="rounded-md border bg-background">
      <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{candidates.length ? t('currentMessageOnly') : t('noAdditionalParticipants')}</p>
      {candidates.map(candidate => <div key={candidate.address} className="border-t">
        <div className="flex flex-wrap items-start gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">{candidate.name ? <p className="text-sm font-medium">{candidate.name}</p> : null}<p className="break-all text-sm">{candidate.address}</p><EmailRecipientSource candidate={candidate} /></div>
          <div className="flex gap-1">{(['to', 'cc'] as const).map(field => <Button type="button" key={field} variant="outline" size="sm" disabled={disabled}
            aria-label={t(field === 'to' ? 'addToAddress' : 'addCcAddress', { address: candidate.address })}
            onClick={() => { if (!disabled && currentKey.current === key && !excluded.includes(candidate.address.toLowerCase())) onAdd(candidate.address, field); }}>{t(field === 'to' ? 'addTo' : 'addCc')}</Button>)}</div>
        </div><EmailRecipientSourceDetails candidate={candidate} />
      </div>)}
      {current.result.omittedCount ? <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t('additionalOmitted')}</p> : null}
    </div> : null}
  </div>;
}
