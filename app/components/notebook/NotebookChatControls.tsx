'use client';

import { MessageSquare, PanelRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { notebookPanelToggleClassName } from './toolbar-styles';

export function NotebookChatControls({ full, docked, canDock, mobile, controlsId, onShow, onToggleDock }: {
  full: boolean;
  docked: boolean;
  canDock: boolean;
  mobile: boolean;
  controlsId: string;
  onShow: () => void;
  onToggleDock: () => void;
}) {
  const t = useTranslations('notebook');
  const modifier = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl';
  return (
    <TooltipProvider delayDuration={250}>
      <div role="group" aria-label={t('chatViewControls')} data-testid="notebook-chat-controls"
        className="flex shrink-0 items-center rounded-md border border-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button id="notebook-chat-button" type="button" variant="ghost" size="sm"
              className={cn(notebookPanelToggleClassName, 'gap-1.5 px-2', !mobile && 'rounded-r-none', 'pointer-coarse:min-h-11')}
              aria-label={t('openFullChat')} aria-controls={controlsId} aria-pressed={full}
              data-testid="notebook-surface-chat" onClick={onShow}>
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              {t('chatButton')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('openFullChat')}{!mobile && ` (${modifier}K)`}</TooltipContent>
        </Tooltip>
        {!mobile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex border-l border-border">
                <Button type="button" variant="ghost" size="icon-sm"
                  className={cn(notebookPanelToggleClassName, 'rounded-l-none pointer-coarse:min-h-11 pointer-coarse:min-w-11')}
                  disabled={!canDock} aria-controls={controlsId} aria-pressed={docked}
                  aria-label={docked ? t('hideSideChat') : t('showSideChat')}
                  data-testid="notebook-chat-dock" onClick={onToggleDock}>
                  <PanelRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{!canDock ? t('sideChatNeedsSpace') : `${docked ? t('hideSideChat') : t('showSideChat')} (${modifier}⇧K)`}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
