'use client';

import { LocateFixed, Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { AbstractGraph } from 'graphology-types';
import type ForceAtlas2LayoutSupervisor from 'graphology-layout-forceatlas2/worker';
import type Sigma from 'sigma';
import type { CameraState } from 'sigma/types';

import type {
  KnowledgeGraphData,
  KnowledgeGraphNode,
} from '@/app/apps/knowledge-graph/lib/knowledge-graph-model';
import { Button } from '@/components/ui/button';

type KnowledgeGraphCanvasProps = {
  data: KnowledgeGraphData;
  focusNodeId: string | null;
  forceVersion: number;
  gravity: number;
  onNodeOpen: (path: string) => void;
  onNodeHover: (node: KnowledgeGraphNode | null) => void;
  scalingRatio: number;
  showLabels: boolean;
};

type GraphInstance = AbstractGraph<KnowledgeGraphNode, { color: string; size: number }>;
type SigmaInstance = Sigma<KnowledgeGraphNode, { color: string; size: number }>;
type LayoutSupervisorConstructor = typeof ForceAtlas2LayoutSupervisor;
type InferForceSettings = typeof import('graphology-layout-forceatlas2').inferSettings;
type LayoutRun = {
  supervisor: ForceAtlas2LayoutSupervisor;
  timeout: number;
};

function graphTopologyKey(data: KnowledgeGraphData): string {
  let hash = 2166136261;
  const add = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  for (const node of data.nodes) add(`n:${node.id}\0`);
  for (const edge of data.edges) add(`e:${edge.id}:${edge.source}:${edge.target}\0`);
  return `${data.nodes.length}:${data.edges.length}:${hash >>> 0}`;
}

function stopLayoutRun(run: LayoutRun | null): void {
  if (!run) return;
  window.clearTimeout(run.timeout);
  run.supervisor.kill();
}

function focusRendererNode(
  renderer: SigmaInstance,
  nodeId: string | null,
  duration: number,
): void {
  if (!nodeId) return;
  const displayData = renderer.getNodeDisplayData(nodeId);
  if (!displayData) return;
  void renderer.getCamera().animate(
    { x: displayData.x, y: displayData.y, ratio: 0.16 },
    { duration },
  );
}

function startLayoutRun({
  Constructor,
  graph,
  gravity,
  inferSettings,
  onSettled,
  scalingRatio,
}: {
  Constructor: LayoutSupervisorConstructor;
  graph: GraphInstance;
  gravity: number;
  inferSettings: InferForceSettings;
  onSettled: () => void;
  scalingRatio: number;
}): LayoutRun | null {
  if (graph.order <= 1 || graph.size === 0) return null;
  const supervisor = new Constructor(graph, {
    settings: {
      ...inferSettings(graph),
      barnesHutOptimize: graph.order > 180,
      gravity,
      scalingRatio,
      slowDown: 2.5,
    },
  });
  supervisor.start();
  const duration = Math.max(700, Math.min(3_000, 600 + Math.sqrt(graph.order) * 26));
  const timeout = window.setTimeout(() => {
    supervisor.stop();
    onSettled();
  }, duration);
  return { supervisor, timeout };
}

export function KnowledgeGraphCanvas({
  data,
  focusNodeId,
  forceVersion,
  gravity,
  onNodeOpen,
  onNodeHover,
  scalingRatio,
  showLabels,
}: KnowledgeGraphCanvasProps) {
  const t = useTranslations('knowledgeGraph');
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance | null>(null);
  const rendererRef = useRef<SigmaInstance | null>(null);
  const dataRef = useRef(data);
  const activeTopologyRef = useRef<string | null>(null);
  const cameraStateRef = useRef<CameraState | null>(null);
  const layoutConstructorRef = useRef<LayoutSupervisorConstructor | null>(null);
  const inferSettingsRef = useRef<InferForceSettings | null>(null);
  const layoutRunRef = useRef<LayoutRun | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const focusedNodeRef = useRef<string | null>(focusNodeId);
  const gravityRef = useRef(gravity);
  const scalingRatioRef = useRef(scalingRatio);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendererVersion, setRendererVersion] = useState(0);
  const topologyKey = graphTopologyKey(data);

  useEffect(() => {
    dataRef.current = data;
    gravityRef.current = gravity;
    scalingRatioRef.current = scalingRatio;
  }, [data, gravity, scalingRatio]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let renderer: SigmaInstance | null = null;

    void Promise.all([
      import('graphology'),
      import('sigma'),
      import('graphology-layout-forceatlas2'),
      import('graphology-layout-forceatlas2/worker'),
    ]).then(([graphologyModule, sigmaModule, forceAtlasModule, forceAtlasWorkerModule]) => {
      if (cancelled) return;
      const currentData = dataRef.current;
      const GraphClass = graphologyModule.MultiDirectedGraph;
      const graph = new GraphClass<KnowledgeGraphNode, { color: string; size: number }>({
        allowSelfLoops: false,
      });

      for (const node of currentData.nodes) graph.addNode(node.id, node);
      for (const edge of currentData.edges) {
        if (edge.source === edge.target || !graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
        graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
          color: edge.color,
          size: edge.status === 'resolved' ? 0.75 : 1.4,
        });
      }

      const SigmaClass = sigmaModule.default;
      renderer = new SigmaClass(graph, container, {
        allowInvalidContainer: false,
        defaultEdgeColor: 'rgba(100, 116, 139, 0.45)',
        defaultNodeColor: '#38bdf8',
        hideEdgesOnMove: graph.order > 900,
        hideLabelsOnMove: graph.order > 300,
        labelColor: { color: '#94a3b8' },
        labelDensity: 0.85,
        labelFont: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        labelGridCellSize: 82,
        labelRenderedSizeThreshold: 4,
        labelSize: 11,
        minCameraRatio: 0.03,
        maxCameraRatio: 6,
        minEdgeThickness: 0.5,
        renderLabels: true,
        stagePadding: 44,
        zIndex: true,
        nodeReducer: (node, attributes) => {
          const hoveredNode = hoveredNodeRef.current;
          const focusedNode = focusedNodeRef.current;
          const activeNode = hoveredNode || focusedNode;
          if (!activeNode) return attributes;
          if (node === activeNode) {
            return { ...attributes, color: '#f8fafc', highlighted: true, zIndex: 3 };
          }
          if (graph.areNeighbors(node, activeNode)) {
            return { ...attributes, zIndex: 2 };
          }
          return { ...attributes, color: 'rgba(100, 116, 139, 0.22)', label: '', zIndex: 0 };
        },
        edgeReducer: (edge, attributes) => {
          const activeNode = hoveredNodeRef.current || focusedNodeRef.current;
          if (!activeNode) return attributes;
          const [source, target] = graph.extremities(edge);
          const connected = source === activeNode || target === activeNode;
          return connected
            ? { ...attributes, color: '#38bdf8', size: 1.8, zIndex: 2 }
            : { ...attributes, color: 'rgba(100, 116, 139, 0.08)', hidden: false, zIndex: 0 };
        },
      });

      renderer.on('enterNode', ({ node }) => {
        hoveredNodeRef.current = node;
        const attributes = graph.getNodeAttributes(node);
        onNodeHover(attributes);
        container.style.cursor = attributes.path ? 'pointer' : 'help';
        renderer?.refresh({ skipIndexation: true });
      });
      renderer.on('leaveNode', () => {
        hoveredNodeRef.current = null;
        onNodeHover(null);
        container.style.cursor = 'grab';
        renderer?.refresh({ skipIndexation: true });
      });
      renderer.on('clickNode', ({ node }) => {
        const path = graph.getNodeAttribute(node, 'path');
        if (path) onNodeOpen(path);
      });

      graphRef.current = graph;
      rendererRef.current = renderer;
      activeTopologyRef.current = topologyKey;
      layoutConstructorRef.current = forceAtlasWorkerModule.default;
      inferSettingsRef.current = forceAtlasModule.inferSettings;
      if (cameraStateRef.current) renderer.getCamera().setState(cameraStateRef.current);
      stopLayoutRun(layoutRunRef.current);
      layoutRunRef.current = startLayoutRun({
        Constructor: forceAtlasWorkerModule.default,
        graph,
        gravity: gravityRef.current,
        inferSettings: forceAtlasModule.inferSettings,
        onSettled: () => focusRendererNode(renderer!, focusedNodeRef.current, 260),
        scalingRatio: scalingRatioRef.current,
      });
      setRenderError(null);
      setRendererVersion((version) => version + 1);
    }).catch((error) => {
      if (!cancelled) {
        setRenderError(error instanceof Error ? error.message : t('errors.webgl'));
      }
    });

    return () => {
      cancelled = true;
      if (renderer) cameraStateRef.current = renderer.getCamera().getState();
      stopLayoutRun(layoutRunRef.current);
      layoutRunRef.current = null;
      renderer?.kill();
      graphRef.current = null;
      rendererRef.current = null;
      activeTopologyRef.current = null;
      container.replaceChildren();
    };
  }, [onNodeHover, onNodeOpen, t, topologyKey]);

  useEffect(() => {
    const graph = graphRef.current;
    const renderer = rendererRef.current;
    if (!graph || !renderer || activeTopologyRef.current !== topologyKey) return;
    for (const node of data.nodes) {
      if (graph.hasNode(node.id)) {
        const { x: _initialX, y: _initialY, ...attributes } = node;
        graph.mergeNodeAttributes(node.id, attributes);
      }
    }
    for (const edge of data.edges) {
      if (graph.hasEdge(edge.id)) {
        graph.mergeEdgeAttributes(edge.id, {
          color: edge.color,
          size: edge.status === 'resolved' ? 0.75 : 1.4,
        });
      }
    }
    renderer.scheduleRefresh();
  }, [data, topologyKey]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setSetting('renderLabels', showLabels);
    renderer.setSetting('labelRenderedSizeThreshold', showLabels ? 4 : Number.POSITIVE_INFINITY);
    renderer.scheduleRefresh();
  }, [rendererVersion, showLabels]);

  useEffect(() => {
    const graph = graphRef.current;
    const renderer = rendererRef.current;
    const Constructor = layoutConstructorRef.current;
    const inferSettings = inferSettingsRef.current;
    if (!graph || !renderer || !Constructor || !inferSettings || activeTopologyRef.current !== topologyKey) return;
    stopLayoutRun(layoutRunRef.current);
    layoutRunRef.current = startLayoutRun({
      Constructor,
      graph,
      gravity,
      inferSettings,
      onSettled: () => focusRendererNode(renderer, focusedNodeRef.current, 260),
      scalingRatio,
    });
  }, [forceVersion, gravity, scalingRatio, topologyKey]);

  useEffect(() => {
    focusedNodeRef.current = focusNodeId;
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return;
    renderer.refresh({ skipIndexation: true });
    focusRendererNode(renderer, focusNodeId, 520);
  }, [focusNodeId, rendererVersion]);

  return (
    <div className="absolute inset-0">
      <div
        ref={containerRef}
        aria-hidden="true"
        className="knowledge-graph-webgl absolute inset-0 cursor-grab active:cursor-grabbing"
      />
      {renderError ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div className="max-w-md border border-destructive/30 bg-background/90 p-5 text-sm text-destructive shadow-xl backdrop-blur">
            {t('errors.webgl')}: {renderError}
          </div>
        </div>
      ) : null}
      <div className="absolute bottom-6 left-6 hidden items-center gap-px overflow-hidden border border-border/70 bg-background/85 shadow-lg backdrop-blur md:flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-none"
          aria-label={t('actions.zoomIn')}
          onClick={() => void rendererRef.current?.getCamera().animatedZoom({ duration: 240 })}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-none border-x border-border/60"
          aria-label={t('actions.zoomOut')}
          onClick={() => void rendererRef.current?.getCamera().animatedUnzoom({ duration: 240 })}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-none"
          aria-label={t('actions.resetView')}
          onClick={() => void rendererRef.current?.getCamera().animatedReset({ duration: 320 })}
        >
          <LocateFixed className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
