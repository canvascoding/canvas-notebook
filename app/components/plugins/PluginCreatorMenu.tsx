'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronDown, Loader2, PackagePlus, Plus, Sparkles } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { CapabilityPackageCreatorOptions } from '@/app/lib/capabilities/packages/creator-chat-contracts';
import { readCapabilityPackageCreatorOptions, startCapabilityPackageCreatorChat } from './creator-chat-client';
import { confirmPluginNavigation } from './plugin-navigation-guard';

/** Both plugin surfaces use the same Creator entry and existing chat transport. */
export function PluginCreatorMenu({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('skills.creator'), locale = useLocale(), router = useRouter();
  const [state, setState] = useState<{ workspaceId: string; data?: CapabilityPackageCreatorOptions; error?: boolean } | null>(null);
  const [retry, setRetry] = useState(0), [opening, setOpening] = useState(false), [startError, setStartError] = useState(false);
  const busy = useRef(false), current = useRef<string | null>(workspaceId);
  useLayoutEffect(() => { current.current = workspaceId; return () => { current.current = null; }; }, [workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    void readCapabilityPackageCreatorOptions(workspaceId, controller.signal).then(data => {
      if (!controller.signal.aborted && current.current === workspaceId) setState({ workspaceId, data });
    }, error => {
      if (!controller.signal.aborted && current.current === workspaceId && error?.name !== 'AbortError') setState({ workspaceId, error: true });
    });
    return () => controller.abort();
  }, [workspaceId, retry]);
  const active = state?.workspaceId === workspaceId ? state : null, loading = !active;
  const start = async (kind: 'plugin' | 'skill') => {
    if (busy.current) return;
    busy.current = true; setOpening(true); setStartError(false);
    try {
      await startCapabilityPackageCreatorChat(workspaceId, { operation: 'create', kind, locale: locale === 'de' ? 'de' : 'en' },
        href => router.push(href), { isCurrent: () => current.current === workspaceId && confirmPluginNavigation() });
    } catch (error) {
      if (current.current === workspaceId && !(error instanceof Error && error.name === 'AbortError')) setStartError(true);
    } finally { busy.current = false; if (current.current === workspaceId) setOpening(false); }
  };
  return <div className="min-w-0 space-y-2" data-testid="plugin-creator-entry">
    <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" size="sm" disabled={loading || opening || !active?.data?.canCreate}
      aria-busy={loading || opening} title={active?.data && !active.data.canCreate ? t('permissionRequired') : undefined} data-testid="plugin-creator-menu">
      {loading || opening ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
      {opening ? t('opening') : t('create')}<ChevronDown className="size-3.5" aria-hidden="true" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-2rem)]">
        {(['plugin', 'skill'] as const).map(kind => { const Icon = kind === 'plugin' ? PackagePlus : Sparkles;
          return <DropdownMenuItem key={kind} className="items-start gap-3 py-3" disabled={!active?.data?.creators.some(creator => creator.kind === kind && creator.available)}
            data-testid={`plugin-creator-start-${kind}`} onSelect={() => { void start(kind); }}>
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span className="min-w-0"><span className="block font-medium">{t(kind)}</span>
              <span className="mt-0.5 block whitespace-normal text-xs leading-relaxed text-muted-foreground">{t(`${kind}Description`)}</span></span>
          </DropdownMenuItem>; })}
      </DropdownMenuContent>
    </DropdownMenu>
    {active?.error || startError ? <InlineNotice size="compact" variant="warning" actions={<Button type="button" size="sm" variant="ghost"
      onClick={() => { setState(null); setStartError(false); setRetry(value => value + 1); }}>{t('retry')}</Button>}>{t(active?.error ? 'loadError' : 'startError')}</InlineNotice> : null}
  </div>;
}
