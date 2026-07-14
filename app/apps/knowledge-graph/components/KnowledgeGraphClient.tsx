'use client';

import {
  AlertTriangle,
  Check,
  ExternalLink,
  FileText,
  Filter,
  FolderTree,
  Keyboard,
  Layers3,
  Link2,
  Loader2,
  Network,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { KnowledgeGraphCanvas } from './KnowledgeGraphCanvas';
import {
  buildKnowledgeGraphData,
  getConnectedKnowledgeGraphNodes,
  getKnowledgeGraphFacets,
  type KnowledgeGraphColorMode,
  type KnowledgeGraphFacet,
  type KnowledgeGraphNode,
} from '@/app/apps/knowledge-graph/lib/knowledge-graph-model';
import { loadWorkspaceLinkIndex } from '@/app/lib/markdown/workspace-link-index-client';
import type { WorkspaceLinkIndex } from '@/app/lib/markdown/workspace-link-index-core';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { getPathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

const EMPTY_INDEX: WorkspaceLinkIndex = {
  backlinks: {},
  brokenLinks: [],
  documents: [],
  edges: [],
  generatedAt: new Date(0).toISOString(),
  omittedDocuments: [],
};
const EMPTY_SELECTION: readonly string[] = [];

type IndexRequestState = {
  error: string | null;
  index: WorkspaceLinkIndex | null;
  refreshVersion: number;
  workspaceId: string;
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
        <Icon aria-hidden="true" className="h-4 w-4 text-cyan-500" />
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
      <Switch aria-label={label} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

function FacetPicker({
  facets,
  kind,
  onToggle,
  selected,
}: {
  facets: KnowledgeGraphFacet[];
  kind: 'folder' | 'tag';
  onToggle: (value: string) => void;
  selected: readonly string[];
}) {
  const t = useTranslations('knowledgeGraph');
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleFacets = facets
    .filter((facet) => !normalizedQuery || facet.value.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, 60);

  return (
    <div className="rounded-xl border border-slate-700/70 bg-slate-900/45 p-2">
      <div className="mb-2 flex items-center gap-2 px-1">
        {kind === 'folder' ? <FolderTree className="h-3.5 w-3.5 text-cyan-400" /> : <Tag className="h-3.5 w-3.5 text-cyan-400" />}
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
          {t(`filters.${kind}Title`)}
        </span>
        {selected.length > 0 ? (
          <span className="ml-auto rounded-full bg-cyan-400 px-1.5 py-0.5 font-mono text-[9px] text-slate-950">
            {selected.length}
          </span>
        ) : null}
      </div>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={t(`filters.${kind}SearchLabel`)}
        placeholder={t(`filters.${kind}SearchPlaceholder`)}
        className="h-8 rounded-lg border-slate-700 bg-slate-950/70 px-2 text-xs text-slate-100 placeholder:text-slate-600"
      />
      <div className="mt-2 max-h-44 space-y-1 overflow-y-auto overscroll-contain pr-1">
        {visibleFacets.map((facet) => {
          const active = selected.includes(facet.value);
          const label = kind === 'folder' && facet.value === '/' ? t('filters.rootFolder') : facet.value;
          return (
            <button
              key={facet.value}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(facet.value)}
              className={cn(
                'flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
                active ? 'bg-cyan-400/15 text-cyan-100' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
              )}
            >
              <span className={cn(
                'grid h-4 w-4 shrink-0 place-items-center rounded border',
                active ? 'border-cyan-300 bg-cyan-300 text-slate-950' : 'border-slate-600',
              )}>
                {active ? <Check className="h-3 w-3" /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{kind === 'tag' ? `#${label}` : label}</span>
              <span className="font-mono text-[10px] text-slate-500">{facet.count}</span>
            </button>
          );
        })}
        {visibleFacets.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-slate-500">{t('filters.noFacets')}</p>
        ) : null}
      </div>
      {facets.length > visibleFacets.length ? (
        <p className="mt-1 px-2 text-[10px] text-slate-600">
          {t('filters.moreFacets', { count: facets.length - visibleFacets.length })}
        </p>
      ) : null}
    </div>
  );
}

type GraphControlsProps = {
  colorMode: KnowledgeGraphColorMode;
  folderFacets: KnowledgeGraphFacet[];
  gravity: number;
  idPrefix: string;
  navigableNodes: KnowledgeGraphNode[];
  onApplyForces: () => void;
  onColorModeChange: (mode: KnowledgeGraphColorMode) => void;
  onClearFacets: () => void;
  onFolderToggle: (folder: string) => void;
  onFocusNode: (nodeId: string | null) => void;
  onGravityChange: (value: number) => void;
  onScalingRatioChange: (value: number) => void;
  onShowBrokenChange: (checked: boolean) => void;
  onShowLabelsChange: (checked: boolean) => void;
  onShowOrphansChange: (checked: boolean) => void;
  onTagToggle: (tag: string) => void;
  scalingRatio: number;
  selectedFolders: readonly string[];
  selectedNodeId: string;
  selectedTags: readonly string[];
  showBroken: boolean;
  showLabels: boolean;
  showOrphans: boolean;
  tagFacets: KnowledgeGraphFacet[];
};

function GraphControls({
  colorMode,
  folderFacets,
  gravity,
  idPrefix,
  navigableNodes,
  onApplyForces,
  onColorModeChange,
  onClearFacets,
  onFolderToggle,
  onFocusNode,
  onGravityChange,
  onScalingRatioChange,
  onShowBrokenChange,
  onShowLabelsChange,
  onShowOrphansChange,
  onTagToggle,
  scalingRatio,
  selectedFolders,
  selectedNodeId,
  selectedTags,
  showBroken,
  showLabels,
  showOrphans,
  tagFacets,
}: GraphControlsProps) {
  const t = useTranslations('knowledgeGraph');
  const navigatorId = `${idPrefix}-knowledge-graph-node-navigator`;
  const navigatorDescriptionId = `${navigatorId}-description`;

  return (
    <>
      <ControlSection icon={Filter} title={t('controls.filters')} open>
        <ToggleRow checked={showOrphans} label={t('filters.orphans')} onCheckedChange={onShowOrphansChange} />
        <ToggleRow checked={showBroken} label={t('filters.broken')} onCheckedChange={onShowBrokenChange} />
        <FacetPicker facets={folderFacets} kind="folder" selected={selectedFolders} onToggle={onFolderToggle} />
        <FacetPicker facets={tagFacets} kind="tag" selected={selectedTags} onToggle={onTagToggle} />
        {selectedFolders.length > 0 || selectedTags.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full rounded-xl text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            onClick={onClearFacets}
          >
            <X className="h-3.5 w-3.5" />
            {t('filters.clear')}
          </Button>
        ) : null}
      </ControlSection>

      <ControlSection icon={Keyboard} title={t('controls.navigation')}>
        <p id={navigatorDescriptionId} className="text-xs leading-5 text-slate-400">
          {t('navigation.description')}
        </p>
        <label htmlFor={navigatorId} className="block text-[10px] uppercase tracking-widest text-slate-500">
          {t('navigation.label')}
        </label>
        <select
          id={navigatorId}
          aria-describedby={navigatorDescriptionId}
          value={selectedNodeId}
          onChange={(event) => onFocusNode(event.target.value || null)}
          className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 outline-none focus-visible:border-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-400/30"
        >
          <option value="">{t('navigation.placeholder')}</option>
          {navigableNodes.map((node) => (
            <option key={node.id} value={node.id}>{node.label}</option>
          ))}
        </select>
      </ControlSection>

      <ControlSection icon={Layers3} title={t('controls.groups')}>
        <div className="grid grid-cols-3 gap-1 rounded-xl border border-slate-700/70 bg-slate-900/60 p-1">
          {(['status', 'folder', 'tag'] as const).map((mode) => {
            const Icon = mode === 'status' ? Sparkles : mode === 'folder' ? FolderTree : Tag;
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={colorMode === mode}
                onClick={() => onColorModeChange(mode)}
                className={cn(
                  'flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-[10px] transition-colors',
                  colorMode === mode ? 'bg-cyan-400 text-slate-950' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
                )}
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                {t(`groups.${mode}`)}
              </button>
            );
          })}
        </div>
      </ControlSection>

      <ControlSection icon={Settings2} title={t('controls.display')}>
        <ToggleRow checked={showLabels} label={t('display.labels')} onCheckedChange={onShowLabelsChange} />
        <div className="grid grid-cols-3 gap-2 pt-1 text-[10px] text-slate-400">
          <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-cyan-400" />{t('legend.document')}</span>
          <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-amber-400" />{t('legend.ambiguous')}</span>
          <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-rose-400" />{t('legend.missing')}</span>
        </div>
      </ControlSection>

      <ControlSection icon={Link2} title={t('controls.forces')}>
        <label className="block text-[10px] uppercase tracking-widest text-slate-500">
          {t('forces.gravity')} <span className="float-right font-mono text-slate-300">{gravity.toFixed(1)}</span>
          <input className="mt-2 h-8 w-full accent-cyan-400" type="range" min="0.2" max="4" step="0.2" value={gravity} onChange={(event) => onGravityChange(Number(event.target.value))} />
        </label>
        <label className="block text-[10px] uppercase tracking-widest text-slate-500">
          {t('forces.spacing')} <span className="float-right font-mono text-slate-300">{scalingRatio.toFixed(1)}</span>
          <input className="mt-2 h-8 w-full accent-cyan-400" type="range" min="0.5" max="8" step="0.5" value={scalingRatio} onChange={(event) => onScalingRatioChange(Number(event.target.value))} />
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full rounded-xl border-slate-700 bg-slate-900/80 text-slate-200 hover:bg-slate-800"
          onClick={onApplyForces}
        >
          {t('actions.recalculate')}
        </Button>
      </ControlSection>
    </>
  );
}

