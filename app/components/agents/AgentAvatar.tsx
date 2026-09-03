'use client';

import Image from 'next/image';

import { DEFAULT_AGENT_ICON_ID, normalizeAgentIconId, type AgentIconId } from '@/app/lib/agents/icons';
import { cn } from '@/lib/utils';

const AGENT_ICON_PATHS: Record<AgentIconId, string> = {
  bot: '/images/agents/origami/bot.svg',
  sparkles: '/images/agents/origami/sparkles.svg',
  search: '/images/agents/origami/search.svg',
  code: '/images/agents/origami/code.svg',
  palette: '/images/agents/origami/palette.svg',
  briefcase: '/images/agents/origami/briefcase.svg',
  calendar: '/images/agents/origami/calendar.svg',
  messages: '/images/agents/origami/messages.svg',
  brain: '/images/agents/origami/brain.svg',
  wrench: '/images/agents/origami/wrench.svg',
  rocket: '/images/agents/origami/rocket.svg',
  shield: '/images/agents/origami/shield.svg',
  email: '/images/agents/origami/email.svg',
};

export function AgentIcon({
  iconId,
  className,
}: {
  iconId?: AgentIconId | string | null;
  className?: string;
}) {
  const normalizedIconId = normalizeAgentIconId(iconId);
  const src = AGENT_ICON_PATHS[normalizedIconId] || AGENT_ICON_PATHS[DEFAULT_AGENT_ICON_ID];

  return (
    <Image
      src={src}
      alt=""
      aria-hidden="true"
      width={64}
      height={64}
      sizes="64px"
      draggable={false}
      unoptimized
      data-agent-icon-id={normalizedIconId}
      className={cn('select-none object-contain', className)}
    />
  );
}

export function AgentAvatar({
  iconId,
  className,
  iconClassName,
}: {
  iconId?: AgentIconId | string | null;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-foreground',
        className,
      )}
      aria-hidden="true"
    >
      <AgentIcon iconId={iconId} className={cn('h-5 w-5', iconClassName)} />
    </span>
  );
}
