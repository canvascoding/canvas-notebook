'use client';

import { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, FileText, Filter, Globe2, Loader2, RefreshCw, Search, ShieldAlert, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface PublicShare {
  id: string;
  workspacePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: 'active' | 'revoked' | 'missing' | 'stale' | 'expired';
  source: 'ui' | 'agent';
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  publicUrl: string;
}

const STATUS_FILTERS = ['all', 'active', 'expired', 'missing', 'stale', 'revoked'] as const;
const TYPE_FILTERS = ['all', 'image', 'html', 'pdf', 'media', 'other'] as const;
const SOURCE_FILTERS = ['all', 'ui', 'agent'] as const;

type StatusFilter = typeof STATUS_FILTERS[number];
type TypeFilter = typeof TYPE_FILTERS[number];
type SourceFilter = typeof SOURCE_FILTERS[number];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function statusClass(status: PublicShare['status']) {
  if (status === 'active') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'expired') return 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300';
  if (status === 'revoked') return 'border-muted bg-muted text-muted-foreground';
  return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
}

export function PublicSharesClient() {
  const t = useTranslations('security.publicShares');
  const [shares, setShares] = useState<PublicShare[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [type, setType] = useState<TypeFilter>('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadShares = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status,
        type,
        source,
        q: query,
        limit: '1000',
      });
      const response = await fetch(`/api/security/public-shares?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('loadFailed'));
      }
      setShares(payload.shares || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('loadFailed');
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void loadShares();
    }, 150);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, status, type, source]);

  const summary = useMemo(() => {
    const active = shares.filter((share) => share.status === 'active').length;
    return {
      total: shares.length,
      active,
      inactive: shares.length - active,
    };
  }, [shares]);

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  const revokeShare = async (share: PublicShare) => {
    setRevokingId(share.id);
    try {
      const response = await fetch(`/api/security/public-shares/${encodeURIComponent(share.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('revokeFailed'));
      }
      toast.success(t('revoked'));
      await loadShares();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('revokeFailed'));
    } finally {
      setRevokingId(null);
    }
  };

  const renderShareActions = (share: PublicShare, compact = false) => (
    <div className={cn('flex flex-wrap gap-1', compact ? 'justify-start' : 'justify-end')}>
      <Button variant="ghost" size="icon-sm" onClick={() => copyUrl(share.publicUrl)} title={t('copyUrl')}>
        <Copy className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon-sm" asChild title={t('openPublicUrl')}>
        <a href={share.publicUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
      <Button variant="ghost" size="icon-sm" asChild title={t('openFile')}>
        <Link href={`/files?path=${encodeURIComponent(share.workspacePath)}`}>
          <FileText className="h-4 w-4" />
        </Link>
      </Button>
      {share.status === 'active' && (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => void revokeShare(share)}
          disabled={revokingId === share.id}
        >
          {revokingId === share.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('revoke')}
        </Button>
      )}
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4 p-3 sm:p-4 md:p-6">
      <section className="min-w-0 border border-border bg-background p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
              <ShieldAlert className="h-4 w-4" />
              {t('securityNoteTitle')}
            </div>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('securityNote')}</p>
          </div>
          <div className="grid w-full grid-cols-3 gap-2 text-center text-xs lg:w-auto">
            <div className="min-w-0 border border-border px-2 py-2 sm:px-3">
              <div className="text-lg font-semibold">{summary.total}</div>
              <div className="truncate text-muted-foreground">{t('total')}</div>
            </div>
            <div className="min-w-0 border border-border px-2 py-2 sm:px-3">
              <div className="text-lg font-semibold text-emerald-600">{summary.active}</div>
              <div className="truncate text-muted-foreground">{t('active')}</div>
            </div>
            <div className="min-w-0 border border-border px-2 py-2 sm:px-3">
              <div className="text-lg font-semibold text-muted-foreground">{summary.inactive}</div>
              <div className="truncate text-muted-foreground">{t('inactive')}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="min-w-0 overflow-hidden border border-border bg-background">
        <div className="flex flex-col gap-3 border-b border-border p-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchPlaceholder')}
              className="pl-9"
            />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            {STATUS_FILTERS.map((item) => (
              <Button key={item} size="sm" variant={status === item ? 'default' : 'outline'} onClick={() => setStatus(item)}>
                {t(`status.${item}`)}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2 border-b border-border p-3">
          {TYPE_FILTERS.map((item) => (
            <Button key={item} size="sm" variant={type === item ? 'secondary' : 'ghost'} onClick={() => setType(item)}>
              {t(`type.${item}`)}
            </Button>
          ))}
          <div className="flex w-full flex-wrap gap-2 lg:ml-auto lg:w-auto">
            {SOURCE_FILTERS.map((item) => (
              <Button key={item} size="sm" variant={source === item ? 'secondary' : 'ghost'} onClick={() => setSource(item)}>
                {t(`source.${item}`)}
              </Button>
            ))}
            <Button size="sm" variant="outline" onClick={() => void loadShares()} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              {t('refresh')}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-center">
            <XCircle className="h-8 w-8 text-destructive" />
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void loadShares()}>{t('tryAgain')}</Button>
          </div>
        ) : shares.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
            <Globe2 className="h-9 w-9 text-muted-foreground/50" />
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('emptyDescription')}</p>
          </div>
        ) : (
          <>
          <div className="grid gap-3 p-3 md:hidden">
            {shares.map((share) => (
              <article key={share.id} className="min-w-0 border border-border bg-background p-3">
                <div className="mb-3 flex min-w-0 items-start gap-2">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="break-all font-medium" title={share.fileName}>{share.fileName}</div>
                    <div className="mt-1 break-all font-mono text-xs text-muted-foreground" title={share.workspacePath}>
                      {share.workspacePath}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-muted-foreground" title={share.publicUrl}>
                      {share.publicUrl}
                    </div>
                  </div>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="min-w-0">
                    <div className="text-muted-foreground">{t('statusLabel')}</div>
                    <Badge variant="outline" className={statusClass(share.status)}>{t(`status.${share.status}`)}</Badge>
                  </div>
                  <div className="min-w-0">
                    <div className="text-muted-foreground">{t('typeLabel')}</div>
                    <div className="break-all">{share.mimeType}</div>
                    <div className="text-muted-foreground">{formatBytes(share.sizeBytes)}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-muted-foreground">{t('expires')}</div>
                    <div>{share.expiresAt ? formatDate(share.expiresAt) : t('never')}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-muted-foreground">{t('accesses')}</div>
                    <div>{share.accessCount}</div>
                  </div>
                </div>
                {renderShareActions(share, true)}
              </article>
            ))}
          </div>
          <div className="hidden max-w-full overflow-x-auto md:block">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('file')}</th>
                  <th className="px-3 py-2 font-medium">{t('statusLabel')}</th>
                  <th className="px-3 py-2 font-medium">{t('typeLabel')}</th>
                  <th className="px-3 py-2 font-medium">{t('expires')}</th>
                  <th className="px-3 py-2 font-medium">{t('accesses')}</th>
                  <th className="px-3 py-2 font-medium">{t('lastAccess')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {shares.map((share) => (
                  <tr key={share.id} className="border-b border-border/70 last:border-0">
                    <td className="max-w-[360px] px-3 py-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="truncate font-medium" title={share.fileName}>{share.fileName}</div>
                          <div className="truncate font-mono text-xs text-muted-foreground" title={share.workspacePath}>{share.workspacePath}</div>
                          <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={share.publicUrl}>{share.publicUrl}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant="outline" className={statusClass(share.status)}>{t(`status.${share.status}`)}</Badge>
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      <div>{share.mimeType}</div>
                      <div>{formatBytes(share.sizeBytes)}</div>
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{share.expiresAt ? formatDate(share.expiresAt) : t('never')}</td>
                    <td className="px-3 py-3">{share.accessCount}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{formatDate(share.lastAccessedAt)}</td>
                    <td className="px-3 py-3">
                      {renderShareActions(share)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
    </div>
  );
}
