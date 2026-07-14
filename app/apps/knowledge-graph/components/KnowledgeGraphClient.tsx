'use client';

import {
  AlertTriangle,
  FileText,
  Filter,
  FolderTree,
  Layers3,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Tag,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { KnowledgeGraphCanvas } from './KnowledgeGraphCanvas';
import {
  buildKnowledgeGraphData,
  type KnowledgeGraphColorMode,
  type KnowledgeGraphNode,
} from '@/app/apps/knowledge-graph/lib/knowledge-graph-model';
import { workspaceHeaders, withWorkspaceQuery } from '@/app/lib/files/client';
import type { WorkspaceLinkIndex } from '@/app/lib/markdown/workspace-link-index-core';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { getPathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

type LinkIndexResponse = {
  error?: string;
  index?: WorkspaceLinkIndex;
  success?: boolean;
};

const EMPTY_INDEX: WorkspaceLinkIndex = {
  backlinks: {},
  brokenLinks: [],
  documents: [],
  edges: [],
  generatedAt: new Date(0).toISOString(),
};

function ControlSection({
  children,
  icon: Icon,
  open = false,
  title,
}: {
  children: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  open?: boolean;
  title: string;
}) {
  return (
    <details open={open} className="group border-b border-border/60 last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold marker:hidden hover:bg-muted/40">
        <Icon className="h-4 w-4 text-cyan-500" />
        <span>{title}</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="space-y-3 px-4 pb-4">{children}</div>
    </details>
  );
}

function ToggleRow({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

export function KnowledgeGraphClient() {
  const t = useTranslations('knowledgeGraph');
  const locale = useLocale();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [index, setIndex] = useState<WorkspaceLinkIndex>(EMPTY_INDEX);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<KnowledgeGraphNode | null>(null);
  const [showOrphans, setShowOrphans] = useState(true);
  const [showBroken, setShowBroken] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [colorMode, setColorMode] = useState<KnowledgeGraphColorMode>('status');
  const [gravity, setGravity] = useState(1);
  const [scalingRatio, setScalingRatio] = useState(2);
  const [appliedForces, setAppliedForces] = useState({
    gravity: 1,
    scalingRatio: 2,
    version: 0,
  });

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const controller = new AbortController();
    const url = withWorkspaceQuery('/api/markdown/link-index', activeWorkspaceId);
    void fetch(url, {
      cache: 'no-store',
      credentials: 'include',
      headers: workspaceHeaders(activeWorkspaceId),
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json() as LinkIndexResponse;
      if (!response.ok || !payload.success || !payload.index) {
        throw new Error(payload.error || t('errors.load'));
      }
      setIndex(payload.index);
      setError(null);
      setLoading(false);
    }).catch((fetchError) => {
      if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
      setError(fetchError instanceof Error ? fetchError.message : t('errors.load'));
      setLoading(false);
    });
    return () => controller.abort();
  }, [activeWorkspaceId, refreshVersion, t]);

  const graphData = useMemo(() => buildKnowledgeGraphData(index, {
    colorMode,
    showBroken,
    showOrphans,
  }), [colorMode, index, showBroken, showOrphans]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return graphData.nodes
      .filter((node) => node.kind === 'document' && (
        node.label.toLocaleLowerCase().includes(normalized)
        || node.path?.toLocaleLowerCase().includes(normalized)
        || node.aliases.some((alias) => alias.toLocaleLowerCase().includes(normalized))
      ))
      .sort((left, right) => {
        const leftStarts = left.label.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
        const rightStarts = right.label.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
        return leftStarts - rightStarts || left.label.localeCompare(right.label);
      })
      .slice(0, 7);
  }, [graphData.nodes, query]);

  const focusedNode = useMemo(() => (
    graphData.nodes.find((node) => node.id === focusNodeId) ?? null
  ), [focusNodeId, graphData.nodes]);
  const inspectedNode = hoveredNode ?? focusedNode;

  const openDocument = useCallback((path: string) => {
    const notebookHref = getPathname({
      locale,
      href: { pathname: '/notebook', query: { path } },
    });
    window.open(notebookHref, '_blank', 'noopener,noreferrer,popup=yes');
  }, [locale]);
  const handleNodeHover = useCallback((node: KnowledgeGraphNode | null) => {
    setHoveredNode(node);
  }, []);
  const focusSearchResult = (node: KnowledgeGraphNode) => {
    setFocusNodeId(node.id);
    setQuery(node.label);
  };
  const refresh = () => {
    setLoading(true);
    setRefreshVersion((version) => version + 1);
  };

  const stats = {
    documents: index.documents.length,
    links: index.edges.length,
    broken: index.brokenLinks.length,
  };

  return (
    <div className="relative h-full min-h-[520px] overflow-hidden bg-[#071018] text-slate-100">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,.13) 1px, transparent 0)',
          backgroundSize: '24px 24px',
          maskImage: 'linear-gradient(to bottom right, black, transparent 86%)',
        }}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_45%_42%,rgba(14,116,144,0.13),transparent_34%),radial-gradient(circle_at_70%_75%,rgba(30,41,59,0.8),transparent_46%)]" />

      {!loading && !error && graphData.nodes.length > 0 ? (
        <KnowledgeGraphCanvas
          data={graphData}
          focusNodeId={focusNodeId}
          forceVersion={appliedForces.version}
          gravity={appliedForces.gravity}
          onNodeOpen={openDocument}
          onNodeHover={handleNodeHover}
          scalingRatio={appliedForces.scalingRatio}
          showLabels={showLabels}
        />
      ) : null}

      <div className="absolute left-4 top-4 z-20 w-[min(390px,calc(100%-2rem))] md:left-6 md:top-6">
        <div className="border border-slate-700/70 bg-slate-950/78 shadow-[0_18px_60px_-24px_rgba(0,0,0,.9)] backdrop-blur-xl">
          <div className="flex items-center gap-2 border-b border-slate-700/60 px-3 py-2.5">
            <Search className="h-4 w-4 text-cyan-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || searchResults.length === 0) return;
                event.preventDefault();
                focusSearchResult(searchResults[0]);
              }}
              placeholder={t('search.placeholder')}
              className="h-8 border-0 bg-transparent px-1 text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:ring-0"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              onClick={refresh}
              aria-label={t('actions.refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>
          <div className="flex items-center gap-3 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-400">
            <span><strong className="text-cyan-300">{stats.documents}</strong> {t('stats.documents')}</span>
            <span><strong className="text-slate-200">{stats.links}</strong> {t('stats.links')}</span>
            <span><strong className={cn(stats.broken > 0 ? 'text-rose-400' : 'text-emerald-400')}>{stats.broken}</strong> {t('stats.broken')}</span>
          </div>
        </div>

        {query.trim() && searchResults.length > 0 ? (
          <div className="mt-1 max-h-72 overflow-y-auto border border-slate-700/70 bg-slate-950/92 p-1 shadow-2xl backdrop-blur-xl">
            {searchResults.map((node) => (
              <div key={node.id} className="group flex items-center gap-2 px-2 py-2 hover:bg-slate-800/80">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => focusSearchResult(node)}>
                  <span className="block truncate text-xs font-semibold text-slate-100">{node.label}</span>
                  <span className="block truncate font-mono text-[10px] text-slate-500">{node.path}</span>
                </button>
                {node.path ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-slate-500 opacity-0 hover:bg-slate-700 hover:text-cyan-300 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t('actions.openDocument', { title: node.label })}
                    onClick={() => openDocument(node.path!)}
                  >
                    <FileText className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <aside className="absolute bottom-4 right-4 top-auto z-20 max-h-[min(70vh,640px)] w-[min(320px,calc(100%-2rem))] overflow-y-auto border border-slate-700/70 bg-slate-950/82 text-slate-100 shadow-[0_24px_80px_-28px_rgba(0,0,0,.95)] backdrop-blur-xl md:bottom-6 md:right-6 md:top-6 md:max-h-none">
        <div className="border-b border-slate-700/60 px-4 py-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">{t('eyebrow')}</div>
          <h2 className="mt-1 text-base font-semibold tracking-tight">{t('controls.title')}</h2>
        </div>

        <ControlSection icon={Filter} title={t('controls.filters')} open>
          <ToggleRow checked={showOrphans} label={t('filters.orphans')} onCheckedChange={setShowOrphans} />
          <ToggleRow checked={showBroken} label={t('filters.broken')} onCheckedChange={setShowBroken} />
        </ControlSection>

        <ControlSection icon={Layers3} title={t('controls.groups')}>
          <div className="grid grid-cols-3 gap-1 border border-slate-700/70 bg-slate-900/60 p-1">
            {(['status', 'folder', 'tag'] as const).map((mode) => {
              const Icon = mode === 'status' ? Sparkles : mode === 'folder' ? FolderTree : Tag;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setColorMode(mode)}
                  className={cn(
                    'flex flex-col items-center gap-1 px-1 py-2 text-[10px] transition-colors',
                    colorMode === mode ? 'bg-cyan-400 text-slate-950' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(`groups.${mode}`)}
                </button>
              );
            })}
          </div>
        </ControlSection>

        <ControlSection icon={Settings2} title={t('controls.display')}>
          <ToggleRow checked={showLabels} label={t('display.labels')} onCheckedChange={setShowLabels} />
          <div className="grid grid-cols-3 gap-2 pt-1 text-[10px] text-slate-400">
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-cyan-400" />{t('legend.document')}</span>
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-amber-400" />{t('legend.ambiguous')}</span>
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-rose-400" />{t('legend.missing')}</span>
          </div>
        </ControlSection>

        <ControlSection icon={Link2} title={t('controls.forces')}>
          <label className="block text-[10px] uppercase tracking-widest text-slate-500">
            {t('forces.gravity')} <span className="float-right font-mono text-slate-300">{gravity.toFixed(1)}</span>
            <input className="mt-2 w-full accent-cyan-400" type="range" min="0.2" max="4" step="0.2" value={gravity} onChange={(event) => setGravity(Number(event.target.value))} />
          </label>
          <label className="block text-[10px] uppercase tracking-widest text-slate-500">
            {t('forces.spacing')} <span className="float-right font-mono text-slate-300">{scalingRatio.toFixed(1)}</span>
            <input className="mt-2 w-full accent-cyan-400" type="range" min="0.5" max="8" step="0.5" value={scalingRatio} onChange={(event) => setScalingRatio(Number(event.target.value))} />
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full border-slate-700 bg-slate-900/80 text-slate-200 hover:bg-slate-800"
            onClick={() => setAppliedForces((current) => ({
              gravity,
              scalingRatio,
              version: current.version + 1,
            }))}
          >
            {t('actions.recalculate')}
          </Button>
        </ControlSection>

        {inspectedNode ? (
          <div className="border-t border-slate-700/60 bg-slate-900/55 px-4 py-4">
            <div className="flex items-start gap-3">
              {inspectedNode.kind === 'document' ? <FileText className="mt-0.5 h-4 w-4 text-cyan-400" /> : <AlertTriangle className="mt-0.5 h-4 w-4 text-rose-400" />}
              <div className="min-w-0 flex-1">
                <div className="break-words text-sm font-semibold">{inspectedNode.label}</div>
                {inspectedNode.path ? <div className="mt-1 break-all font-mono text-[10px] leading-4 text-slate-500">{inspectedNode.path}</div> : null}
                <div className="mt-3 grid grid-cols-3 gap-2 text-center font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  <span><strong className="block text-sm text-slate-200">{inspectedNode.incoming}</strong>{t('inspector.incoming')}</span>
                  <span><strong className="block text-sm text-slate-200">{inspectedNode.outgoing}</strong>{t('inspector.outgoing')}</span>
                  <span><strong className="block text-sm text-slate-200">{inspectedNode.degree}</strong>{t('inspector.total')}</span>
                </div>
                {inspectedNode.path ? (
                  <Button type="button" size="sm" className="mt-3 w-full bg-cyan-400 text-slate-950 hover:bg-cyan-300" onClick={() => openDocument(inspectedNode.path!)}>
                    <FileText className="h-4 w-4" />
                    {t('actions.open')}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </aside>

      {loading ? (
        <div className="absolute inset-0 z-30 grid place-items-center bg-[#071018]/65 backdrop-blur-sm">
          <div className="flex items-center gap-3 border border-slate-700/70 bg-slate-950/90 px-5 py-4 font-mono text-xs uppercase tracking-[0.16em] text-slate-300 shadow-2xl">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
            {t('loading')}
          </div>
        </div>
      ) : null}
      {!loading && error ? (
        <div className="absolute inset-0 z-30 grid place-items-center p-6">
          <div className="max-w-md border border-rose-400/30 bg-slate-950/95 p-6 text-center shadow-2xl">
            <AlertTriangle className="mx-auto h-6 w-6 text-rose-400" />
            <p className="mt-3 text-sm text-slate-300">{error}</p>
            <Button type="button" className="mt-4" onClick={refresh}>{t('actions.retry')}</Button>
          </div>
        </div>
      ) : null}
      {!loading && !error && index.documents.length === 0 ? (
        <div className="absolute inset-0 z-10 grid place-items-center p-6">
          <div className="max-w-lg border border-slate-700/70 bg-slate-950/85 p-8 text-center shadow-2xl backdrop-blur-xl">
            <FolderTree className="mx-auto h-8 w-8 text-cyan-400" />
            <h2 className="mt-4 text-lg font-semibold">{t('empty.title')}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{t('empty.description')}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
