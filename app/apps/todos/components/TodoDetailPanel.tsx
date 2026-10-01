'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, ArrowUp, Bell, CalendarDays, CheckCircle2, ChevronDown, Circle, Clock3, Edit3, ExternalLink, FolderKanban, MailCheck, MailWarning, MessageSquare, RefreshCcw, Send } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { readWorkspaceFile } from '@/app/lib/files/client';
import { buildTodoFileNotebookHref, getTodoFileFallbackTitle, getTodoFileMetadataTitle } from '@/app/lib/todos/file-link-display';
import type { TodoItem, TodoCategory, TodoFileLink, TodoUserSummary } from '@/app/lib/todos/client-types';
import { formatDate, formatDateTime, formatTodoUser, TodoIcon, resolvedTodoIconKey } from '@/app/lib/todos/client-presentation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/app/components/shared/MarkdownRenderer';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { UserAvatar } from '@/app/components/user-profile/UserAvatar';
import { getUserInitials } from '@/app/lib/user-profile/initials';
import { formatTodoRelativeTime, formatTodoDueDate, isTodoDueOverdue } from '@/app/lib/todos/relative-time';

const emptyTodoFileLinks: TodoFileLink[] = [];

function isMarkdownFile(path: string) {
  return /\.(?:md|mdx|markdown)$/i.test(path);
}

function useTodoFileTitles(todo: TodoItem | null, personalWorkspaceId: string | null) {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const links = todo?.fileLinks ?? emptyTodoFileLinks;
  const linkKey = links.map((link) => `${link.id}:${link.workspaceId ?? ''}:${link.workspacePath}`).join('|');

  useEffect(() => {
    let cancelled = false;
    const markdownLinks = links.filter((link) => isMarkdownFile(link.workspacePath));

    void Promise.all(markdownLinks.map(async (link) => {
      try {
        const workspaceId = link.workspaceId || (link.workspaceType === 'personal' ? personalWorkspaceId : null);
        if (!workspaceId) return null;
        const file = await readWorkspaceFile(link.workspacePath, { workspaceId });
        const title = getTodoFileMetadataTitle(file.content);
        return title ? [link.id, title] as const : null;
      } catch {
        return null;
      }
    })).then((resolvedTitles) => {
      if (cancelled) return;
      setTitles(Object.fromEntries(resolvedTitles.filter((entry): entry is readonly [string, string] => entry !== null)));
    });

    return () => {
      cancelled = true;
    };
  }, [linkKey, links, personalWorkspaceId]);

  return titles;
}

function TodoPerson({ user, locale, compact = false }: { user: TodoUserSummary; locale: string; compact?: boolean }) {
  const name = formatTodoUser(user, user.id);
  return <div data-testid={compact ? undefined : "todo-assignee-avatar"} className="flex min-w-0 items-center gap-2.5">
    <UserAvatar
      profile={{ name, avatarKind: user.image ? 'image' : 'initials', imageUrl: user.image || null,
        initials: getUserInitials({ name: user.name, email: user.email, locale }), iconId: null, revision: 0 }}
      className={cn('rounded-full border-border/60 bg-none bg-muted/60 shadow-none', compact ? 'size-6 text-2xl' : 'size-9 text-3xl')}
    />
    <span className="min-w-0 truncate font-medium">{name}</span>
  </div>;
}

export type TodoDetailPanelProps = {
  todo: TodoItem | null;
  locale: string;
  followUpComment: string;
  isMutating: boolean;
  isSendingFollowUp: boolean;
  showEmptyState?: boolean;
  hideTitle?: boolean;
  hideActions?: boolean;
  navigationDisabled?: boolean;
  onArchive?: (todo: TodoItem) => void | Promise<void>;
  formatCategoryName: (category: Pick<TodoCategory, 'name' | 'icon'> | null | undefined) => string;
  onEdit: (todo: TodoItem) => void;
  onRestore: (todo: TodoItem) => void | Promise<void>;
  onToggleDone: (todo: TodoItem) => void | Promise<void>;
  onOpenSession: (todo: Pick<TodoItem, 'id' | 'sourceSessionId' | 'workspaceId'>) => void;
  onUpdateFollowUpComment: (value: string) => void;
  onSendFollowUp: (todo: TodoItem) => void | Promise<void>;
};

