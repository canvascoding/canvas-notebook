import type {
  WorkspaceLinkDocument,
  WorkspaceLinkEdge,
  WorkspaceLinkIndex,
} from '@/app/lib/markdown/workspace-link-index-core';

export type KnowledgeGraphColorMode = 'status' | 'folder' | 'tag';

export type KnowledgeGraphNode = {
  aliases: string[];
  color: string;
  degree: number;
  folder: string;
  id: string;
  incoming: number;
  kind: 'document' | 'missing' | 'ambiguous';
  label: string;
  outgoing: number;
  path: string | null;
  size: number;
  tags: string[];
  x: number;
  y: number;
};

export type KnowledgeGraphEdge = {
  color: string;
  id: string;
  source: string;
  status: WorkspaceLinkEdge['status'];
  target: string;
};

export type KnowledgeGraphData = {
  edges: KnowledgeGraphEdge[];
  nodes: KnowledgeGraphNode[];
};

export type KnowledgeGraphOptions = {
  colorMode: KnowledgeGraphColorMode;
  showBroken: boolean;
  showOrphans: boolean;
};

export function getConnectedKnowledgeGraphNodes(
  data: KnowledgeGraphData,
  nodeId: string,
): KnowledgeGraphNode[] {
  const connectedIds = new Set<string>();
  for (const edge of data.edges) {
    if (edge.source === nodeId) connectedIds.add(edge.target);
    if (edge.target === nodeId) connectedIds.add(edge.source);
  }
  return data.nodes.filter((node) => connectedIds.has(node.id));
}

const GROUP_COLORS = [
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#fb7185',
  '#a78bfa',
  '#22d3ee',
  '#f97316',
  '#84cc16',
];

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function groupColor(value: string): string {
  return GROUP_COLORS[hashString(value) % GROUP_COLORS.length];
}

function documentFolder(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/');
  return segments.length > 1 ? segments[0] : '/';
}

function documentColor(
  document: WorkspaceLinkDocument,
  degree: number,
  colorMode: KnowledgeGraphColorMode,
): string {
  if (colorMode === 'folder') return groupColor(documentFolder(document.path));
  if (colorMode === 'tag') return document.tags[0] ? groupColor(document.tags[0]) : '#94a3b8';
  return degree > 0 ? '#38bdf8' : '#94a3b8';
}

function initialPosition(id: string, index: number, count: number): { x: number; y: number } {
  const hash = hashString(id);
  const jitter = (hash % 10_000) / 10_000;
  const angle = ((index + jitter) / Math.max(1, count)) * Math.PI * 2;
  const radius = 5 + Math.sqrt(index + 1) * 1.8 + ((hash >>> 16) % 7) * 0.2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function unresolvedNodeId(edge: WorkspaceLinkEdge): string {
  return `unresolved:${edge.status}:${edge.targetText.trim().toLocaleLowerCase()}`;
}

export function buildKnowledgeGraphData(
  index: WorkspaceLinkIndex,
  options: KnowledgeGraphOptions,
): KnowledgeGraphData {
  const visibleEdges = options.showBroken
    ? index.edges
    : index.edges.filter((edge) => edge.status === 'resolved');
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of visibleEdges) {
    outgoing.set(edge.sourcePath, (outgoing.get(edge.sourcePath) ?? 0) + 1);
    if (edge.targetPath) incoming.set(edge.targetPath, (incoming.get(edge.targetPath) ?? 0) + 1);
  }

  const documentNodes = index.documents.map((document, nodeIndex) => {
    const incomingCount = incoming.get(document.path) ?? 0;
    const outgoingCount = outgoing.get(document.path) ?? 0;
    const degree = incomingCount + outgoingCount;
    const position = initialPosition(document.path, nodeIndex, index.documents.length);
    return {
      aliases: document.aliases,
      color: documentColor(document, degree, options.colorMode),
      degree,
      folder: documentFolder(document.path),
      id: document.path,
      incoming: incomingCount,
      kind: 'document' as const,
      label: document.title,
      outgoing: outgoingCount,
      path: document.path,
      size: Math.min(16, 4.5 + Math.sqrt(degree) * 2.2),
      tags: document.tags,
      ...position,
    };
  });

  const nodes = options.showOrphans
    ? documentNodes
    : documentNodes.filter((node) => node.degree > 0);
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const unresolvedNodes = new Map<string, KnowledgeGraphNode>();
  const edges: KnowledgeGraphEdge[] = [];

  for (const edge of visibleEdges) {
    if (!visibleNodeIds.has(edge.sourcePath)) continue;
    let targetId = edge.targetPath;
    if (!targetId) {
      targetId = unresolvedNodeId(edge);
      if (!unresolvedNodes.has(targetId)) {
        const position = initialPosition(targetId, nodes.length + unresolvedNodes.size, index.documents.length + index.brokenLinks.length);
        unresolvedNodes.set(targetId, {
          aliases: [],
          color: edge.status === 'ambiguous' ? '#fbbf24' : '#fb7185',
          degree: 1,
          folder: '',
          id: targetId,
          incoming: 1,
          kind: edge.status === 'ambiguous' ? 'ambiguous' : 'missing',
          label: edge.targetText,
          outgoing: 0,
          path: null,
          size: 5,
          tags: [],
          ...position,
        });
      } else {
        const unresolved = unresolvedNodes.get(targetId)!;
        unresolved.degree += 1;
        unresolved.incoming += 1;
        unresolved.size = Math.min(12, 4 + Math.sqrt(unresolved.degree) * 1.8);
      }
    }
    if (!targetId || (!visibleNodeIds.has(targetId) && !unresolvedNodes.has(targetId))) continue;
    edges.push({
      color: edge.status === 'resolved'
        ? 'rgba(100, 116, 139, 0.48)'
        : edge.status === 'ambiguous'
          ? 'rgba(251, 191, 36, 0.72)'
          : 'rgba(251, 113, 133, 0.72)',
      id: edge.id,
      source: edge.sourcePath,
      status: edge.status,
      target: targetId,
    });
  }

  return { nodes: [...nodes, ...unresolvedNodes.values()], edges };
}
