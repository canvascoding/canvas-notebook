'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  ChevronLeft,
  Gauge,
  History,
  Lightbulb,
  MoreHorizontal,
  PanelsTopLeft,
  Plus,
  Settings,
  Sparkles,
  Target,
  WandSparkles,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { ChatAgentSelector } from '@/app/components/canvas-agent-chat/ChatAgentSelector';
import { ChatLiveBrowserLink } from '@/app/components/canvas-agent-chat/ChatLiveBrowserLink';
import { formatContextTokens } from '@/app/components/canvas-agent-chat/contextStatusDisplay';
import { WorkspaceSwitcher, useShouldShowWorkspaceSwitcher } from '@/app/components/workspaces/WorkspaceSwitcher';
import {
  getRuntimeCompactionCauseTranslationKey,
  getRuntimeCompactionStatusTranslationKey,
  type RuntimeStatus,
} from '@/app/lib/chat/runtime-status';
import type { AgentProfile } from '@/app/lib/chat/types';
import { cn } from '@/lib/utils';

type ChatHeaderProps = {
  activeAgentDisplayName: string;
  activeAgentIconId?: string | null;
  activeSessionAgentId: string;
  chatAgentOptions: AgentProfile[];
  contextDetailedLabel: string;
  contextProgressPercent: number;
  contextTargetPercent: number | null;
  contextTooltip: string;
  hideNavHeader: boolean;
  isHistoryOverlayOpen: boolean;
  isMobile: boolean;
  isSessionTitleGenerating: boolean;
  onCompact: (focusTopic?: string) => void;
  onSelectAgent: (agentId: string) => void;
  onReloadAgents: () => Promise<void>;
  onOpenLiveBrowser?: () => void;
  onSetShowHistory: (value: boolean) => void;
  onStartNewChat: () => void;
  runtimeStatus: RuntimeStatus | null;
  sessionDisplayLabel: string;
  sessionId: string | null;
  showHistory: boolean;
  showSkillsLink: boolean;
  showWorkspaceSwitcher: boolean;
  totalUnreadCount: number;
};

