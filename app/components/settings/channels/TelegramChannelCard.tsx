'use client';

import { Check, Copy, ExternalLink, Eye, EyeOff, Link2, Loader2, RefreshCw, Terminal, Trash2, Unlink, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export type TelegramStatus = {
  configured: boolean;
  enabled: boolean;
  linked: boolean;
  linkedUserName: string | null;
};

export type TelegramBindingUser = {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
};

export type TelegramBinding = {
  id: number;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  telegramUserId: string;
  telegramUserName: string | null;
  metadata: {
    chatId?: string;
    linkedVia?: string;
    linkedAt?: string;
  } | null;
  enabled: boolean;
  createdAt: string | Date;
};

export type TelegramBindingDraft = {
  telegramUserId: string;
  telegramUserName: string;
  userId: string;
};

type TelegramChannelCardProps = {
  isAdmin: boolean;
  status: TelegramStatus | null;
  isLoading: boolean;
  error: string | null;
  success: string | null;
  channelEnabled: boolean;
  botToken: string;
  showToken: boolean;
  linkToken: string | null;
  copied: boolean;
  isSaving: boolean;
  isRestarting: boolean;
  isGeneratingToken: boolean;
  isUnlinking: boolean;
  isRegistering: boolean;
  telegramBindings: TelegramBinding[];
  telegramBindingUsers: TelegramBindingUser[];
  telegramBindingDraft: TelegramBindingDraft;
  isLoadingTelegramBindings: boolean;
  isSavingTelegramBinding: boolean;
  deletingTelegramBindingId: number | null;
  onTelegramBindingDraftChange: (patch: Partial<TelegramBindingDraft>) => void;
  onSaveTelegramBinding: () => void;
  onDeleteTelegramBinding: (id: number) => void;
  onRefreshTelegramBindings: () => void;
  onToggleEnabled: () => void;
  onBotTokenChange: (value: string) => void;
  onShowTokenChange: (value: boolean) => void;
  onSaveBotToken: () => void;
  onGenerateLinkToken: () => void;
  onCopyLinkCommand: () => void;
  onUnlink: () => void;
  onRegisterCommands: () => void;
  onRefresh: () => void;
  onRestart: () => void;
};

function formatUserLabel(user: TelegramBindingUser | TelegramBinding): string {
  if ('userId' in user) {
    return [user.userName, user.userEmail].filter(Boolean).join(' · ') || user.userId;
  }
  return [user.name, user.email].filter(Boolean).join(' · ') || user.id;
}

function formatTelegramLabel(binding: TelegramBinding): string {
  return binding.telegramUserName
    ? `@${binding.telegramUserName} · ${binding.telegramUserId}`
    : binding.telegramUserId;
}

function formatBindingDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function TelegramChannelCard({
  isAdmin,
  status,
  isLoading,
  error,
  success,
  channelEnabled,
  botToken,
  showToken,
  linkToken,
  copied,
  isSaving,
  isRestarting,
  isGeneratingToken,
  isUnlinking,
  isRegistering,
  telegramBindings,
  telegramBindingUsers,
  telegramBindingDraft,
  isLoadingTelegramBindings,
  isSavingTelegramBinding,
  deletingTelegramBindingId,
  onTelegramBindingDraftChange,
  onSaveTelegramBinding,
  onDeleteTelegramBinding,
  onRefreshTelegramBindings,
  onToggleEnabled,
  onBotTokenChange,
  onShowTokenChange,
  onSaveBotToken,
  onGenerateLinkToken,
  onCopyLinkCommand,
  onUnlink,
  onRegisterCommands,
  onRefresh,
  onRestart,
}: TelegramChannelCardProps) {
  const t = useTranslations('settings');
  const statusEmoji = status?.configured
    ? status?.enabled
      ? status?.linked
        ? '✅'
        : '🟡'
      : '⚪'
    : '🔴';

  const statusText = !status?.configured
    ? t('channels.telegram.statusNotConfigured')
    : !status?.enabled
      ? t('channels.telegram.statusDisabled')
      : status?.linked
        ? status.linkedUserName
          ? t('channels.telegram.statusLinked', {
              username: status.linkedUserName,
            })
          : t('channels.telegram.linkedGeneric')
        : t('channels.telegram.statusNotLinked');

  return (
    <Card>
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>{t('channels.telegram.title')}</CardTitle>
        <CardDescription>{t('channels.telegram.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('channels.telegram.loading')}
          </div>
        ) : (
          <>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-primary">{success}</p>}

            <div className="text-sm">
              <span className="font-medium">{t('channels.telegram.statusLabel')}</span>{' '}
              <span>{statusEmoji} {statusText}</span>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">
                  {t('channels.telegram.enableLabel')}
                </label>
                <p className="text-xs text-muted-foreground">
                  {t('channels.telegram.enableDescription')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={channelEnabled}
                onClick={onToggleEnabled}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${channelEnabled ? 'bg-primary' : 'bg-muted'}`}
                disabled={isSaving || isRestarting}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${channelEnabled ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
            </div>

            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-4 text-sm">
              <p className="font-medium">{t('channels.telegram.setupGuideTitle')}</p>
              <ol className="list-inside list-decimal space-y-1 text-muted-foreground">
                <li>
                  {t('channels.telegram.step1')}{' '}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary underline"
                  >
                    @BotFather <ExternalLink className="h-3 w-3" />
                  </a>{' '}
                  {t('channels.telegram.step1b')}
                </li>
                <li>{t('channels.telegram.step2')}</li>
                <li>{t('channels.telegram.step3')}</li>
                <li>{t('channels.telegram.step4')}</li>
              </ol>
            </div>

            {channelEnabled && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    {t('channels.telegram.botTokenLabel')}
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        type={showToken ? 'text' : 'password'}
                        value={botToken}
                        onChange={(e) => onBotTokenChange(e.target.value)}
                        placeholder="123456:ABC-DEF..."
                        disabled={isSaving}
                        className={showToken ? undefined : 'pr-11'}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2"
                        onClick={() => onShowTokenChange(!showToken)}
                        disabled={isSaving}
                      >
                        {showToken ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <Button type="button" disabled={isSaving || isRestarting} onClick={onSaveBotToken}>
                      {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t('channels.telegram.save')}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    {t('channels.telegram.linkLabel')}
                  </label>
                  {status?.linked ? (
                    <div className="flex items-center gap-2 rounded-md border p-3">
                      <Link2 className="h-4 w-4 text-primary" />
                      <span className="text-sm">
                        {status.linkedUserName
                          ? t('channels.telegram.linkedAs', {
                              username: status.linkedUserName,
                            })
                          : t('channels.telegram.linkedGeneric')}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onUnlink}
                        disabled={isUnlinking}
                        className="ml-auto"
                      >
                        {isUnlinking && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                        <Unlink className="mr-1 h-3 w-3" />
                        {t('channels.telegram.unlink')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        variant="default"
                        onClick={onGenerateLinkToken}
                        disabled={isGeneratingToken || !status?.configured}
                      >
                        {isGeneratingToken && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        <Link2 className="mr-2 h-4 w-4" />
                        {t('channels.telegram.linkButton')}
                      </Button>

                      {linkToken && (
                        <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-4 text-sm">
                          <p className="font-medium text-primary">
                            {copied
                              ? t('channels.telegram.copiedToClipboard')
                              : t('channels.telegram.tokenGenerated')}
                          </p>

                          <div
                            role="button"
                            tabIndex={0}
                            onClick={onCopyLinkCommand}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                onCopyLinkCommand();
                              }
                            }}
                            className="group cursor-pointer"
                          >
                            <div className="flex items-center gap-3 rounded-md border bg-background p-3 transition-colors hover:border-primary/50 hover:bg-accent">
                              <code className="flex-1 select-all break-all font-mono text-sm">
                                /start {linkToken}
                              </code>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onCopyLinkCommand();
                                }}
                                className="shrink-0"
                              >
                                {copied ? (
                                  <Check className="h-4 w-4 text-green-500" />
                                ) : (
                                  <Copy className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
                                )}
                              </Button>
                            </div>
                          </div>

                          {!copied && (
                            <p className="text-xs text-muted-foreground">
                              {t('channels.telegram.clickToCopy')}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {isAdmin && (
                  <div className="flex flex-col gap-4 rounded-md border p-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <p className="font-medium">{t('channels.telegram.bindingsTitle')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('channels.telegram.bindingsDescription')}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onRefreshTelegramBindings}
                        disabled={isLoadingTelegramBindings}
                      >
                        {isLoadingTelegramBindings ? (
                          <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                          <RefreshCw data-icon="inline-start" />
                        )}
                        {t('channels.telegram.refreshBindings')}
                      </Button>
                    </div>

                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto]">
                      <div className="flex min-w-0 flex-col gap-2">
                        <label className="text-sm font-medium" htmlFor="telegram-user-id">
                          {t('channels.telegram.telegramUserIdLabel')}
                        </label>
                        <Input
                          id="telegram-user-id"
                          inputMode="numeric"
                          value={telegramBindingDraft.telegramUserId}
                          onChange={(event) => onTelegramBindingDraftChange({ telegramUserId: event.target.value })}
                          placeholder={t('channels.telegram.telegramUserIdPlaceholder')}
                          disabled={isSavingTelegramBinding}
                        />
                      </div>
                      <div className="flex min-w-0 flex-col gap-2">
                        <label className="text-sm font-medium" htmlFor="telegram-user-name">
                          {t('channels.telegram.telegramUserNameLabel')}
                        </label>
                        <Input
                          id="telegram-user-name"
                          value={telegramBindingDraft.telegramUserName}
                          onChange={(event) => onTelegramBindingDraftChange({ telegramUserName: event.target.value })}
                          placeholder={t('channels.telegram.telegramUserNamePlaceholder')}
                          disabled={isSavingTelegramBinding}
                        />
                      </div>
                      <div className="flex min-w-0 flex-col gap-2">
                        <label className="text-sm font-medium" htmlFor="telegram-app-user">
                          {t('channels.telegram.appUserLabel')}
                        </label>
                        <select
                          id="telegram-app-user"
                          value={telegramBindingDraft.userId}
                          onChange={(event) => onTelegramBindingDraftChange({ userId: event.target.value })}
                          disabled={isSavingTelegramBinding || telegramBindingUsers.length === 0}
                          className="h-10 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {telegramBindingUsers.length === 0 ? (
                            <option value="">{t('channels.telegram.noUsers')}</option>
                          ) : (
                            telegramBindingUsers.map((user) => (
                              <option key={user.id} value={user.id}>
                                {formatUserLabel(user)}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                      <div className="flex items-end">
                        <Button
                          type="button"
                          className="w-full lg:w-auto"
                          onClick={onSaveTelegramBinding}
                          disabled={isSavingTelegramBinding || telegramBindingUsers.length === 0}
                        >
                          {isSavingTelegramBinding ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                          ) : (
                            <UserPlus data-icon="inline-start" />
                          )}
                          {t('channels.telegram.addBinding')}
                        </Button>
                      </div>
                    </div>

                    {isLoadingTelegramBindings ? (
                      <div className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="animate-spin" />
                          {t('channels.telegram.bindingsLoading')}
                        </span>
                      </div>
                    ) : telegramBindings.length === 0 ? (
                      <div className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
                        {t('channels.telegram.bindingsEmpty')}
                      </div>
                    ) : (
                      <>
                        <div className="hidden rounded-md border md:block">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>{t('channels.telegram.telegramAccountColumn')}</TableHead>
                                <TableHead>{t('channels.telegram.appUserColumn')}</TableHead>
                                <TableHead>{t('channels.telegram.createdColumn')}</TableHead>
                                <TableHead className="text-right">{t('channels.telegram.actionsColumn')}</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {telegramBindings.map((binding) => (
                                <TableRow key={binding.id}>
                                  <TableCell className="whitespace-normal">
                                    <div className="flex min-w-0 flex-col gap-1">
                                      <span className="break-all font-medium">{formatTelegramLabel(binding)}</span>
                                      {binding.metadata?.chatId && binding.metadata.chatId !== binding.telegramUserId && (
                                        <span className="break-all text-xs text-muted-foreground">
                                          {t('channels.telegram.chatIdLabel', { chatId: binding.metadata.chatId })}
                                        </span>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell className="whitespace-normal">
                                    <div className="flex min-w-0 flex-col gap-1">
                                      <span className="break-words">{formatUserLabel(binding)}</span>
                                      <Badge variant={binding.enabled ? 'secondary' : 'outline'} className="w-fit">
                                        {binding.enabled ? t('channels.telegram.bindingActive') : t('channels.telegram.bindingDisabled')}
                                      </Badge>
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-muted-foreground">
                                    {formatBindingDate(binding.createdAt)}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <Button
                                      type="button"
                                      variant="destructive"
                                      size="sm"
                                      onClick={() => onDeleteTelegramBinding(binding.id)}
                                      disabled={deletingTelegramBindingId !== null}
                                    >
                                      {deletingTelegramBindingId === binding.id ? (
                                        <Loader2 data-icon="inline-start" className="animate-spin" />
                                      ) : (
                                        <Trash2 data-icon="inline-start" />
                                      )}
                                      {t('channels.telegram.deleteBinding')}
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                        <div className="flex flex-col gap-3 md:hidden">
                          {telegramBindings.map((binding) => (
                            <div key={binding.id} className="rounded-md border bg-background p-3">
                              <div className="flex min-w-0 flex-col gap-1">
                                <span className="break-all font-medium">{formatTelegramLabel(binding)}</span>
                                <span className="break-words text-sm text-muted-foreground">{formatUserLabel(binding)}</span>
                              </div>
                              <div className="mt-3 flex items-center justify-between gap-3">
                                <span className="text-xs text-muted-foreground">{formatBindingDate(binding.createdAt)}</span>
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => onDeleteTelegramBinding(binding.id)}
                                  disabled={deletingTelegramBindingId !== null}
                                >
                                  {deletingTelegramBindingId === binding.id ? (
                                    <Loader2 data-icon="inline-start" className="animate-spin" />
                                  ) : (
                                    <Trash2 data-icon="inline-start" />
                                  )}
                                  {t('channels.telegram.deleteBinding')}
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">
                    {t('channels.telegram.registerCommandsLabel')}
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onRegisterCommands}
                    disabled={isRegistering || !status?.configured}
                  >
                    {isRegistering && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                    <Terminal className="mr-1 h-3 w-3" />
                    {t('channels.telegram.registerCommandsButton')}
                  </Button>
                </div>
              </>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={onRefresh} disabled={isLoading}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('channels.telegram.refresh')}
              </Button>
              {channelEnabled && (
                <Button type="button" variant="secondary" onClick={onRestart} disabled={isRestarting}>
                  {isRestarting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('channels.telegram.restart')}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
