'use client';

import { ExternalLink, UsersRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';

const HOSTED_NOTEBOOK_URL = 'https://canvasnotebook.app';

export function TeamModeHostedOnlyNotice({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const t = useTranslations('teamModeHostedOnly');

  return (
    <InlineNotice
      variant="info"
      size={compact ? 'compact' : 'default'}
      actionLayout={compact ? 'stacked' : 'responsive'}
      className={className}
      icon={<UsersRound aria-hidden="true" />}
      title={t('title')}
      actions={<Button asChild size="sm" variant="outline">
        <a href={HOSTED_NOTEBOOK_URL} target="_blank" rel="noreferrer">
          {t('button')}
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </Button>}
    >
      {t('description')}
    </InlineNotice>
  );
}
