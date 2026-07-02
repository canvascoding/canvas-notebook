'use client';

import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  ChevronLeft,
  History,
  Lightbulb,
  Plus,
  Settings,
  Wrench,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { ChatAgentSelector } from '@/app/components/canvas-agent-chat/ChatAgentSelector';
import { ChatRuntimeActivityBadge } from '@/app/components/canvas-agent-chat/ChatRuntimeActivityBadge';
import { WorkspaceSwitcher } from '@/app/components/workspaces/WorkspaceSwitcher';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import type { AgentProfile } from '@/app/lib/chat/types';
import type { ToolVerbosity } from '@/app/store/tool-verbosity-store';
import { cn } from '@/lib/utils';

type ChatHeaderProps = {
  activeAgentDisplayName: string;
  activeAgentIconId?: string | null;
  activeSessionAgentId: string;
  activeToolLabel?: string;
  chatAgentOptions: AgentProfile[];
  contextCompactLabel: string;
  contextDetailedLabel: string;
  contextProgressPercent: number;
  contextTooltip: string;
  hideNavHeader: boolean;
  isCompactView: boolean;
  isHistoryOverlayOpen: boolean;
  isMobile: boolean;
  onCompact: () => void;
  onSelectAgent: (agentId: string) => void;
  onSetShowHistory: (value: boolean) => void;
  onStartNewChat: () => void;
  runtimeStatus: RuntimeStatus | null;
  sessionDisplayLabel: string;
  sessionId: string | null;
  showHistory: boolean;
  showSkillsLink: boolean;
  toolVerbosity: ToolVerbosity;
  totalQueuedMessages: number;
  totalUnreadCount: number;
};

