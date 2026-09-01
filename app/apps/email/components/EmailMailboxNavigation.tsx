'use client';

import { Check, ChevronDown, ChevronLeft, ChevronRight, Folder, Loader2, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { EmailMessageRowActions } from '@/app/apps/email/components/EmailMessageReader';
import { EmailPaneResizeHandle, type EmailWorkspaceLayoutMode } from '@/app/apps/email/components/EmailWorkspaceLayout';
import { formatDate } from '@/app/apps/email/components/email-client-format';
import type {
  EmailFolder,
  EmailMessageContextMenuPosition,
  EmailMessageListActionName,
  EmailMessageListActionState,
  EmailMessageSummary,
  EmailMessageViewerLabels,
} from '@/app/apps/email/components/email-client-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export type EmailMailboxNavigationLabels = {
  folders: string;
  hideFolders: string;
  loadingFolders: string;
  loadingMessages: string;
  messages: string;
  nextPage: string;
  noFolders: string;
  noMessages: string;
  noSubject: string;
  previousPage: string;
  resizeMessageList: string;
  showFolders: string;
  unknownSender: string;
  unreadOnly: string;
};

export function EmailMailboxNavigation({
  activeFolder,
  activeFolderName,
  activeMessageListAction,
  folders,
  hasNextPage,
  hasPreviousPage,
  isFolderSidebarOpen,
  isLoadingFolders,
  isLoadingMessages,
  labels,
  layoutMode,
  listWidth,
  messageContextMenu,
  messageFilter,
  messageRangeLabel,
  messages,
  onCloseContextMenu,
  onContextMenu,
  onFolderSidebarOpenChange,
  onListWidthChange,
  onMessageAction,
  onOpenMessage,
  onPageChange,
  onSelectFolder,
  onToggleUnreadFilter,
  selectedMessageId,
  viewerLabels,
}: {
  activeFolder: string;
  activeFolderName: string;
  activeMessageListAction: EmailMessageListActionState;
  folders: EmailFolder[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  isFolderSidebarOpen: boolean;
  isLoadingFolders: boolean;
  isLoadingMessages: boolean;
  labels: EmailMailboxNavigationLabels;
  layoutMode: EmailWorkspaceLayoutMode;
  listWidth: number;
  messageContextMenu: (EmailMessageContextMenuPosition & { messageId: string }) | null;
  messageFilter: 'all' | 'unread';
  messageRangeLabel: string;
  messages: EmailMessageSummary[];
  onCloseContextMenu(): void;
  onContextMenu(message: EmailMessageSummary, position: EmailMessageContextMenuPosition): void;
  onFolderSidebarOpenChange(open: boolean): void;
  onListWidthChange(width: number): void;
  onMessageAction(message: EmailMessageSummary, action: EmailMessageListActionName, destination?: string): void;
  onOpenMessage(message: EmailMessageSummary, openInDialog: boolean): void;
  onPageChange(direction: 'next' | 'previous'): void;
  onSelectFolder(folderPath: string): void;
  onToggleUnreadFilter(): void;
  selectedMessageId: string | null;
  viewerLabels: EmailMessageViewerLabels;
}) {
  return (
    <>
      {layoutMode === 'wide' && isFolderSidebarOpen ? (
        <aside className="flex min-h-0 flex-col overflow-hidden border border-border bg-card">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="min-w-0 truncate text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{labels.folders}</div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={labels.hideFolders}
              aria-expanded={isFolderSidebarOpen}
              title={labels.hideFolders}
              onClick={() => onFolderSidebarOpenChange(false)}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {isLoadingFolders ? (
              <div className="flex items-center px-2 py-3 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{labels.loadingFolders}</div>
            ) : folders.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">{labels.noFolders}</div>
            ) : folders.map((folder) => (
              <button
                key={folder.path}
                type="button"
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-2 py-2 text-left text-sm transition-colors',
                  activeFolder === folder.path ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                )}
                onClick={() => onSelectFolder(folder.path)}
              >
                <span className="min-w-0 truncate">{folder.name}</span>
                {folder.unseenCount ? <span className="text-xs font-medium">{folder.unseenCount}</span> : null}
              </button>
            ))}
          </div>
        </aside>
      ) : null}

      <section className="flex min-h-0 flex-col overflow-hidden border border-border bg-card">
        <div className="flex flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            {layoutMode === 'wide' && !isFolderSidebarOpen ? (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={labels.showFolders}
                aria-expanded={isFolderSidebarOpen}
                title={labels.showFolders}
                onClick={() => onFolderSidebarOpenChange(true)}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            ) : null}
            {layoutMode !== 'wide' ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="h-8 min-w-0 max-w-full justify-between gap-2 px-2" aria-label={labels.folders} title={activeFolderName || labels.folders}>
                    {isLoadingFolders ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Folder className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0 truncate">{activeFolderName || labels.folders}</span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={8} className="max-h-[55dvh] w-[min(20rem,calc(100vw-2rem))]">
                  <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{labels.folders}</div>
                  {isLoadingFolders ? (
                    <div className="flex items-center px-2 py-3 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{labels.loadingFolders}</div>
                  ) : folders.length === 0 ? (
                    <div className="px-2 py-3 text-sm text-muted-foreground">{labels.noFolders}</div>
                  ) : folders.map((folder) => (
                    <DropdownMenuItem
                      key={folder.path}
                      className={cn('min-w-0 justify-between gap-2', activeFolder === folder.path && 'bg-primary/10 text-primary focus:bg-primary/10 focus:text-primary')}
                      onSelect={() => onSelectFolder(folder.path)}
                    >
                      <Check className={cn('h-4 w-4 shrink-0', activeFolder === folder.path ? 'opacity-100' : 'opacity-0')} />
                      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                      {folder.unseenCount ? <span className="shrink-0 text-xs font-medium">{folder.unseenCount}</span> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{labels.messages}</div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{messageRangeLabel}</span>
                {layoutMode === 'wide' && !isFolderSidebarOpen && activeFolderName ? (
                  <Badge variant="secondary" className="hidden max-w-full truncate sm:inline-flex" title={activeFolderName}>{activeFolderName}</Badge>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant={messageFilter === 'unread' ? 'default' : 'outline'}
              size="sm"
              className="h-8"
              onClick={onToggleUnreadFilter}
              disabled={isLoadingMessages}
              aria-pressed={messageFilter === 'unread'}
            >
              <span className={cn('mr-2 h-2 w-2 rounded-full', messageFilter === 'unread' ? 'bg-primary-foreground' : 'bg-primary')} />
              {labels.unreadOnly}
            </Button>
            <Button type="button" variant="outline" size="icon-sm" aria-label={labels.previousPage} onClick={() => onPageChange('previous')} disabled={!hasPreviousPage || isLoadingMessages}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" size="icon-sm" aria-label={labels.nextPage} onClick={() => onPageChange('next')} disabled={!hasNextPage || isLoadingMessages}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoadingMessages ? (
            <div className="flex items-center px-3 py-4 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{labels.loadingMessages}</div>
          ) : messages.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">{labels.noMessages}</div>
          ) : messages.map((message) => (
            <div
              key={`${message.folder || activeFolder}:${message.id}`}
              className={cn('group/message flex w-full items-stretch border-b border-border transition-colors hover:bg-muted/60', selectedMessageId === message.id && 'bg-primary/10')}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(message, { x: event.clientX, y: event.clientY });
              }}
            >
              <button type="button" className="grid min-w-0 flex-1 grid-cols-[0.75rem_minmax(0,1fr)] gap-2 px-3 py-3 text-left" onClick={() => onOpenMessage(message, false)} onDoubleClick={() => onOpenMessage(message, true)}>
                <span className={cn('mt-1.5 h-2 w-2 rounded-full', message.isRead === false ? 'bg-primary' : 'bg-transparent')} aria-hidden="true" />
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className={cn('min-w-0 truncate text-sm', message.isRead === false ? 'font-semibold text-foreground' : 'font-medium')}>{message.from || labels.unknownSender}</div>
                    <div className="shrink-0 text-[11px] text-muted-foreground">{formatDate(message.date)}</div>
                  </div>
                  <div className={cn('mt-1 truncate text-sm', message.isRead === false ? 'font-semibold text-foreground' : 'font-medium')}>{message.subject || labels.noSubject}</div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{message.snippet}</p>
                </div>
              </button>
              <div className="flex shrink-0 items-start px-2 py-2">
                <EmailMessageRowActions
                  activeAction={activeMessageListAction}
                  contextMenuPosition={messageContextMenu?.messageId === message.id ? messageContextMenu : null}
                  folders={folders}
                  labels={viewerLabels}
                  message={message}
                  onAction={onMessageAction}
                  onCloseContextMenu={onCloseContextMenu}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {layoutMode === 'wide' ? <EmailPaneResizeHandle label={labels.resizeMessageList} width={listWidth} onWidthChange={onListWidthChange} /> : null}
    </>
  );
}
