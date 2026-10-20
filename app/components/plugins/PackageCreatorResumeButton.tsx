'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { MessageSquare, Loader2 } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { startCapabilityPackageCreatorChat } from './creator-chat-client';
import { confirmPluginNavigation } from './plugin-navigation-guard';

export function PackageCreatorResumeButton({ draftRef, workspaceId, disabled = false }: {
  draftRef: string; workspaceId?: string | null; disabled?: boolean;
}) {
  const t = useTranslations('skills.packageEditor'), locale = useLocale(), router = useRouter();
  const [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
  const busy = useRef(false), current = useRef<string | null>(null);
  const key = `${workspaceId ?? ''}:${draftRef}`;
  useLayoutEffect(() => { current.current = key; return () => { current.current = null; }; }, [key]);
  const resume = async () => {
    if (!workspaceId || busy.current) return;
    busy.current = true; setPending(true); setFailed(false);
    try {
      await startCapabilityPackageCreatorChat(workspaceId, { operation: 'resume', draftRef, locale: locale === 'de' ? 'de' : 'en' }, href => router.push(href),
        { isCurrent: () => current.current === key && confirmPluginNavigation() });
    } catch (error) {
      if (current.current === key && !(error instanceof Error && error.name === 'AbortError')) setFailed(true);
    } finally {
      busy.current = false;
      if (current.current === key) setPending(false);
    }
  };
  return <span className="inline-flex flex-col items-start gap-1">
    <Button type="button" size="sm" variant="outline" disabled={disabled || pending || !workspaceId} onClick={() => void resume()} data-testid="package-creator-resume">
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <MessageSquare className="size-4" aria-hidden="true" />}{t('continueInCreator')}
    </Button>
    {failed ? <span className="text-xs text-destructive" role="alert">{t('creatorResumeError')}</span> : null}
  </span>;
}
