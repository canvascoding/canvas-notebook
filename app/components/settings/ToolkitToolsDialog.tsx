'use client';

import { useCallback, useEffect, useState, startTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Search, X, ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type ToolkitToolInfo = {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
};

type ToolkitToolsDialogProps = {
  slug: string;
  name: string;
  logo: string;
  connected: boolean;
  onClose: () => void;
  onConnect?: (slug: string) => void;
  onDisconnect?: (slug: string) => void;
};

const PAGE_SIZE = 25;

export function ToolkitToolsDialog({
  slug,
  name,
  logo,
  connected,
  onClose,
  onConnect,
  onDisconnect,
}: ToolkitToolsDialogProps) {
  const t = useTranslations('settings.connectedApps');

  const [tools, setTools] = useState<ToolkitToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadTools = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/composio/toolkits/${encodeURIComponent(slug)}/tools`, {
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load tools');
      setTools(data.tools || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tools');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    startTransition(() => {
      void loadTools();
    });
  }, [loadTools]);

  const toggleExpanded = (toolSlug: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolSlug)) {
        next.delete(toolSlug);
      } else {
        next.add(toolSlug);
      }
      return next;
    });
  };

  const filteredTools = searchQuery
    ? tools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          tool.slug.toLowerCase().includes(searchQuery.toLowerCase()) ||
          tool.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : tools;

  const pagedTools = filteredTools.slice(0, page * PAGE_SIZE);
  const hasMore = filteredTools.length > page * PAGE_SIZE;

  const statusText = connected
    ? t('toolsAvailableConnected')
    : t('toolsAvailableNotConnected');

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative w-full rounded-t-lg border border-border bg-background shadow-lg sm:mx-4 sm:max-w-2xl sm:rounded-lg max-h-[90vh] sm:max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-0">
          <div className="flex items-center gap-3">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt={name} className="h-8 w-8" />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded bg-muted text-sm font-bold">
                {name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <h2 className="text-lg font-semibold truncate">{name}</h2>
              <p className="text-xs text-muted-foreground">
                {loading ? '...' : `${tools.length} ${t('toolsAvailable')}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {connected ? (
              onDisconnect && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => onDisconnect(slug)}
                >
                  {t('disconnect')}
                </Button>
              )
            ) : (
              onConnect && (
                <Button size="sm" onClick={() => onConnect(slug)}>
                  {t('connect')}
                </Button>
              )
            )}
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="border-b border-border px-4 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('searchTools')}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('loadingTools')}
            </div>
          ) : error ? (
            <p className="py-4 text-center text-sm text-destructive">{error}</p>
          ) : pagedTools.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('noToolsFound')}</p>
          ) : (
            <div className="space-y-1">
              {pagedTools.map((tool) => {
                const isExpanded = expandedTools.has(tool.slug);
                const hasDescription = tool.description.length > 0;
                const truncatedDesc = hasDescription && tool.description.length > 120
                  ? tool.description.slice(0, 120) + '...'
                  : tool.description;

                return (
                  <div
                    key={tool.slug}
                    className="rounded-md border border-transparent px-3 py-2 hover:bg-muted/50"
                  >
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 text-left"
                      onClick={() => hasDescription && toggleExpanded(tool.slug)}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-tight">{tool.name}</p>
                        <p className="text-[11px] font-mono text-muted-foreground">{tool.slug}</p>
                        {hasDescription && (isExpanded ? (
                          <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p>
                        ) : (
                          <p className="mt-1 text-xs text-muted-foreground">{truncatedDesc}</p>
                        ))}
                      </div>
                      {hasDescription && (
                        <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {hasMore && (
            <div className="flex justify-center pt-3">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>
                {t('loadMore')} ({filteredTools.length - page * PAGE_SIZE} {t('remaining')})
              </Button>
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-2">
          <p className="text-[11px] text-muted-foreground">{statusText}</p>
        </div>
      </div>
    </div>
  );
}