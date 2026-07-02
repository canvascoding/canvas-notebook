'use client';

import { ExternalLink, UsersRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm',
        compact ? 'flex-col' : 'sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          <UsersRound className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-foreground">{t('title')}</span>
          <span className="mt-1 block text-muted-foreground">{t('description')}</span>
        </span>
      </div>
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <a href={HOSTED_NOTEBOOK_URL} target="_blank" rel="noreferrer">
          {t('button')}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Button>
    </div>
  );
}
