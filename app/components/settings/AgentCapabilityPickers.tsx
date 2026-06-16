'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Loader2, Plug, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { CanvasSkillIcon } from '@/app/lib/skills/skill-icons';
import type { CanvasSkillInterface } from '@/app/lib/skills/canvas-skill-manifest';
import { cn } from '@/lib/utils';

export type SkillOption = {
  name: string;
  title?: string;
  description?: string;
  enabled?: boolean;
  interface?: CanvasSkillInterface;
  plugin?: {
    name: string;
    skillAssetPath?: string;
  };
};

export type AgentConnectionOption = {
  id: string;
  label: string;
  kind: 'mcp' | 'composio';
  toolCount: number;
  logoUrl?: string | null;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

type AgentRelevantSkillsPickerProps = {
  enabled: boolean;
  selectedSkillNames: string[];
  onSelectedSkillNamesChange: (skillNames: string[]) => void;
  pageSize?: number;
};

type AgentConnectionsPickerProps = {
  enabled: boolean;
  selectedConnectionIds: string[];
  onSelectedConnectionIdsChange: (connectionIds: string[]) => void;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 8;
const connectionLogoLoadCache = new Map<string, string | null>();

function preloadConnectionLogo(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new window.Image();
    image.onload = () => resolve(url);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function useSequentialConnectionLogos(connections: AgentConnectionOption[], shouldLoad: boolean) {
  const [logoUrls, setLogoUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!shouldLoad || connections.length === 0) return;
    let cancelled = false;

    async function loadLogos() {
      for (const connection of connections) {
        const sourceUrl = connection.logoUrl;
        if (!sourceUrl) continue;

        const cacheKey = `${connection.id}:${sourceUrl}`;
        const cachedLogoUrl = connectionLogoLoadCache.get(cacheKey);
        if (cachedLogoUrl !== undefined) {
          if (!cancelled && cachedLogoUrl) {
            setLogoUrls((current) => ({ ...current, [connection.id]: cachedLogoUrl }));
          }
          continue;
        }

        const loadedLogoUrl = await preloadConnectionLogo(sourceUrl);
        connectionLogoLoadCache.set(cacheKey, loadedLogoUrl);
        if (cancelled) return;
        if (loadedLogoUrl) {
          setLogoUrls((current) => ({ ...current, [connection.id]: loadedLogoUrl }));
        }
      }
    }

    void loadLogos();
    return () => {
      cancelled = true;
    };
  }, [connections, shouldLoad]);

  return logoUrls;
}

function LoadingSkeletonGrid({ rows = 4 }: { rows?: number }) {
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="min-w-0 rounded-md border bg-background p-3">
          <div className="flex min-w-0 items-start gap-3">
            <Skeleton className="h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PaginationControls({
  pagination,
  onPageChange,
}: {
  pagination: Pagination | null;
  onPageChange: (page: number) => void;
}) {
  const t = useTranslations('settings.agentPanel.capabilities');
  if (!pagination || pagination.total <= pagination.limit) return null;

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
      <span>
        {t('paginationSummary', {
          page: pagination.page,
          totalPages: pagination.totalPages,
          total: pagination.total,
        })}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(pagination.page - 1)}
          disabled={!pagination.hasPrev}
          className="h-8"
        >
          <ChevronLeft className="mr-1 h-3.5 w-3.5" />
          {t('previous')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(pagination.page + 1)}
          disabled={!pagination.hasNext}
          className="h-8"
        >
          {t('next')}
          <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="pl-9 pr-9"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          type="button"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          onClick={() => onChange('')}
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function SelectedChips({
  selectedIds,
  knownLabels,
  onRemove,
}: {
  selectedIds: string[];
  knownLabels: Record<string, string>;
  onRemove: (id: string) => void;
}) {
  if (selectedIds.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {selectedIds.map((id) => (
        <Badge key={id} variant="secondary" className="max-w-full gap-1 rounded-md">
          <span className="truncate">{knownLabels[id] || id}</span>
          <button type="button" onClick={() => onRemove(id)} className="shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

function ConnectionLogo({
  connection,
  logoUrl,
}: {
  connection: AgentConnectionOption;
  logoUrl?: string;
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);

  if (logoUrl && failedLogoUrl !== logoUrl) {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt=""
          className="h-6 w-6 object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setFailedLogoUrl(logoUrl)}
        />
      </span>
    );
  }

  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
      {connection.kind === 'mcp' ? <Plug className="h-4 w-4" /> : connection.label.charAt(0)}
    </span>
  );
}

export function AgentRelevantSkillsPicker({
  enabled,
  selectedSkillNames,
  onSelectedSkillNamesChange,
  pageSize = DEFAULT_PAGE_SIZE,
}: AgentRelevantSkillsPickerProps) {
  const t = useTranslations('settings.agentPanel.capabilities.skills');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [knownSkillLabels, setKnownSkillLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setStatus('loading');
      setError(null);
    });

    async function loadSkills() {
      try {
        const params = new URLSearchParams({
          summary: '1',
          enabledOnly: '1',
          page: String(page),
          limit: String(pageSize),
        });
        if (query) params.set('query', query);
        const response = await fetch(`/api/skills?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          skills?: SkillOption[];
          pagination?: Pagination;
          error?: string;
        };
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || t('loadError'));
        }
        const nextSkills = Array.isArray(payload.skills) ? payload.skills : [];
        setSkills(nextSkills);
        setPagination(payload.pagination || null);
        setKnownSkillLabels((current) => ({
          ...current,
          ...Object.fromEntries(nextSkills.map((skill) => [skill.name, skill.name])),
        }));
        setStatus('loaded');
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setStatus('error');
        setError(loadError instanceof Error ? loadError.message : t('loadError'));
      }
    }

    void loadSkills();
    return () => controller.abort();
  }, [enabled, page, pageSize, query, t]);

  const selectedSet = useMemo(() => new Set(selectedSkillNames), [selectedSkillNames]);

  function toggleSkill(skillName: string) {
    onSelectedSkillNamesChange(
      selectedSet.has(skillName)
        ? selectedSkillNames.filter((name) => name !== skillName)
        : [...selectedSkillNames, skillName],
    );
  }

  if (!enabled) return null;

  return (
    <div className="min-w-0 space-y-3">
      <SearchBox value={searchInput} onChange={setSearchInput} placeholder={t('searchPlaceholder')} />
      <SelectedChips
        selectedIds={selectedSkillNames}
        knownLabels={knownSkillLabels}
        onRemove={(skillName) => onSelectedSkillNamesChange(selectedSkillNames.filter((name) => name !== skillName))}
      />
      {status === 'loading' || status === 'idle' ? (
        <LoadingSkeletonGrid rows={4} />
      ) : status === 'error' ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error || t('loadError')}</p>
      ) : skills.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{query ? t('emptySearch') : t('empty')}</p>
      ) : (
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {skills.map((skill) => {
            const selected = selectedSet.has(skill.name);
            return (
              <button
                key={skill.name}
                type="button"
                onClick={() => toggleSkill(skill.name)}
                className={cn(
                  'flex min-w-0 items-start gap-3 rounded-md border p-3 text-left transition',
                  selected ? 'border-primary bg-primary/5' : 'border-border bg-background hover:bg-muted/40',
                )}
                aria-pressed={selected}
              >
                <CanvasSkillIcon skill={skill} className="mt-0.5 h-9 w-9" />
                <span className={cn(
                  'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                  selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                )}>
                  {selected ? <Check className="h-3.5 w-3.5" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-all text-sm font-medium">{skill.name}</span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description || t('noDescription')}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <PaginationControls pagination={pagination} onPageChange={setPage} />
    </div>
  );
}

export function AgentConnectionsPicker({
  enabled,
  selectedConnectionIds,
  onSelectedConnectionIdsChange,
  pageSize = DEFAULT_PAGE_SIZE,
}: AgentConnectionsPickerProps) {
  const t = useTranslations('settings.agentPanel.capabilities.connections');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [connections, setConnections] = useState<AgentConnectionOption[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [knownConnectionLabels, setKnownConnectionLabels] = useState<Record<string, string>>({});
  const connectionLogoUrls = useSequentialConnectionLogos(connections, enabled && status === 'loaded');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setStatus('loading');
      setError(null);
    });

    async function loadConnections() {
      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(pageSize),
        });
        if (query) params.set('query', query);
        const response = await fetch(`/api/agents/connection-options?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          data?: { connections?: AgentConnectionOption[]; pagination?: Pagination };
          error?: string;
        };
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || t('loadError'));
        }
        const nextConnections = Array.isArray(payload.data?.connections) ? payload.data.connections : [];
        setConnections(nextConnections);
        setPagination(payload.data?.pagination || null);
        setKnownConnectionLabels((current) => ({
          ...current,
          ...Object.fromEntries(nextConnections.map((connection) => [connection.id, connection.label])),
        }));
        setStatus('loaded');
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setStatus('error');
        setError(loadError instanceof Error ? loadError.message : t('loadError'));
      }
    }

    void loadConnections();
    return () => controller.abort();
  }, [enabled, page, pageSize, query, t]);

  const selectedSet = useMemo(() => new Set(selectedConnectionIds), [selectedConnectionIds]);

  function toggleConnection(connectionId: string) {
    onSelectedConnectionIdsChange(
      selectedSet.has(connectionId)
        ? selectedConnectionIds.filter((id) => id !== connectionId)
        : [...selectedConnectionIds, connectionId],
    );
  }

  if (!enabled) return null;

  return (
    <div className="min-w-0 space-y-3">
      <SearchBox value={searchInput} onChange={setSearchInput} placeholder={t('searchPlaceholder')} />
      <SelectedChips
        selectedIds={selectedConnectionIds}
        knownLabels={knownConnectionLabels}
        onRemove={(connectionId) => onSelectedConnectionIdsChange(selectedConnectionIds.filter((id) => id !== connectionId))}
      />
      {status === 'loading' || status === 'idle' ? (
        <LoadingSkeletonGrid rows={2} />
      ) : status === 'error' ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error || t('loadError')}</p>
      ) : connections.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{query ? t('emptySearch') : t('empty')}</p>
      ) : (
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {connections.map((connection) => {
            const selected = selectedSet.has(connection.id);
            return (
              <button
                key={connection.id}
                type="button"
                onClick={() => toggleConnection(connection.id)}
                className={cn(
                  'flex min-w-0 items-start gap-3 rounded-md border p-3 text-left transition',
                  selected
                    ? 'border-primary bg-primary/10 shadow-sm ring-2 ring-primary/35'
                    : 'border-border bg-background hover:border-primary/40 hover:bg-muted/40',
                )}
                aria-pressed={selected}
              >
                <ConnectionLogo connection={connection} logoUrl={connectionLogoUrls[connection.id]} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{connection.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {connection.kind === 'mcp'
                      ? t('mcpDetail', { count: connection.toolCount })
                      : t('composioDetail', { count: connection.toolCount })}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-2">
                  <Badge variant={connection.kind === 'mcp' ? 'secondary' : 'outline'} className="uppercase">
                    {connection.kind}
                  </Badge>
                  <span className={cn(
                    'inline-flex h-5 w-5 items-center justify-center rounded-full border transition',
                    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30 bg-background',
                  )}>
                    {selected ? <Check className="h-3.5 w-3.5" /> : null}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <PaginationControls pagination={pagination} onPageChange={setPage} />
    </div>
  );
}

export function InlineLoadingStatus({ label }: { label: string }) {
  return (
    <div className="flex items-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}