export function TodoDetailPanel({
  todo,
  locale,
  followUpComment,
  isMutating,
  isSendingFollowUp,
  showEmptyState = true,
  hideTitle = false,
  hideActions = false,
  navigationDisabled = false,
  onArchive,
  formatCategoryName,
  onEdit,
  onRestore,
  onToggleDone,
  onOpenSession,
  onUpdateFollowUpComment,
  onSendFollowUp,
}: TodoDetailPanelProps) {
  const t = useTranslations('todos');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!todo?.dueAt && !todo?.remindAt) return;
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [todo?.dueAt, todo?.remindAt]);
  const personalWorkspaceId = useWorkspaceStore((state) => state.initialized
    ? state.workspaces.find((workspace) => workspace.type === 'personal')?.id ?? null
    : null);
  const fileTitles = useTodoFileTitles(todo, personalWorkspaceId);
  const scopeLabel = todo?.scopeKind === 'user'
    ? t('scope.user')
    : todo?.workspace?.name || (todo ? t(`workspaceType.${todo.workspaceType}`) : '');

  if (!todo) {
    if (!showEmptyState) return null;

    return (
      <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
        <Clock3 className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">{t('states.noSelectionTitle')}</p>
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">{t('states.noSelectionDescription')}</p>
      </div>
    );
  }

  const dueRelative = formatTodoRelativeTime(todo.dueAt, locale, { now });
  const reminderRelative = formatTodoRelativeTime(todo.remindAt, locale, { dateOnly: false, now });
  const overdue = todo.status === 'open' && isTodoDueOverdue(todo.dueAt, now);
  const StatusIcon = todo.status === 'done' ? CheckCircle2 : todo.status === 'archived' ? Archive : Circle;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn('gap-1.5 rounded-md px-2.5 py-1 font-medium', todo.status === 'done' && 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', todo.status === 'archived' && 'bg-muted text-muted-foreground')}>
              <StatusIcon className="size-3.5" />{t(`status.${todo.status}`)}
            </Badge>
            {todo.category && <Badge variant="outline" className="gap-1.5 rounded-md border-border/60 px-2.5 py-1 font-medium">
              <TodoIcon iconKey={resolvedTodoIconKey({ iconKey: null, category: todo.category })} className="size-3.5 text-muted-foreground" />
              {formatCategoryName(todo.category)}
            </Badge>}
            {todo.priority === 'high' && <Badge variant="outline" className="gap-1 rounded-md border-amber-500/25 bg-amber-500/10 px-2.5 py-1 font-medium text-amber-800 dark:text-amber-300">
              <ArrowUp className="size-3.5" />{t('priority.high')}
            </Badge>}
          </div>
          {!hideTitle && <h3 className="break-words text-xl font-semibold leading-snug tracking-tight">{todo.title}</h3>}
        </div>
        {todo.canWrite && !hideActions && <Button variant="ghost" size="icon-sm" aria-label={t('actions.edit')} onClick={() => onEdit(todo)} disabled={todo.status === 'archived' || isMutating}>
          <Edit3 className="h-4 w-4" />
        </Button>}
      </div>

      {todo.description?.trim() && <section data-testid="todo-detail-content" className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t('fields.description')}</h4>
        <MarkdownRenderer content={todo.description} variant="default"
          className="text-[15px] leading-7 text-foreground [&_img]:max-h-48 [&_img]:max-w-full [&_img]:object-contain [&_pre]:max-h-64 [&_table]:text-xs" />
      </section>}

      {(dueRelative || reminderRelative) && <div className={cn('grid min-w-0 gap-2.5', dueRelative && reminderRelative && hideTitle && 'sm:grid-cols-2')}>
        {dueRelative && <section data-testid="todo-detail-due" aria-label={t('fields.dueAt')}
          className={cn('flex min-w-0 items-start gap-3 rounded-lg border p-3.5', overdue ? 'border-destructive/25 bg-destructive/5' : 'border-primary/15 bg-primary/[0.035]')}>
          <CalendarDays className={cn('mt-0.5 size-5 shrink-0', overdue ? 'text-destructive' : 'text-primary')} />
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('fields.dueAt')}{overdue ? ` · ${t('labels.overdue')}` : ''}</p>
            <p className={cn('break-words text-lg font-semibold leading-snug first-letter:uppercase', overdue && 'text-destructive')}>{dueRelative}</p>
            <time dateTime={todo.dueAt!} className="block text-xs tabular-nums text-muted-foreground">{formatTodoDueDate(todo.dueAt, locale)}</time>
          </div>
        </section>}
        {reminderRelative && <section data-testid="todo-detail-reminder" aria-label={t('fields.remindAt')} className="flex min-w-0 items-start gap-3 rounded-lg border border-border/70 bg-muted/20 p-3.5">
          <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('fields.remindAt')}</p>
            <p className="break-words text-base font-medium leading-snug first-letter:uppercase">{reminderRelative}</p>
            <time dateTime={todo.remindAt!} className="block text-xs tabular-nums text-muted-foreground">{formatDateTime(todo.remindAt, locale)}</time>
          </div>
        </section>}
      </div>}

      {(todo.assignee || todo.scopeKind === 'workspace') && <div className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-3">
        {todo.assignee && <div data-testid="todo-detail-assignee" className="min-w-0 space-y-1.5 text-sm">
          <p className="text-xs font-medium text-muted-foreground">{t('fields.assignee')}</p>
          <TodoPerson user={todo.assignee} locale={locale} />
        </div>}
        {todo.scopeKind === 'workspace' && <div className="min-w-0 space-y-1.5 text-sm">
          <p className="text-xs font-medium text-muted-foreground">{t('fields.workspace')}</p>
          <p className="flex min-w-0 items-center gap-2 py-2 font-medium"><FolderKanban className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{scopeLabel}</span></p>
        </div>}
      </div>}

      {todo.completionComment?.trim() && <section className="space-y-2 border-l-2 border-primary/20 pl-3.5">
        <h4 className="text-xs font-medium text-muted-foreground">{t('fields.completionComment')}</h4>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{todo.completionComment}</p>
      </section>}

      {todo.sourceType === 'agent' && todo.emailNotificationError ? (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t('sections.emailNotification')}
          </h4>
          <div
            className={cn(
              'space-y-3 rounded-lg border px-3.5 py-3 text-sm',
              todo.emailNotificationError
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : 'border-border bg-muted/40 text-muted-foreground',
            )}
          >
            <div className="flex items-start gap-2">
              {todo.emailNotificationError ? (
                <MailWarning className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="min-w-0 space-y-1">
                <p className="font-medium">
                  {todo.emailNotificationError
                    ? t('labels.emailNotificationBlocked')
                    : t('labels.emailNotificationSentAt', {
                        date: todo.emailNotificationSentAt
                          ? formatDate(todo.emailNotificationSentAt, locale) ?? todo.emailNotificationSentAt
                          : '',
                      })}
                </p>
                {todo.emailNotificationError ? (
                  <p className="break-words text-xs leading-relaxed">{todo.emailNotificationError}</p>
                ) : null}
              </div>
            </div>
            {todo.emailNotificationError ? (
              <Button asChild={!navigationDisabled} disabled={navigationDisabled} size="sm" variant="outline" className="h-8 border-destructive/30 bg-background text-destructive hover:bg-destructive/10 hover:text-destructive">
                {navigationDisabled ? <>
                  <ExternalLink className="h-4 w-4" />
                  {t('actions.openIntegrationsSettings')}
                </> : <Link href="/settings?tab=integrations">
                  <ExternalLink className="h-4 w-4" />
                  {t('actions.openIntegrationsSettings')}
                </Link>}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {todo.fileLinks.length > 0 && <section data-testid="todo-detail-files" className="space-y-3">
        <h4 className="text-xs font-medium text-muted-foreground">{t('sections.files')}</h4>
          <div className="space-y-2">
            {todo.fileLinks.map((link) => {
              const workspaceId = link.workspaceId || (link.workspaceType === 'personal' ? personalWorkspaceId : null);
              const content = <>
                {getFileIconComponent({
                  name: link.workspacePath.split('/').filter(Boolean).at(-1) || link.workspacePath,
                  path: link.workspacePath,
                  type: 'file',
                  className: 'h-4 w-4',
                })}
                <span className="min-w-0 flex-1 truncate">
                  {fileTitles[link.id] || getTodoFileFallbackTitle(link.workspacePath)}
                </span>
              </>;
              return (
                <Button
                  key={link.id}
                  asChild={Boolean(workspaceId) && !navigationDisabled}
                  disabled={!workspaceId || navigationDisabled}
                  variant="outline"
                  className="h-auto w-full min-w-0 justify-start overflow-hidden whitespace-normal py-2 text-left hover:bg-muted/70"
                >
                  {workspaceId && !navigationDisabled ? <Link
                    href={buildTodoFileNotebookHref({ path: link.workspacePath, workspaceId })}
                    title={link.workspacePath}
                  >{content}</Link> : content}
                </Button>
              );
            })}
          </div>
      </section>}

      {todo.sourceSessionId ? (
        <div className="space-y-3 rounded-lg border border-border/70 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              {t('sections.session')}
            </h4>
            <Button
              size="sm"
              variant="outline"
              disabled={isMutating || isSendingFollowUp || navigationDisabled}
              onClick={() => onOpenSession(todo)}
            >
              <ExternalLink className="h-4 w-4" />
              {t('actions.openSession')}
            </Button>
          </div>

          {todo.status === 'done' && todo.canWrite ? (
            <div className="space-y-2">
              <Label htmlFor="todo-follow-up-comment">{t('fields.followUpComment')}</Label>
              <Textarea
                id="todo-follow-up-comment"
                disabled={isMutating || isSendingFollowUp}
                value={followUpComment}
                onChange={(event) => onUpdateFollowUpComment(event.target.value)}
                className="min-h-24"
                maxLength={5000}
                placeholder={t('fields.followUpCommentPlaceholder')}
              />
              {todo.followUpSentAt ? (
                <p className="text-xs text-muted-foreground">
                  {t('labels.followUpSentAt', { date: formatDate(todo.followUpSentAt, locale) ?? todo.followUpSentAt })}
                </p>
              ) : null}
              {todo.followUpError ? (
                <p className="break-words text-xs text-destructive">{todo.followUpError}</p>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onSendFollowUp(todo)}
                disabled={isSendingFollowUp || isMutating}
              >
                <Send className="h-4 w-4" />
                {todo.followUpSentAt ? t('actions.sendFollowUpAgain') : t('actions.sendFollowUp')}
              </Button>
            </div>
          ) : todo.status !== 'done' ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" />
              {t('states.completeBeforeFollowUp')}
            </p>
          ) : null}
        </div>
      ) : null}


      {(todo.createdBy || todo.createdAt || todo.updatedAt || todo.completedAt || todo.emailNotificationSentAt) && <details data-testid="todo-detail-metadata" className="group border-t border-border/60 pt-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          {t('sections.details')}
        </summary>
        <div className="space-y-3 pt-3 text-xs">
          {todo.createdBy && <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground">{t('fields.createdBy')}</span>
            <TodoPerson user={todo.createdBy} locale={locale} compact />
          </div>}
          {(['createdAt', 'updatedAt', 'completedAt'] as const).map((field) => formatDateTime(todo[field], locale) ? (
            <div key={field} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-muted-foreground">{t(`fields.${field}`)}</span>
              <time dateTime={todo[field]!} className="tabular-nums">{formatDateTime(todo[field], locale)}</time>
            </div>
          ) : null)}
          {todo.emailNotificationSentAt && !todo.emailNotificationError && <p className="flex items-center gap-2 text-muted-foreground">
            <MailCheck className="size-3.5 shrink-0" />
            {t('labels.emailNotificationSentAt', { date: formatDateTime(todo.emailNotificationSentAt, locale) || todo.emailNotificationSentAt })}
          </p>}
        </div>
      </details>}

      {!hideActions && <div className="flex flex-wrap gap-2">
        {todo.canWrite && todo.status === 'archived' ? (
          <Button size="sm" onClick={() => void onRestore(todo)} disabled={isMutating}>
            <RefreshCcw className="h-4 w-4" />
            {t('actions.restore')}
          </Button>
        ) : (
          <>
            {todo.canWrite && <Button size="sm" onClick={() => void onToggleDone(todo)} disabled={isMutating}>
              <CheckCircle2 className="h-4 w-4" />
              {todo.status === 'done' ? t('actions.reopen') : t('actions.complete')}
            </Button>}
          </>
        )}
        {todo.canWrite && todo.status !== 'archived' && onArchive && <Button size="sm" variant="outline" onClick={() => void onArchive(todo)} disabled={isMutating}><Archive className="h-4 w-4" />{t('actions.archiveTodo')}</Button>}
      </div>}
    </div>
  );
}
