'use client';

import React from 'react';
import {
  BriefcaseBusiness,
  Clapperboard,
  FileText,
  FolderTree,
  History,
  Megaphone,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AISession } from '@/app/lib/chat/types';
import type { StarterPromptDefinition, StarterPromptIcon } from '@/app/lib/chat/starter-prompts';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

const STARTER_PROMPT_ICONS: Record<StarterPromptIcon, React.ComponentType<{ className?: string }>> = {
  campaign: Megaphone,
  creative: WandSparkles,
  video: Clapperboard,
  strategy: BriefcaseBusiness,
  document: FileText,
  organize: FolderTree,
};

function StarterPromptButton({
  prompt,
  onSelect,
  compact = false,
}: {
  prompt: StarterPromptDefinition;
  onSelect: (value: string) => void;
  compact?: boolean;
}) {
  const t = useTranslations('chat');
  const Icon = STARTER_PROMPT_ICONS[prompt.icon];

  return (
    <button
      type="button"
      data-testid={`chat-starter-prompt-${prompt.id}`}
      onClick={() => onSelect(prompt.prompt)}
      className={cn(
        'group flex h-full w-full min-w-0 flex-col items-start overflow-hidden border border-border bg-background/90 text-left text-foreground transition-colors hover:border-primary/40 hover:bg-accent',
        compact ? 'gap-2 p-2.5' : 'gap-3 p-4',
      )}
    >
      <span className="inline-flex max-w-full min-w-0 items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground">
        <Icon className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 truncate">{t('example')}</span>
      </span>
      <div className="min-w-0 space-y-1">
        <div className={`${compact ? 'text-sm' : 'text-base'} line-clamp-2 min-w-0 break-words font-semibold [overflow-wrap:anywhere]`}>
          {prompt.title}
        </div>
        <p className={`${compact ? 'line-clamp-2 text-xs' : 'line-clamp-3 text-sm'} min-w-0 break-words leading-relaxed text-muted-foreground [overflow-wrap:anywhere]`}>
          {prompt.description}
        </p>
      </div>
    </button>
  );
}

export function ChatStarterScreen({
  latestSession,
  sessionBasePath,
  isStudioChatContext,
  prompts,
  isCompactView,
  onSelectPrompt,
}: {
  latestSession: AISession | null;
  sessionBasePath: string;
  isStudioChatContext: boolean;
  prompts: StarterPromptDefinition[];
  isCompactView: boolean;
  onSelectPrompt: (value: string) => void;
}) {
  const t = useTranslations('chat');

  return (
    <div className="flex min-h-full min-w-0 flex-col justify-start py-4 md:justify-center md:py-0">
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col items-center gap-5 text-center">
        <div className="w-full min-w-0 space-y-2">
          <span className="inline-flex max-w-full min-w-0 items-center justify-center gap-2 overflow-hidden border border-border bg-background/80 px-3 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
            <Sparkles className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 truncate">{t('productivityBadge')}</span>
          </span>
          {latestSession ? (
            <div className="flex min-w-0 justify-center">
              <Link
                href={`${sessionBasePath}?session=${encodeURIComponent(latestSession.sessionId)}`}
                className="inline-flex max-w-full min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 overflow-hidden border border-border bg-background/80 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-accent"
              >
                <History className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="min-w-0 truncate font-medium">{t('openLatestSession')}</span>
                <span className="min-w-0 max-w-full truncate text-muted-foreground sm:max-w-[14rem]">{latestSession.title || latestSession.sessionId}</span>
              </Link>
            </div>
          ) : null}
          <div className="space-y-1">
            <h2 className="mx-auto max-w-3xl break-words text-xl font-semibold text-foreground [overflow-wrap:anywhere] md:text-2xl">
              {t(isStudioChatContext ? 'studioStarterTitle' : 'starterTitle')}
            </h2>
            <p className="mx-auto max-w-2xl break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {t(isStudioChatContext ? 'studioStarterDescription' : 'starterDescription')}
            </p>
          </div>
        </div>
        <div
          data-testid="chat-starter-prompts"
          className="grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 pb-3"
        >
          {prompts.map((prompt) => (
            <StarterPromptButton
              key={prompt.id}
              prompt={prompt}
              onSelect={onSelectPrompt}
              compact={isCompactView}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
