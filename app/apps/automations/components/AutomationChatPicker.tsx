'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown, Loader2, MessageSquare, Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { AutomationPickerContent } from './AutomationPickerContent';
import { Button } from '@/components/ui/button';
import { Popover as PopoverPrimitive } from 'radix-ui';

type Chat = { sessionId: string; title: string | null; lastActivityAt: string };

export function AutomationChatPicker({
  value,
  onChange,
  workspaceId,
  agentId,
  jobId,
}: {
  value: string;
  onChange: (id: string) => void;
  workspaceId: string;
  agentId: string;
  jobId?: string | null;
}) {
  const t = useTranslations('automationen.ux');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState('');
  const [chats, setChats] = useState<Chat[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Chat | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ workspaceId, agentId, ...(jobId ? { jobId } : {}) });
    if (!open && !value) return;
    if (!open) params.set('sessionId', value);
    else {
      params.set('query', query);
      params.set('cursor', cursor);
    }
    const timer = setTimeout(
      async () => {
        setLoading(true);
        setError(false);
        if (!cursor) setChats([]);
        try {
          const response = await fetch(`/api/automations/chats?${params}`, {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'include',
          });
          const payload = await response.json();
          if (!response.ok || !payload.success) throw new Error('chat-list');
          if (controller.signal.aborted) return;
          const incoming: Chat[] = payload.data.chats;
          if (!open) setSelected(incoming.find((chat) => chat.sessionId === value) || null);
          else {
            setChats((previous) =>
              cursor
                ? Array.from(
                    new Map([...previous, ...incoming].map((chat) => [chat.sessionId, chat])).values(),
                  )
                : incoming,
            );
            setNextCursor(payload.data.nextCursor);
          }
        } catch {
          if (!controller.signal.aborted) setError(true);
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      },
      open && query ? 250 : 0,
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, value, workspaceId, agentId, jobId, query, cursor, retry]);

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setCursor('');
          setQuery('');
        }
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={!workspaceId}
          aria-label={t('chooseChat')}
          className="h-auto min-h-11 w-full justify-start gap-2 text-left"
          data-testid="automation-chat-picker"
        >
          <MessageSquare className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {selected?.sessionId === value
              ? selected.title || t('untitledChat')
              : value
                ? loading
                  ? t('loadingChats')
                  : t('chatUnavailable')
                : t('chooseChat')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </Button>
      </PopoverPrimitive.Trigger>
      <AutomationPickerContent
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        align="start"
        role="dialog"
        aria-label={t('chooseChat')}
        className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[calc(100vw-2rem)] p-2"
      >
        <label className="flex items-center gap-2 border-b px-2 pb-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            aria-label={t('searchChats')}
            placeholder={t('searchChats')}
            className="h-9 w-full bg-transparent text-sm outline-none"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor('');
              setChats([]);
              setNextCursor(null);
              setLoading(true);
            }}
          />
        </label>
        <div className="max-h-72 overflow-y-auto py-1" aria-busy={loading}>
          {error ? (
            <div role="alert" className="space-y-2 p-3 text-sm">
              <p>{t('chatLoadFailed')}</p>
              <Button variant="outline" size="sm" onClick={() => setRetry((current) => current + 1)}>
                {t('retry')}
              </Button>
            </div>
          ) : (
            chats.map((chat) => (
              <button
                key={chat.sessionId}
                type="button"
                aria-pressed={chat.sessionId === value}
                className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setSelected(chat);
                  onChange(chat.sessionId);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {chat.title || t('untitledChat')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(chat.lastActivityAt).toLocaleDateString(locale)}
                  </span>
                </span>
                {chat.sessionId === value ? <Check className="h-4 w-4 text-primary" /> : null}
              </button>
            ))
          )}
          {loading ? (
            <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('loadingChats')}
            </p>
          ) : !error && chats.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t('noChats')}</p>
          ) : null}
          {!loading && !error && nextCursor ? (
            <Button variant="ghost" className="w-full" onClick={() => setCursor(nextCursor)}>
              {t('loadMore')}
            </Button>
          ) : null}
        </div>
      </AutomationPickerContent>
    </PopoverPrimitive.Root>
  );
}