export function ChatHeader({
  activeAgentDisplayName,
  activeAgentIconId,
  activeSessionAgentId,
  chatAgentOptions,
  contextDetailedLabel,
  contextProgressPercent,
  contextTargetPercent,
  contextTooltip,
  hideNavHeader,
  isHistoryOverlayOpen,
  isMobile,
  isSessionTitleGenerating,
  onCompact,
  onSelectAgent,
  onReloadAgents,
  onOpenLiveBrowser,
  onSetShowHistory,
  onStartNewChat,
  runtimeStatus,
  sessionDisplayLabel,
  sessionId,
  showHistory,
  showSkillsLink,
  showWorkspaceSwitcher: showWorkspaceSwitcherEnabled,
  totalUnreadCount,
}: ChatHeaderProps) {
  const t = useTranslations('chat');
  const tCommon = useTranslations('common');
  const tWorkspaces = useTranslations('workspaces');
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [focusDialogOpen, setFocusDialogOpen] = useState(false);
  const [compactionFocus, setCompactionFocus] = useState('');
  const canShowWorkspaceSwitcher = useShouldShowWorkspaceSwitcher();
  const showWorkspaceSwitcher = showWorkspaceSwitcherEnabled && canShowWorkspaceSwitcher;
  const compactionStatus = runtimeStatus?.compactionStatus;
  const compactionTranslationKey = getRuntimeCompactionStatusTranslationKey(compactionStatus);
  const compactionLabel = compactionTranslationKey ? t(compactionTranslationKey) : null;
  const compactionCauseKey = getRuntimeCompactionCauseTranslationKey(compactionStatus?.cause);
  const compactionCauseLabel = compactionCauseKey ? t(compactionCauseKey) : null;
  const hasCompactionMetrics = compactionStatus?.beforeTokens !== null
    && compactionStatus?.beforeTokens !== undefined
    && compactionStatus?.afterTokens !== null
    && compactionStatus?.afterTokens !== undefined;
  const canCompact = Boolean(
    sessionId
    && runtimeStatus?.phase === 'idle'
    && compactionStatus?.state !== 'running',
  );
  const contextWarningLevel = contextProgressPercent >= 95
    ? 'critical'
    : contextProgressPercent >= 80
      ? 'warning'
      : null;
  const contextProgressClass = contextWarningLevel === 'critical'
    ? 'bg-rose-500'
    : contextWarningLevel === 'warning'
      ? 'bg-amber-500'
      : 'bg-cyan-500';

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

      <div className={cn(
        '@container relative z-10 flex h-12 shrink-0 items-center border-b border-border bg-background/95 px-2.5',
        isHistoryOverlayOpen ? 'hidden' : null,
      )}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {showHistory ? (
            <button
              type="button"
              aria-label={t('backToChat')}
              onClick={() => onSetShowHistory(false)}
              className="relative z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
              className="relative z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t('toggleSidebar')}
            >
              <History size={18} />
              {totalUnreadCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 z-20 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-bold text-white">
                  {totalUnreadCount > 9 ? '9+' : totalUnreadCount}
                </span>
              )}
            </button>
          )}

          <div data-testid="chat-session-title" className="flex min-w-0 flex-1 items-center gap-1.5 px-1">
            {isSessionTitleGenerating ? (
              <Sparkles
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 animate-pulse text-primary/75 motion-reduce:animate-none"
              />
            ) : null}
            {sessionId ? (
              <span
                key={sessionDisplayLabel}
                data-testid="chat-session-id"
                title={sessionId}
                aria-live="polite"
                className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none sm:text-[15px]"
              >
                {sessionDisplayLabel}
              </span>
            ) : (
              <span className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground sm:text-[15px]">
                {sessionDisplayLabel}
              </span>
            )}
            {isSessionTitleGenerating ? <span className="sr-only">{t('sessionTitleGenerating')}</span> : null}
          </div>

          <ChatAgentSelector
            variant={isMobile ? 'mobile' : 'compact'}
            activeAgentId={activeSessionAgentId}
            activeAgentName={activeAgentDisplayName}
            activeAgentIconId={activeAgentIconId}
            agents={chatAgentOptions}
            onSelectAgent={onSelectAgent}
            onReloadAgents={onReloadAgents}
            iconOnly={isMobile}
            className="border-transparent bg-transparent px-1.5 hover:border-border/60 hover:bg-accent"
          />
        </div>

        <div className="ml-1 flex shrink-0 items-center gap-0.5">
          <ChatLiveBrowserLink
            agentId={activeSessionAgentId}
            onOpen={onOpenLiveBrowser}
            runtimeStatus={runtimeStatus}
            sessionId={sessionId}
          />
          {showWorkspaceSwitcher ? (
            <WorkspaceSwitcher
              source="chat"
              variant="chat-compact"
              className="hidden @[44rem]:inline-flex"
            />
          ) : null}
          <button
            type="button"
            aria-label={t('newChatTitle')}
            onClick={onStartNewChat}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10"
            title={t('newChatTitle')}
          >
            <Plus size={18} />
            <span className="sr-only">{t('newChatShort')}</span>
          </button>

          <DropdownMenu open={actionsMenuOpen} onOpenChange={setActionsMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="chat-header-menu-trigger"
                aria-label={t('moreChatActions')}
                className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t('moreChatActions')}
              >
                <MoreHorizontal size={18} />
                {contextWarningLevel ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-2 ring-background',
                      contextWarningLevel === 'critical' ? 'bg-rose-500' : 'bg-amber-500',
                    )}
                  />
                ) : null}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent data-testid="chat-header-menu" align="end" className="w-72">
              {showWorkspaceSwitcher ? (
                <>
                  <DropdownMenuItem onSelect={() => setWorkspaceSheetOpen(true)}>
                    <PanelsTopLeft />
                    <span>{tWorkspaces('label')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuLabel
                data-testid="chat-context-details"
                className="space-y-2 px-2 py-2 font-normal"
                title={contextTooltip}
              >
                <div className="flex items-center gap-2">
                  <Gauge className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs font-semibold text-foreground">{t('contextDetails')}</span>
                  {runtimeStatus ? (
                    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                      {runtimeStatus.contextPressure
                        ? t('contextTriggerUsagePercent', { percent: contextProgressPercent })
                        : t('contextUsagePercent', { percent: contextProgressPercent })}
                    </span>
                  ) : null}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {contextDetailedLabel}
                </p>
                {runtimeStatus ? (
                  <div className="relative h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      data-testid="chat-context-progress"
                      className={cn('h-full rounded-full transition-all', contextProgressClass)}
                      style={{ width: `${contextProgressPercent}%` }}
                    />
                    {contextTargetPercent !== null ? (
                      <span
                        data-testid="chat-context-target"
                        className="absolute inset-y-0 w-px bg-foreground/70"
                        style={{ left: `${contextTargetPercent}%` }}
                        title={t('contextTargetMarker')}
                      />
                    ) : null}
                  </div>
                ) : null}
                {runtimeStatus?.includedSummary ? (
                  <p className="text-[10px] text-muted-foreground">{t('summaryIncluded')}</p>
                ) : null}
                {compactionLabel ? (
                  <p data-testid="chat-menu-compaction-status" className="text-[10px] text-muted-foreground">
                    {compactionLabel}
                  </p>
                ) : null}
                {hasCompactionMetrics ? (
                  <p data-testid="chat-menu-compaction-metrics" className="text-[10px] text-muted-foreground">
                    {t('compactionMetrics', {
                      before: formatContextTokens(compactionStatus.beforeTokens!),
                      after: formatContextTokens(compactionStatus.afterTokens!),
                      count: compactionStatus.omittedMessageCount,
                    })}
                  </p>
                ) : null}
                {compactionCauseLabel ? (
                  <p className="text-[10px] text-muted-foreground">
                    {t('compactionCauseLabel', { cause: compactionCauseLabel })}
                    {compactionStatus?.focusApplied ? ` · ${t('compactionFocusApplied')}` : ''}
                  </p>
                ) : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-testid="chat-compact" onSelect={() => onCompact()} disabled={!canCompact}>
                <WandSparkles />
                <span>{t('compact')}</span>
                {!canCompact ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {!sessionId ? t('noSessionYet') : compactionLabel || t('working')}
                  </span>
                ) : null}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="chat-compact-with-focus"
                onSelect={(event) => {
                  event.preventDefault();
                  setActionsMenuOpen(false);
                  window.setTimeout(() => setFocusDialogOpen(true), 0);
                }}
                disabled={!canCompact}
              >
                <Target />
                <span>{t('compactWithFocus')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings?tab=agent">
                  <Settings />
                  <span>{t('openAgentSettings')}</span>
                </Link>
              </DropdownMenuItem>
              {showSkillsLink ? (
                <DropdownMenuItem asChild>
                  <Link href="/settings?tab=plugins">
                    <Lightbulb />
                    <span>{t('viewSkills')}</span>
                  </Link>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {showWorkspaceSwitcher ? (
            <WorkspaceSwitcher
              source="chat"
              variant="mobile-sheet"
              mobileSheetOpen={workspaceSheetOpen}
              onMobileSheetOpenChange={setWorkspaceSheetOpen}
              hideMobileSheetTrigger
            />
          ) : null}
        </div>
      </div>
      <Dialog open={focusDialogOpen} onOpenChange={setFocusDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('compactWithFocus')}</DialogTitle>
            <DialogDescription>{t('compactFocusDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="chat-compaction-focus">{t('compactFocusLabel')}</Label>
            <Textarea
              id="chat-compaction-focus"
              data-testid="chat-compaction-focus"
              value={compactionFocus}
              maxLength={500}
              onChange={(event) => setCompactionFocus(event.target.value)}
              placeholder={t('compactFocusPlaceholder')}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFocusDialogOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button
              data-testid="chat-compaction-focus-submit"
              disabled={!canCompact || !compactionFocus.trim()}
              onClick={() => {
                onCompact(compactionFocus.trim());
                setCompactionFocus('');
                setFocusDialogOpen(false);
              }}
            >
              {t('compact')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
