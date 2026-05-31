'use client';

import {
  Bot,
  Brain,
  BriefcaseBusiness,
  CalendarClock,
  Code2,
  MessageSquare,
  Palette,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { DEFAULT_AGENT_ICON_ID, normalizeAgentIconId, type AgentIconId } from '@/app/lib/agents/icons';
import { cn } from '@/lib/utils';

const AGENT_ICON_COMPONENTS: Record<AgentIconId, LucideIcon> = {
  bot: Bot,
  sparkles: Sparkles,
  search: Search,
  code: Code2,
  palette: Palette,
  briefcase: BriefcaseBusiness,
  calendar: CalendarClock,
  messages: MessageSquare,
  brain: Brain,
  wrench: Wrench,
  rocket: Rocket,
  shield: ShieldCheck,
};

export function AgentIcon({
  iconId,
  className,
}: {
  iconId?: AgentIconId | string | null;
  className?: string;
}) {
  const Icon = AGENT_ICON_COMPONENTS[normalizeAgentIconId(iconId)] || AGENT_ICON_COMPONENTS[DEFAULT_AGENT_ICON_ID];
  return <Icon className={className} aria-hidden="true" />;
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
