'use client';

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, RefreshCw } from 'lucide-react';
import type { CapabilityPackageDescriptor, CapabilityPackagePublishedSummary } from '@/app/lib/capabilities/packages/contracts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { PackageWorkspaceRequestError, workspaceRequest } from './plugin-workspace-client';

/** Version history is a Read operation. No file bytes or draft/edit authority are requested. */
export function PackageDetailVersions({ resourceRef, workspaceId }: { resourceRef: string; workspaceId: string | null }) {
  return <PackageVersionSession key={JSON.stringify([resourceRef, workspaceId])} resourceRef={resourceRef} workspaceId={workspaceId} />;
}

function PackageVersionSession({ resourceRef, workspaceId }: { resourceRef: string; workspaceId: string | null }) {
  const t = useTranslations('skills.workspace.detail'), locale = useLocale();
  const [value, setValue] = useState<{ versions: CapabilityPackagePublishedSummary[]; current: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'accessError' | 'loadError' | null>(null);
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController(), current = ++generation.current;
    controller.current = request;
    setLoading(true); setValue(null); setError(null);
    try {
      const path = `/api/capabilities/packages/${encodeURIComponent(resourceRef)}`;
      const [head, list] = await Promise.all([
        workspaceRequest<{ package: CapabilityPackageDescriptor }>(path, workspaceId, { signal: request.signal }),
        workspaceRequest<{ versions: CapabilityPackagePublishedSummary[] }>(`${path}/versions`, workspaceId, { signal: request.signal }),
      ]);
      if (request.signal.aborted || current !== generation.current) return;
      if (!head.package.access.canRead || ![head.package.resource.resourceRef, head.package.resource.legacyResourceId].includes(resourceRef) || !Array.isArray(list.versions)
        || list.versions.some(version => version.resourceRef !== head.package.resource.resourceRef)) throw new PackageWorkspaceRequestError(403, 'PACKAGE_ACCESS_DENIED');
      setValue({ versions: list.versions, current: head.package.state?.currentPublishedRevisionRef ?? null });
    } catch (failure) {
      if (!request.signal.aborted && current === generation.current) setError(failure instanceof PackageWorkspaceRequestError && [401, 403, 404].includes(failure.status) ? 'accessError' : 'loadError');
    } finally { if (!request.signal.aborted && current === generation.current) setLoading(false); }
  }, [resourceRef, workspaceId]);
  useEffect(() => {
    startTransition(() => void load());
    return () => { controller.current?.abort(); generation.current += 1; };
  }, [load]);
  const formatDate = (value: number) => Number.isFinite(value) && value > 0
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value) : t('unknown');
  return <section className="space-y-4" data-testid="package-detail-versions">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{t('versionsTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('versionsHint')}</p></div>
      <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className="size-4" />{t('reload')}</Button>
    </header>
    {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{t('loading')}</p>
      : error ? <InlineNotice variant="destructive" size="compact">{t(error)}</InlineNotice>
        : !value?.versions.length ? <p className="rounded-xl border p-5 text-sm text-muted-foreground">{t('noVersions')}</p>
          : <ol className="divide-y rounded-xl border">{value.versions.map(version => <li key={version.revisionRef} className="min-w-0 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-words font-semibold">{version.version}</span>
              {version.revisionRef === value.current ? <Badge variant="secondary">{t('currentVersion')}</Badge> : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{formatDate(version.publishedAt)}{' · '}{t('versionFiles', { count: version.fileCount })}{' · '}{t('versionBytes', { count: version.totalBytes })}</p>
            <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{t('versionIdentity')}</summary>
              <dl className="mt-2 space-y-2 font-mono"><div><dt className="font-sans text-muted-foreground">{t('revisionRef')}</dt><dd className="mt-1 [overflow-wrap:anywhere]">{version.revisionRef}</dd></div>
                <div><dt className="font-sans text-muted-foreground">{t('checksum')}</dt><dd className="mt-1 [overflow-wrap:anywhere]">{version.checksum}</dd></div></dl>
            </details>
          </li>)}</ol>}
  </section>;
}
