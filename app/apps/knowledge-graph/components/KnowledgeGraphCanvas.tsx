'use client';

import { LocateFixed, Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { MultiDirectedGraph } from 'graphology';
import type Sigma from 'sigma';

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

type GraphInstance = MultiDirectedGraph<KnowledgeGraphNode, { color: string; size: number }>;
type SigmaInstance = Sigma<KnowledgeGraphNode, { color: string; size: number }>;

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
  const hoveredNodeRef = useRef<string | null>(null);
  const focusedNodeRef = useRef<string | null>(focusNodeId);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let renderer: SigmaInstance | null = null;

    void Promise.all([
      import('graphology'),
      import('sigma'),
      import('graphology-layout-forceatlas2'),
    ]).then(([graphologyModule, sigmaModule, forceAtlasModule]) => {
      if (cancelled) return;
      const GraphClass = graphologyModule.MultiDirectedGraph;
      const graph = new GraphClass<KnowledgeGraphNode, { color: string; size: number }>({
        allowSelfLoops: false,
      });

      for (const node of data.nodes) graph.addNode(node.id, node);
      for (const edge of data.edges) {
        if (edge.source === edge.target || !graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
        graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
          color: edge.color,
          size: edge.status === 'resolved' ? 0.75 : 1.4,
        });
      }

      if (graph.order > 1 && graph.size > 0) {
        const forceAtlas2 = forceAtlasModule.default;
        const iterations = Math.max(28, Math.min(110, Math.round(4_000 / Math.sqrt(graph.order))));
        forceAtlas2.assign(graph, {
          iterations,
          settings: {
            ...forceAtlas2.inferSettings(graph),
            barnesHutOptimize: graph.order > 180,
            gravity,
            scalingRatio,
            slowDown: 2.5,
          },
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
        labelRenderedSizeThreshold: showLabels ? 4 : Number.POSITIVE_INFINITY,
        labelSize: 11,
        minCameraRatio: 0.03,
        maxCameraRatio: 6,
        minEdgeThickness: 0.5,
        renderLabels: showLabels,
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
      setRenderError(null);
    }).catch((error) => {
      if (!cancelled) {
        setRenderError(error instanceof Error ? error.message : t('errors.webgl'));
      }
    });

    return () => {
      cancelled = true;
      renderer?.kill();
      graphRef.current = null;
      rendererRef.current = null;
      container.replaceChildren();
    };
  }, [data, forceVersion, gravity, onNodeHover, onNodeOpen, scalingRatio, showLabels, t]);

  useEffect(() => {
    focusedNodeRef.current = focusNodeId;
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return;
    renderer.refresh({ skipIndexation: true });
    if (!focusNodeId || !graph.hasNode(focusNodeId)) return;
    const displayData = renderer.getNodeDisplayData(focusNodeId);
    if (!displayData) return;
    void renderer.getCamera().animate(
      { x: displayData.x, y: displayData.y, ratio: 0.16 },
      { duration: 520 },
    );
  }, [focusNodeId]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="knowledge-graph-webgl absolute inset-0 cursor-grab active:cursor-grabbing" />
      {renderError ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div className="max-w-md border border-destructive/30 bg-background/90 p-5 text-sm text-destructive shadow-xl backdrop-blur">
            {t('errors.webgl')}: {renderError}
          </div>
        </div>
      ) : null}
      <div className="absolute bottom-4 left-4 flex items-center gap-px overflow-hidden border border-border/70 bg-background/85 shadow-lg backdrop-blur">
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