function NodeInspectorCard({
  className,
  connectedNodes,
  node,
  onClose,
  onFolderSelect,
  onNodeSelect,
  onOpenDocument,
  onTagSelect,
}: {
  className?: string;
  connectedNodes: KnowledgeGraphNode[];
  node: KnowledgeGraphNode;
  onClose: () => void;
  onFolderSelect: (folder: string) => void;
  onNodeSelect: (node: KnowledgeGraphNode) => void;
  onOpenDocument: (path: string) => void;
  onTagSelect: (tag: string) => void;
}) {
  const t = useTranslations('knowledgeGraph');
  const visibleConnections = connectedNodes.slice(0, 12);
  const hiddenConnectionCount = connectedNodes.length - visibleConnections.length;

  return (
    <section
      aria-label={t('inspector.detailsFor', { title: node.label })}
      aria-live="polite"
      className={cn(
        'overflow-y-auto overscroll-contain border border-cyan-300/25 bg-[linear-gradient(145deg,rgba(8,20,31,.98),rgba(2,8,23,.97))] text-slate-100 shadow-[0_-24px_80px_-28px_rgba(0,0,0,.95),0_0_0_1px_rgba(34,211,238,.08)] backdrop-blur-2xl',
        className,
      )}
    >
      <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-slate-700/60 bg-slate-950/86 px-5 py-4 backdrop-blur-xl">
        <div className={cn(
          'mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border',
          node.kind === 'document'
            ? 'border-cyan-300/30 bg-cyan-400/10 text-cyan-300'
            : node.kind === 'ambiguous'
              ? 'border-amber-300/30 bg-amber-400/10 text-amber-300'
              : 'border-rose-300/30 bg-rose-400/10 text-rose-300',
        )}>
          {node.kind === 'document' ? <FileText aria-hidden="true" className="h-4 w-4" /> : <AlertTriangle aria-hidden="true" className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-cyan-400">{t(`nodeTypes.${node.kind}`)}</div>
          <h2 className="mt-1 break-words text-base font-semibold leading-5 tracking-tight">{node.label}</h2>
          {node.path ? <p className="mt-1 truncate font-mono text-[10px] text-slate-500">{node.path}</p> : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-full text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label={t('actions.closeDetails')}
          onClick={onClose}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-4 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="grid grid-cols-3 gap-2">
          {([
            [node.incoming, t('inspector.incoming')],
            [node.outgoing, t('inspector.outgoing')],
            [node.degree, t('inspector.total')],
          ] as const).map(([value, label]) => (
            <div key={label} className="rounded-xl border border-slate-700/70 bg-slate-900/60 px-2 py-2 text-center">
              <strong className="block font-mono text-base text-slate-100">{value}</strong>
              <span className="font-mono text-[9px] uppercase tracking-wider text-slate-500">{label}</span>
            </div>
          ))}
        </div>

        {node.folder || node.tags.length > 0 || node.aliases.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {node.folder ? (
              <button
                type="button"
                onClick={() => onFolderSelect(node.folder)}
                className="inline-flex items-center gap-1 rounded-full border border-violet-400/20 bg-violet-400/8 px-2 py-1 text-[10px] text-violet-200 hover:border-violet-300/50 hover:bg-violet-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
              >
                <FolderTree className="h-3 w-3" />
                {node.folder === '/' ? t('filters.rootFolder') : node.folder}
              </button>
            ) : null}
            {node.tags.slice(0, 5).map((tag) => (
              <button
                key={`tag:${tag}`}
                type="button"
                onClick={() => onTagSelect(tag)}
                className="rounded-full border border-cyan-400/20 bg-cyan-400/8 px-2 py-1 text-[10px] text-cyan-200 hover:border-cyan-300/50 hover:bg-cyan-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                #{tag}
              </button>
            ))}
            {node.aliases.slice(0, 4).map((alias) => (
              <span key={`alias:${alias}`} className="rounded-full border border-slate-700 bg-slate-900/70 px-2 py-1 text-[10px] text-slate-400">{alias}</span>
            ))}
          </div>
        ) : null}

        <div>
          <div className="mb-2 flex items-center gap-2">
            <Network aria-hidden="true" className="h-3.5 w-3.5 text-cyan-400" />
            <h3 className="text-xs font-semibold text-slate-200">{t('inspector.connected', { count: connectedNodes.length })}</h3>
          </div>
          {visibleConnections.length > 0 ? (
            <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
              {visibleConnections.map((connectedNode) => (
                <button
                  key={connectedNode.id}
                  type="button"
                  onClick={() => onNodeSelect(connectedNode)}
                  className="flex max-w-full items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1.5 text-left text-[10px] text-slate-300 transition hover:border-cyan-400/50 hover:bg-cyan-400/10 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                >
                  <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: connectedNode.color }} />
                  <span className="truncate">{connectedNode.label}</span>
                </button>
              ))}
              {hiddenConnectionCount > 0 ? (
                <span className="rounded-full border border-slate-700 px-2.5 py-1.5 text-[10px] text-slate-500">
                  {t('inspector.moreConnections', { count: hiddenConnectionCount })}
                </span>
              ) : null}
            </div>
          ) : (
            <p className="text-xs leading-5 text-slate-500">{t('inspector.noConnections')}</p>
          )}
        </div>

        {node.path ? (
          <Button
            type="button"
            size="sm"
            className="h-11 w-full rounded-xl bg-cyan-300 font-semibold text-slate-950 shadow-[0_10px_30px_-12px_rgba(34,211,238,.8)] hover:bg-cyan-200"
            onClick={() => onOpenDocument(node.path!)}
          >
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
            {t('actions.openInNewTab')}
          </Button>
        ) : (
          <p className="rounded-xl border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs leading-5 text-rose-200">
            {t('inspector.unresolved')}
          </p>
        )}
      </div>
    </section>
  );
}

