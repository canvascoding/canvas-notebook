'use client';

import {
  AudioLines,
  Brain,
  CalendarClock,
  Clapperboard,
  FileText,
  FolderOpen,
  Globe2,
  ListTodo,
  Mail,
  MessagesSquare,
  Network,
  Plug,
  PlugZap,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

const TOOLSET_ICONS: Record<string, LucideIcon> = {
  audio: AudioLines,
  automation: CalendarClock,
  browser: Globe2,
  composio: PlugZap,
  delegation: Network,
  email: Mail,
  file: FolderOpen,
  memory: Brain,
  mcp: Plug,
  pdf: FileText,
  session_search: MessagesSquare,
  skills: Sparkles,
  studio: Clapperboard,
  terminal: Terminal,
  todo: ListTodo,
  web: Search,
};

export function DelegationToolsetIcon({
  toolset,
  className,
}: {
  toolset: string;
  className?: string;
}) {
  const Icon = TOOLSET_ICONS[toolset] || Wrench;
  return <Icon className={cn('h-4 w-4', className)} aria-hidden="true" />;
}
