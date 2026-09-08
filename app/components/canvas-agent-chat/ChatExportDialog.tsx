'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Braces, Check, Copy, Download, FileText, Loader2, ShieldAlert, Text } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  buildChatExportDocument,
  formatChatExport,
  type ChatExportDocument,
  type ChatExportFormat,
  type ChatExportLabels,
} from '@/app/lib/chat/chat-export';
import { writeTextToClipboard } from '@/app/lib/chat/clipboard';
import { fetchCompleteChatSessionExport } from '@/app/lib/chat/session-api';
import type { ChatMessage } from '@/app/lib/chat/types';
import { cn } from '@/lib/utils';

type ChatExportDialogProps = {
  activeAgentId: string;
  activeAgentName: string;
  liveMessages: ChatMessage[];
  model: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  provider: string | null;
  runtimePhase: string | null;
  sessionId: string | null;
  sessionTitle: string;
  thinkingLevel: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
};

const FORMAT_OPTIONS: Array<{
  format: ChatExportFormat;
  icon: typeof FileText;
}> = [
  { format: 'markdown', icon: FileText },
  { format: 'text', icon: Text },
  { format: 'json', icon: Braces },
];

const FORMAT_TRANSLATIONS = {
  markdown: {
    label: 'copyChatFormatMarkdown',
    description: 'copyChatFormatMarkdownDescription',
  },
  text: {
    label: 'copyChatFormatText',
    description: 'copyChatFormatTextDescription',
  },
  json: {
    label: 'copyChatFormatJson',
    description: 'copyChatFormatJsonDescription',
  },
} as const;

function safeDownloadName(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'canvas-chat';
}