export function ChatHeader({
  activeAgentDisplayName,
  activeAgentIconId,
  activeSessionAgentId,
  activeToolLabel,
  chatAgentOptions,
  contextCompactLabel,
  contextDetailedLabel,
  contextProgressPercent,
  contextTooltip,
  hideNavHeader,
  isCompactView,
  isHistoryOverlayOpen,
  isMobile,
  onCompact,
  onSelectAgent,
  onSetShowHistory,
  onStartNewChat,
  runtimeStatus,
  sessionDisplayLabel,
  sessionId,
  showHistory,
  showSkillsLink,
  toolVerbosity,
  totalQueuedMessages,
  totalUnreadCount,
}: ChatHeaderProps) {
  const t = useTranslations('chat');
  const tCommon = useTranslations('common');

  return (
    <>
      {!hideNavHeader && (
        <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)]">
          <div className="mx-auto flex h-full items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
                <Link href="/">
                  <ArrowLeft className="h-4 w-4" />
                  <span className="hidden sm:inline">{tCommon('suite')}</span>
                </Link>
              </Button>
              <h1 className="hidden truncate text-lg font-bold md:block md:text-2xl">{t('title')}</h1>
            </div>
            <div className="flex items-center gap-1.5 md:gap-4">
              <ThemeToggle />
              <Button asChild variant="outline" size="sm" className="hidden gap-2 px-2 sm:px-3 md:inline-flex">
                <Link href="/usage">{t('usage')}</Link>
              </Button>
            </div>
          </div>
        </header>
      )}

        <div className={cn('z-10 border-b border-border bg-background/95', isHistoryOverlayOpen ? 'hidden' : null)}>
        <div className="flex items-center gap-2 px-3 py-2 md:flex-wrap">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {showHistory ? (
              <button
                type="button"
                aria-label={t('backToChat')}
                onClick={() => onSetShowHistory(false)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent transition-colors hover:border-border hover:bg-accent"
                title={t('backToChat')}
              >
                <ChevronLeft size={18} />
              </button>
            ) : (
              <button
                type="button"
                data-testid="chat-history-toggle"
                aria-label={t('toggleSidebar')}
                onClick={() => onSetShowHistory(true)}
                className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent transition-colors hover:border-border hover:bg-accent"
                title={t('toggleSidebar')}
              >
                <History size={18} />
                {totalUnreadCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white">
                    {totalUnreadCount > 9 ? '9+' : totalUnreadCount}
                  </span>
                )}
              </button>
            )}
            <div
              data-testid="chat-session-id"
              title={sessionId || t('newChatTitle')}
              className="inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-2 text-[11px] font-medium text-foreground md:max-w-[min(18rem,100%)]"
            >
              <span className="hidden text-[9px] uppercase tracking-[0.15em] text-muted-foreground sm:inline">{t('sessionLabel')}</span>
              <span className="min-w-0 truncate">{sessionDisplayLabel}</span>
            </div>
            <ChatAgentSelector
              variant={isMobile ? 'mobile' : 'desktop'}
              activeAgentId={activeSessionAgentId}
              activeAgentName={activeAgentDisplayName}
              activeAgentIconId={activeAgentIconId}
              agents={chatAgentOptions}
              onSelectAgent={onSelectAgent}
              iconOnly={isMobile}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 md:ml-auto">
            <WorkspaceSwitcher source="chat" variant="compact" className="hidden sm:inline-flex" />
            <button
              type="button"
              aria-label={t('newChatTitle')}
              onClick={onStartNewChat}
              className="group inline-flex h-7 w-7 items-center justify-center rounded-md border border-primary/30 bg-primary/15 text-primary transition-all hover:bg-primary/25"
              title={t('newChatTitle')}
            >
              <Plus size={16} />
              <span className="sr-only">{t('newChatShort')}</span>
            </button>
            {showSkillsLink && (
              <Link
                href="/settings?tab=plugins"
                aria-label={t('viewSkills')}
                className="group inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
                title={t('viewSkills')}
              >
                <Lightbulb size={16} />
                <span className="sr-only">{t('skills')}</span>
              </Link>
            )}
          </div>
        </div>

        <div data-testid="chat-runtime-banner" className="border-t border-border/50 px-3 py-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div data-testid="chat-runtime-status" className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:flex-initial">
              <ChatRuntimeActivityBadge status={runtimeStatus} className="h-7" />
              {isMobile ? <WorkspaceSwitcher source="chat" variant="compact" /> : null}

              {runtimeStatus && totalQueuedMessages > 0 && (
                <span className="inline-flex h-7 items-center gap-1 border border-border/60 bg-muted/40 px-1.5 text-[10px] text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  {t('queuedCount', { count: totalQueuedMessages })}
                </span>
              )}

              {!isMobile && runtimeStatus?.includedSummary && (
                <span className="inline-flex h-7 items-center border border-border/60 bg-muted/40 px-1.5 text-[10px] text-muted-foreground">
                  {t('summary')}
                </span>
              )}

              {!isMobile && runtimeStatus?.activeTool && toolVerbosity !== 'minimal' && (
                <span className="inline-flex h-7 items-center gap-1 border border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] text-amber-600">
                  <Wrench size={10} />
                  {toolVerbosity === 'verbose' ? runtimeStatus.activeTool.name : activeToolLabel}
                </span>
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5 sm:flex-initial">
              {!isMobile ? (
                <span
                  data-testid="chat-context-meter"
                  title={contextTooltip}
                  className="inline-flex h-7 min-w-0 max-w-full items-center rounded-md border border-border/60 bg-muted/40 px-2.5 text-[10px] font-medium text-muted-foreground md:max-w-[min(20rem,40vw)]"
                >
                  <span className="min-w-0 truncate">{contextDetailedLabel}</span>
                </span>
              ) : null}
              {!isMobile && (
                <>
                  <button
                    type="button"
                    data-testid="chat-compact"
                    onClick={onCompact}
                    disabled={!sessionId || runtimeStatus?.phase !== 'idle'}
                    className="h-7 rounded-md border border-border bg-muted/50 px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('compact')}
                  </button>
                  <Link
                    href="/settings?tab=agent"
                    aria-label={t('openAgentSettings')}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2.5 text-[11px] font-medium text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
                    title={t('openAgentSettings')}
                  >
                    <Settings className="h-3 w-3" />
                    {!isCompactView ? <span>{t('settings')}</span> : null}
                  </Link>
                </>
              )}
              {isMobile && (
                <>
                  <button
                    type="button"
                    data-testid="chat-compact"
                    onClick={onCompact}
                    disabled={!sessionId || runtimeStatus?.phase !== 'idle'}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted/50 px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                    title={t('compact')}
                  >
                    {t('compact')}
                  </button>
                  <Link
                    href="/settings?tab=agent"
                    data-testid="chat-mobile-agent-settings"
                    aria-label={t('openAgentSettings')}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
                    title={t('openAgentSettings')}
                  >
                    <Settings className="h-3 w-3" />
                  </Link>
                </>
              )}
            </div>
          </div>

          <div className="mt-1.5 flex items-center gap-2" title={contextTooltip}>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-black/5 dark:bg-gray-700">
              <div
                data-testid="chat-context-progress"
                className={`h-full rounded-full transition-all ${
                  runtimeStatus?.phase === 'aborting'
                    ? 'bg-rose-400'
                    : runtimeStatus?.phase === 'running_tool'
                      ? 'bg-amber-400'
                      : 'bg-cyan-400'
                }`}
                style={{ width: `${contextProgressPercent}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