export function KnowledgeGraphClient() {
  const t = useTranslations('knowledgeGraph');
  const locale = useLocale();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [requestState, setRequestState] = useState<IndexRequestState | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusWorkspaceId, setFocusWorkspaceId] = useState<string | null>(null);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [showOrphans, setShowOrphans] = useState(true);
  const [showBroken, setShowBroken] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [colorMode, setColorMode] = useState<KnowledgeGraphColorMode>('status');
  const [folderSelection, setFolderSelection] = useState<{ values: string[]; workspaceId: string | null }>({
    values: [],
    workspaceId: null,
  });
  const [tagSelection, setTagSelection] = useState<{ values: string[]; workspaceId: string | null }>({
    values: [],
    workspaceId: null,
  });
  const [gravity, setGravity] = useState(1);
  const [scalingRatio, setScalingRatio] = useState(2);
  const [appliedForces, setAppliedForces] = useState({
    gravity: 1,
    scalingRatio: 2,
    version: 0,
  });

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    const workspaceId = activeWorkspaceId;
    const requestedRefreshVersion = refreshVersion;
    void loadWorkspaceLinkIndex(workspaceId, { force: requestedRefreshVersion > 0 }).then((nextIndex) => {
      if (cancelled) return;
      setRequestState({
        error: null,
        index: nextIndex,
        refreshVersion: requestedRefreshVersion,
        workspaceId,
      });
    }).catch((fetchError) => {
      if (cancelled) return;
      setRequestState({
        error: fetchError instanceof Error ? fetchError.message : t('errors.load'),
        index: null,
        refreshVersion: requestedRefreshVersion,
        workspaceId,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, refreshVersion, t]);

  const requestIsCurrent = Boolean(
    activeWorkspaceId
    && requestState?.workspaceId === activeWorkspaceId
    && requestState.refreshVersion === refreshVersion
  );
  const index = requestIsCurrent && requestState?.index ? requestState.index : EMPTY_INDEX;
  const error = requestIsCurrent ? requestState?.error ?? null : null;
  const loading = Boolean(activeWorkspaceId && !requestIsCurrent);
  const facets = useMemo(() => getKnowledgeGraphFacets(index), [index]);
  const selectedFolders = folderSelection.workspaceId === activeWorkspaceId
    ? folderSelection.values
    : EMPTY_SELECTION;
  const selectedTags = tagSelection.workspaceId === activeWorkspaceId
    ? tagSelection.values
    : EMPTY_SELECTION;

  const graphData = useMemo(() => buildKnowledgeGraphData(index, {
    colorMode,
    selectedFolders,
    selectedTags,
    showBroken,
    showOrphans,
  }), [colorMode, index, selectedFolders, selectedTags, showBroken, showOrphans]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return graphData.nodes
      .filter((node) => node.kind === 'document' && (
        node.label.toLocaleLowerCase().includes(normalized)
        || node.path?.toLocaleLowerCase().includes(normalized)
        || node.folder.toLocaleLowerCase().includes(normalized)
        || node.tags.some((tag) => tag.toLocaleLowerCase().includes(normalized))
        || node.aliases.some((alias) => alias.toLocaleLowerCase().includes(normalized))
      ))
      .sort((left, right) => {
        const leftStarts = left.label.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
        const rightStarts = right.label.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
        return leftStarts - rightStarts || left.label.localeCompare(right.label);
      })
      .slice(0, 7);
  }, [graphData.nodes, query]);

  const navigableNodes = useMemo(() => (
    [...graphData.nodes]
      .sort((left, right) => left.label.localeCompare(right.label, locale))
  ), [graphData.nodes, locale]);

  const scopedFocusNodeId = focusWorkspaceId === activeWorkspaceId ? focusNodeId : null;
  const focusedNode = useMemo(() => (
    graphData.nodes.find((node) => node.id === scopedFocusNodeId) ?? null
  ), [graphData.nodes, scopedFocusNodeId]);
  const activeFocusNodeId = focusedNode?.id ?? null;
  const selectedNavigatorNodeId = focusedNode?.id ?? '';

  const connectedNodes = useMemo(() => {
    if (!focusedNode) return [];
    return getConnectedKnowledgeGraphNodes(graphData, focusedNode.id)
      .sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label, locale));
  }, [focusedNode, graphData, locale]);

  const openDocument = useCallback((path: string) => {
    const notebookHref = getPathname({
      locale,
      href: { pathname: '/notebook', query: { path } },
    });
    window.open(notebookHref, '_blank', 'noopener,noreferrer');
  }, [locale]);
  const handleNodeSelect = useCallback((node: KnowledgeGraphNode) => {
    setFocusNodeId(node.id);
    setFocusWorkspaceId(activeWorkspaceId);
    setQuery('');
    setMobileControlsOpen(false);
  }, [activeWorkspaceId]);
  const clearNodeSelection = useCallback(() => {
    setFocusNodeId(null);
    setFocusWorkspaceId(null);
  }, []);
  const focusNodeById = useCallback((nodeId: string | null) => {
    setFocusNodeId(nodeId);
    setFocusWorkspaceId(nodeId ? activeWorkspaceId : null);
    if (nodeId) setQuery('');
  }, [activeWorkspaceId]);
  const focusSearchResult = (node: KnowledgeGraphNode) => {
    handleNodeSelect(node);
  };
  const refresh = () => {
    setRefreshVersion((version) => version + 1);
  };
  const toggleFolder = useCallback((folder: string) => {
    setFolderSelection((current) => {
      const values = current.workspaceId === activeWorkspaceId ? current.values : [];
      return {
        values: values.includes(folder) ? values.filter((value) => value !== folder) : [...values, folder],
        workspaceId: activeWorkspaceId,
      };
    });
  }, [activeWorkspaceId]);
  const toggleTag = useCallback((tag: string) => {
    setTagSelection((current) => {
      const values = current.workspaceId === activeWorkspaceId ? current.values : [];
      return {
        values: values.includes(tag) ? values.filter((value) => value !== tag) : [...values, tag],
        workspaceId: activeWorkspaceId,
      };
    });
  }, [activeWorkspaceId]);
  const clearFacets = useCallback(() => {
    setFolderSelection({ values: [], workspaceId: activeWorkspaceId });
    setTagSelection({ values: [], workspaceId: activeWorkspaceId });
  }, [activeWorkspaceId]);
  const activeFacetCount = selectedFolders.length + selectedTags.length;

  const stats = {
    documents: index.documents.length,
    links: index.edges.length,
    broken: index.brokenLinks.length,
  };
  const applyForces = () => setAppliedForces((current) => ({
    gravity,
    scalingRatio,
    version: current.version + 1,
  }));

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[#071018] text-slate-100">
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
          focusNodeId={activeFocusNodeId}
          forceVersion={appliedForces.version}
          gravity={appliedForces.gravity}
          onSelectionClear={clearNodeSelection}
          onNodeSelect={handleNodeSelect}
          scalingRatio={appliedForces.scalingRatio}
          showLabels={showLabels}
        />
      ) : null}

      <div className="absolute inset-x-3 top-3 z-40 md:inset-x-auto md:left-6 md:top-6 md:w-[390px]">
        <div className="overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-950/82 shadow-[0_18px_60px_-24px_rgba(0,0,0,.9)] backdrop-blur-xl md:rounded-xl">
          <div className="flex items-center gap-2 border-b border-slate-700/60 px-3 py-2.5">
            <Search className="h-4 w-4 text-cyan-400" />
            <Input
              aria-controls={query.trim() ? 'knowledge-graph-search-results' : undefined}
              aria-label={t('search.label')}
              role="searchbox"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || searchResults.length === 0) return;
                event.preventDefault();
                focusSearchResult(searchResults[0]);
              }}
              placeholder={t('search.placeholder')}
              className="h-9 min-w-0 border-0 bg-transparent px-1 text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:ring-0"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="rounded-full text-slate-400 hover:bg-slate-800 hover:text-cyan-200 md:hidden"
              onClick={() => setMobileControlsOpen(true)}
              aria-label={t('actions.openControls')}
            >
              <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="rounded-full text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              onClick={refresh}
              disabled={!activeWorkspaceId || loading}
              aria-label={t('actions.refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>
          <div className="flex items-center gap-3 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-400">
            <span><strong className="text-cyan-300">{stats.documents}</strong> {t('stats.documents')}</span>
            <span><strong className="text-slate-200">{stats.links}</strong> {t('stats.links')}</span>
            <span><strong className={cn(stats.broken > 0 ? 'text-rose-400' : 'text-emerald-400')}>{stats.broken}</strong> {t('stats.broken')}</span>
            {activeFacetCount > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setMobileControlsOpen(true)}
                  className="ml-auto rounded-full bg-cyan-400/15 px-2 py-1 text-cyan-200 hover:bg-cyan-400/25 md:hidden"
                >
                  {t('filters.active', { count: activeFacetCount })}
                </button>
                <span className="ml-auto hidden rounded-full bg-cyan-400/15 px-2 py-1 text-cyan-200 md:inline">
                  {t('filters.active', { count: activeFacetCount })}
                </span>
              </>
            ) : null}
          </div>
          {!loading && !error && index.omittedDocuments.length > 0 ? (
            <div className="flex items-start gap-2 border-t border-amber-400/20 px-3 py-2 text-xs text-amber-200">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('warnings.omitted', { count: index.omittedDocuments.length })}</span>
            </div>
          ) : null}
        </div>

        {query.trim() ? (
          searchResults.length > 0 ? (
            <div
              id="knowledge-graph-search-results"
              aria-live="polite"
              className="mt-1 max-h-[25dvh] overflow-y-auto rounded-2xl border border-slate-700/70 bg-slate-950/94 p-1 shadow-2xl backdrop-blur-xl [@media(min-height:640px)]:max-h-72 md:rounded-xl"
            >
              {searchResults.map((node) => (
                <div key={node.id} className="group flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-slate-800/80">
                  <button
                    type="button"
                    aria-current={activeFocusNodeId === node.id ? 'true' : undefined}
                    className="min-w-0 flex-1 text-left"
                    onClick={() => focusSearchResult(node)}
                  >
                    <span className="block truncate text-xs font-semibold text-slate-100">{node.label}</span>
                    <span className="block truncate font-mono text-[10px] text-slate-500">{node.path}</span>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div
              id="knowledge-graph-search-results"
              aria-live="polite"
              className="mt-1 rounded-2xl border border-slate-700/70 bg-slate-950/94 px-3 py-2 text-xs text-slate-400 shadow-2xl backdrop-blur-xl md:rounded-xl"
            >
              {t('search.noResults')}
            </div>
          )
        ) : null}
      </div>

      <aside className={cn(
        'absolute right-6 top-6 z-20 hidden w-80 overflow-y-auto overscroll-contain rounded-2xl border border-slate-700/70 bg-slate-950/82 text-slate-100 shadow-[0_24px_80px_-28px_rgba(0,0,0,.95)] backdrop-blur-xl md:block',
        focusedNode ? 'bottom-[min(340px,52vh)]' : 'bottom-6',
      )}>
        <div className="border-b border-slate-700/60 px-4 py-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">{t('eyebrow')}</div>
          <h2 className="mt-1 text-base font-semibold tracking-tight">{t('controls.title')}</h2>
        </div>
        <GraphControls
          colorMode={colorMode}
          folderFacets={facets.folders}
          gravity={gravity}
          idPrefix="desktop"
          navigableNodes={navigableNodes}
          onApplyForces={applyForces}
          onColorModeChange={setColorMode}
          onClearFacets={clearFacets}
          onFolderToggle={toggleFolder}
          onFocusNode={focusNodeById}
          onGravityChange={setGravity}
          onScalingRatioChange={setScalingRatio}
          onShowBrokenChange={setShowBroken}
          onShowLabelsChange={setShowLabels}
          onShowOrphansChange={setShowOrphans}
          onTagToggle={toggleTag}
          scalingRatio={scalingRatio}
          selectedFolders={selectedFolders}
          selectedNodeId={selectedNavigatorNodeId}
          selectedTags={selectedTags}
          showBroken={showBroken}
          showLabels={showLabels}
          showOrphans={showOrphans}
          tagFacets={facets.tags}
        />
      </aside>

      {focusedNode ? (
        <NodeInspectorCard
          key={focusedNode.id}
          node={focusedNode}
          connectedNodes={connectedNodes}
          onClose={clearNodeSelection}
          onFolderSelect={toggleFolder}
          onNodeSelect={handleNodeSelect}
          onOpenDocument={openDocument}
          onTagSelect={toggleTag}
          className="absolute inset-x-0 bottom-0 z-30 max-h-[46dvh] animate-in rounded-t-[28px] border-x-0 border-b-0 slide-in-from-bottom-8 duration-300 motion-reduce:animate-none [@media(max-height:480px)]:max-h-[40dvh] md:inset-x-auto md:bottom-6 md:right-6 md:max-h-[min(300px,48vh)] md:w-[360px] md:rounded-2xl md:border"
        />
      ) : null}

      <Sheet open={mobileControlsOpen} onOpenChange={setMobileControlsOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[82dvh] gap-0 overflow-y-auto rounded-t-[28px] border-slate-700 bg-[#071018] p-0 text-slate-100 md:hidden"
        >
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-slate-600" />
          <SheetHeader className="sticky top-0 z-10 border-b border-slate-700/60 bg-[#071018]/94 px-5 py-4 text-left backdrop-blur-xl">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-slate-100">{t('controls.title')}</SheetTitle>
                <SheetDescription className="mt-1 text-xs leading-5 text-slate-400">{t('controls.mobileDescription')}</SheetDescription>
              </div>
              <SheetClose asChild>
                <Button type="button" variant="ghost" size="icon-sm" className="rounded-full text-slate-400 hover:bg-slate-800 hover:text-slate-100">
                  <X aria-hidden="true" className="h-4 w-4" />
                  <span className="sr-only">{t('actions.closeControls')}</span>
                </Button>
              </SheetClose>
            </div>
          </SheetHeader>
          <GraphControls
            colorMode={colorMode}
            folderFacets={facets.folders}
            gravity={gravity}
            idPrefix="mobile"
            navigableNodes={navigableNodes}
            onApplyForces={applyForces}
            onColorModeChange={setColorMode}
            onClearFacets={clearFacets}
            onFolderToggle={toggleFolder}
            onFocusNode={(nodeId) => {
              focusNodeById(nodeId);
              if (nodeId) {
                setMobileControlsOpen(false);
              }
            }}
            onGravityChange={setGravity}
            onScalingRatioChange={setScalingRatio}
            onShowBrokenChange={setShowBroken}
            onShowLabelsChange={setShowLabels}
            onShowOrphansChange={setShowOrphans}
            onTagToggle={toggleTag}
            scalingRatio={scalingRatio}
            selectedFolders={selectedFolders}
            selectedNodeId={selectedNavigatorNodeId}
            selectedTags={selectedTags}
            showBroken={showBroken}
            showLabels={showLabels}
            showOrphans={showOrphans}
            tagFacets={facets.tags}
          />
          <div className="h-[max(1rem,env(safe-area-inset-bottom))] shrink-0" />
        </SheetContent>
      </Sheet>

      {loading ? (
        <div className="absolute inset-0 z-50 grid place-items-center bg-[#071018]/65 backdrop-blur-sm">
          <div className="flex items-center gap-3 border border-slate-700/70 bg-slate-950/90 px-5 py-4 font-mono text-xs uppercase tracking-[0.16em] text-slate-300 shadow-2xl">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
            {t('loading')}
          </div>
        </div>
      ) : null}
      {!loading && error ? (
        <div className="absolute inset-0 z-50 grid place-items-center p-6">
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
      {!activeWorkspaceId ? (
        <div className="absolute inset-0 z-50 grid place-items-center p-6">
          <div className="max-w-lg border border-slate-700/70 bg-slate-950/90 p-8 text-center shadow-2xl">
            <FolderTree className="mx-auto h-8 w-8 text-cyan-400" />
            <h2 className="mt-4 text-lg font-semibold">{t('noWorkspace.title')}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{t('noWorkspace.description')}</p>
          </div>
        </div>
      ) : null}
      {!loading && !error && index.documents.length > 0 && graphData.nodes.length === 0 ? (
        <div className="absolute inset-0 z-10 grid place-items-center p-6">
          <div className="max-w-lg border border-slate-700/70 bg-slate-950/85 p-8 text-center shadow-2xl backdrop-blur-xl">
            <Filter className="mx-auto h-8 w-8 text-cyan-400" />
            <h2 className="mt-4 text-lg font-semibold">{t('filtered.title')}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{t('filtered.description')}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