export function ChatExportDialog({
  activeAgentId,
  activeAgentName,
  liveMessages,
  model,
  onOpenChange,
  open,
  provider,
  runtimePhase,
  sessionId,
  sessionTitle,
  thinkingLevel,
  workspaceId,
  workspaceName,
}: ChatExportDialogProps) {
  const t = useTranslations('chat');
  const tCommon = useTranslations('common');
  const [format, setFormat] = useState<ChatExportFormat>('markdown');
  const [document, setDocument] = useState<ChatExportDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const liveMessagesRef = useRef(liveMessages);

  useEffect(() => {
    liveMessagesRef.current = liveMessages;
  }, [liveMessages]);

  const labels = useMemo<ChatExportLabels>(() => ({
    agent: t('copyChatExportAgent'),
    assistant: t('copyChatExportAssistant'),
    binaryOmitted: t('copyChatExportBinaryOmitted'),
    callId: t('copyChatExportCallId'),
    chat: t('copyChat'),
    compactBreak: t('copyChatExportCompactBreak'),
    details: t('details'),
    exportedAt: t('copyChatExportedAt'),
    input: t('copyChatExportInput'),
    liveSnapshot: t('copyChatExportLiveSnapshot'),
    model: t('modelLabel'),
    output: t('copyChatExportOutput'),
    provider: t('copyChatExportProvider'),
    runtimePhase: t('copyChatExportRuntimePhase'),
    sessionId: t('copyChatExportSessionId'),
    system: t('copyChatExportSystem'),
    tool: t('copyChatExportTool'),
    user: t('userLabel'),
    workspace: t('copyChatExportWorkspace'),
  }), [t]);

  useEffect(() => {
    if (!open || !sessionId) {
      return;
    }

    const abortController = new AbortController();
    queueMicrotask(() => {
      if (abortController.signal.aborted) return;
      setIsLoading(true);
      setError(null);
      setDocument(null);
      setCopied(false);

      void fetchCompleteChatSessionExport({
        agentId: activeAgentId,
        sessionId,
        workspaceId,
        signal: abortController.signal,
      }).then((persistedMessages) => {
        if (abortController.signal.aborted) return;
        setDocument(buildChatExportDocument({
          persistedMessages,
          liveMessages: liveMessagesRef.current,
          runtimePhase,
          session: {
            sessionId,
            title: sessionTitle,
            agentId: activeAgentId,
            agentName: activeAgentName,
            model,
            provider,
            thinkingLevel,
            workspaceId,
            workspaceName,
          },
        }));
      }).catch((loadError) => {
        if (abortController.signal.aborted) return;
        console.error('[ChatExportDialog] Failed to prepare chat export', loadError);
        setError(t('copyChatLoadFailed'));
      }).finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      });
    });

    return () => abortController.abort();
  }, [activeAgentId, activeAgentName, loadRevision, model, open, provider, runtimePhase, sessionId, sessionTitle, t, thinkingLevel, workspaceId, workspaceName]);

  const formattedExport = useMemo(() => (
    document ? formatChatExport(document, format, labels) : ''
  ), [document, format, labels]);
  const formattedBytes = useMemo(() => (
    formattedExport ? new TextEncoder().encode(formattedExport).byteLength : 0
  ), [formattedExport]);
  const formattedSize = useMemo(() => new Intl.NumberFormat(undefined, {
    maximumFractionDigits: formattedBytes >= 1_000_000 ? 1 : 0,
  }).format(formattedBytes >= 1_000_000 ? formattedBytes / 1_000_000 : formattedBytes / 1_000), [formattedBytes]);

  const handleCopy = useCallback(async () => {
    if (!formattedExport) return;
    try {
      await writeTextToClipboard(formattedExport);
      setCopied(true);
      toast.success(t('copyChatSuccess'));
      window.setTimeout(() => setCopied(false), 1500);
    } catch (copyError) {
      console.error('[ChatExportDialog] Failed to copy chat export', copyError);
      toast.error(t('copyChatFailed'));
    }
  }, [formattedExport, t]);

  const handleDownload = useCallback(() => {
    if (!formattedExport) return;
    const extension = format === 'markdown' ? 'md' : format === 'json' ? 'json' : 'txt';
    const mimeType = format === 'json' ? 'application/json' : 'text/plain';
    const url = URL.createObjectURL(new Blob([formattedExport], { type: `${mimeType};charset=utf-8` }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeDownloadName(sessionTitle)}.${extension}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [format, formattedExport, sessionTitle]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="chat-export-dialog" className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border/70 px-6 pb-5 pt-6">
          <div className="mb-1 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
              <Copy className="h-4 w-4" />
            </div>
            <DialogTitle>{t('copyChat')}</DialogTitle>
          </div>
          <DialogDescription>{t('copyChatDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-5">
          <div role="radiogroup" aria-label={t('copyChatFormatLabel')} className="grid grid-cols-3 gap-2">
            {FORMAT_OPTIONS.map(({ format: option, icon: Icon }) => {
              const selected = format === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`chat-export-format-${option}`}
                  onClick={() => setFormat(option)}
                  className={cn(
                    'group relative min-h-20 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-28 sm:p-3',
                    selected
                      ? 'border-primary/50 bg-primary/[0.07] shadow-sm'
                      : 'border-border/70 bg-muted/20 hover:border-border hover:bg-muted/45',
                  )}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <Icon className={cn('h-4 w-4', selected ? 'text-primary' : 'text-muted-foreground')} />
                    <span className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-full border',
                      selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background',
                    )}>
                      {selected ? <Check className="h-2.5 w-2.5" /> : null}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-foreground">{t(FORMAT_TRANSLATIONS[option].label)}</div>
                  <p className="mt-1 hidden text-[11px] leading-relaxed text-muted-foreground sm:block">{t(FORMAT_TRANSLATIONS[option].description)}</p>
                </button>
              );
            })}
          </div>

          <div className="flex gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] p-3 text-amber-950 dark:text-amber-100">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs leading-relaxed">{t('copyChatSensitiveWarning')}</p>
          </div>

          <div className="flex min-h-14 items-center rounded-lg border border-border/70 bg-muted/20 px-3.5 py-3">
            {isLoading ? (
              <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t('copyChatLoading')}</span>
              </div>
            ) : error ? (
              <div className="flex w-full items-center justify-between gap-3">
                <span className="text-sm text-destructive">{error}</span>
                <Button size="sm" variant="outline" onClick={() => setLoadRevision((value) => value + 1)}>
                  {tCommon('retry')}
                </Button>
              </div>
            ) : document ? (
              <div className="flex w-full items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('copyChatReady', { count: document.snapshot.messageCount })}
                  </p>
                  {document.snapshot.active ? (
                    <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">{t('copyChatActiveSnapshot')}</p>
                  ) : (
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('copyChatCompleteSnapshot')}</p>
                  )}
                </div>
                <span className="shrink-0 rounded-md bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground shadow-sm ring-1 ring-border/70">
                  {formattedSize} {formattedBytes >= 1_000_000 ? 'MB' : 'KB'}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter className="border-t border-border/70 bg-muted/15 px-6 py-4 sm:justify-between">
          <Button variant="ghost" onClick={handleDownload} disabled={!formattedExport || isLoading}>
            <Download className="h-4 w-4" />
            {t('copyChatDownload')}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)}>{tCommon('cancel')}</Button>
            <Button data-testid="chat-export-copy" onClick={() => void handleCopy()} disabled={!formattedExport || isLoading}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? t('copyChatCopied') : t('copyChatCopyFormat', {
                format: t(FORMAT_TRANSLATIONS[format].label),
              })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
