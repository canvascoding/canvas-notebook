'use client';

import { Clock, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export type AgentSessionItem = {
  id: number;
  sessionId: string;
  agentId?: string;
  title: string;
  model: string;
  createdAt: string;
  creator?: {
    name?: string | null;
    email?: string | null;
  };
};

type AgentSessionsCardProps = {
  sessions: AgentSessionItem[];
  sessionsLoading: boolean;
  sessionError: string | null;
  createTitle: string;
  sessionPendingId: string | null;
  renameDrafts: Record<string, string>;
  onCreateTitleChange: (value: string) => void;
  onRenameDraftChange: (sessionId: string, value: string) => void;
  onCreateSession: () => void;
  onRenameSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onDeleteAllSessions: () => void;
  onDeleteOlderSessions: () => void;
};

export function AgentSessionsCard({
  sessions,
  sessionsLoading,
  sessionError,
  createTitle,
  sessionPendingId,
  renameDrafts,
  onCreateTitleChange,
  onRenameDraftChange,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onDeleteAllSessions,
  onDeleteOlderSessions,
}: AgentSessionsCardProps) {
  const locale = useLocale();
  const t = useTranslations('settings');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('agentPanel.sessions.title')}</CardTitle>
        <CardDescription>{t('agentPanel.sessions.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-[200px] flex-1"
            placeholder={t('agentPanel.sessions.newSessionPlaceholder')}
            value={createTitle}
            onChange={(event) => onCreateTitleChange(event.target.value)}
            disabled={sessionPendingId !== null}
          />
          <Button onClick={onCreateSession} disabled={sessionPendingId !== null}>
            {sessionPendingId === 'create' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            {t('agentPanel.sessions.new')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onDeleteAllSessions}
            disabled={sessionPendingId !== null || sessionsLoading || sessions.length === 0}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('agentPanel.sessions.deleteAll')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDeleteOlderSessions}
            disabled={sessionPendingId !== null || sessionsLoading}
          >
            {sessionPendingId === 'delete-older' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock className="mr-2 h-4 w-4" />}
            {t('agentPanel.sessions.deleteOlder')}
          </Button>
        </div>

        {sessionError && <p className="text-sm text-destructive">{sessionError}</p>}

        {sessionsLoading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('agentPanel.sessions.loading')}
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('agentPanel.sessions.empty')}</p>
        ) : (
          <div className="max-h-[400px] space-y-2 overflow-y-auto pr-1">
            {sessions.map((sessionItem) => {
              const isPending = sessionPendingId === sessionItem.sessionId;
              const creatorLabel =
                sessionItem.creator?.name || sessionItem.creator?.email || t('agentPanel.sessions.unknownUser');

              return (
                <div key={sessionItem.sessionId} className="rounded border border-border p-3 transition-colors hover:bg-muted/10">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    <span>{sessionItem.sessionId}</span>
                    <span>{new Date(sessionItem.createdAt).toLocaleString(locale)}</span>
                  </div>

                  <div className="mb-2 grid gap-2 md:grid-cols-[1fr_auto_auto] md:items-center">
                    <Input
                      value={renameDrafts[sessionItem.sessionId] ?? ''}
                      onChange={(event) => onRenameDraftChange(sessionItem.sessionId, event.target.value)}
                      disabled={sessionPendingId !== null}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRenameSession(sessionItem.sessionId)}
                      disabled={sessionPendingId !== null}
                    >
                      {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => onDeleteSession(sessionItem.sessionId)}
                      disabled={sessionPendingId !== null}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>{t('agentPanel.sessions.modelLabel')} {sessionItem.model}</span>
                    <span>{t('agentPanel.sessions.userLabel')} {creatorLabel}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
