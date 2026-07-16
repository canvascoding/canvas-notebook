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
  group: string;
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

export type KnowledgeGraphFacet = {
  count: number;
  value: string;
};

export type KnowledgeGraphFacets = {
  folders: KnowledgeGraphFacet[];
  tags: KnowledgeGraphFacet[];
};

export type KnowledgeGraphSearchMatchKind = 'alias' | 'folder' | 'path' | 'tag' | 'title';

export type KnowledgeGraphSearchResult = {
  document: WorkspaceLinkDocument;
  matchKind: KnowledgeGraphSearchMatchKind;
  matchValue: string;
};

export type KnowledgeGraphOptions = {
  colorMode: KnowledgeGraphColorMode;
  selectedFolders?: readonly string[];
  selectedTags?: readonly string[];
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
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : '/';
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ß/gu, 'ss')
    .toLocaleLowerCase()
    .replace(/[\\/_.-]+/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

type SearchField = {
  kind: KnowledgeGraphSearchMatchKind;
  normalized: string;
  priority: number;
  value: string;
};

function getDocumentSearchFields(document: WorkspaceLinkDocument): SearchField[] {
  const fileName = document.path.replace(/\\/g, '/').split('/').pop() ?? document.path;
  const basename = fileName.replace(/\.md$/iu, '');
  const folder = documentFolder(document.path);
  const fields: Array<Omit<SearchField, 'normalized'>> = [
    { kind: 'title', priority: 0, value: document.title },
    ...document.aliases.map((value) => ({ kind: 'alias' as const, priority: 1, value })),
    { kind: 'path', priority: 2, value: basename },
    ...document.tags.map((value) => ({ kind: 'tag' as const, priority: 3, value })),
    { kind: 'folder', priority: 4, value: folder },
    { kind: 'path', priority: 5, value: document.path },
  ];
  return fields
    .map((field) => ({ ...field, normalized: normalizeSearchText(field.value) }))
    .filter((field) => field.normalized.length > 0);
}

export function searchKnowledgeGraphDocuments(
  documents: readonly WorkspaceLinkDocument[],
  query: string,
  limit = 10,
): KnowledgeGraphSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || limit <= 0) return [];
  const tokens = [...new Set(normalizedQuery.split(' '))];

  return documents
    .map((document) => {
      const fields = getDocumentSearchFields(document);
      if (!tokens.every((token) => fields.some((field) => field.normalized.includes(token)))) return null;

      const directMatches = fields
        .filter((field) => field.normalized.includes(normalizedQuery))
        .map((field) => ({
          field,
          score: field.priority * 4
            + (field.normalized === normalizedQuery ? 0 : field.normalized.startsWith(normalizedQuery) ? 10 : 20),
        }))
        .sort((left, right) => left.score - right.score);

      if (directMatches.length > 0) {
        return {
          document,
          matchKind: directMatches[0].field.kind,
          matchValue: directMatches[0].field.value,
          score: directMatches[0].score,
        };
      }

      const rankedFields = fields
        .map((field) => ({
          field,
          tokenCount: tokens.filter((token) => field.normalized.includes(token)).length,
        }))
        .filter((entry) => entry.tokenCount > 0)
        .sort((left, right) => (
          right.tokenCount - left.tokenCount || left.field.priority - right.field.priority
        ));
      const tokenScore = tokens.reduce((score, token) => {
        const bestField = fields
          .filter((field) => field.normalized.includes(token))
          .sort((left, right) => left.priority - right.priority)[0];
        return score + (bestField?.priority ?? 10);
      }, 0);

      return {
        document,
        matchKind: rankedFields[0].field.kind,
        matchValue: rankedFields[0].field.value,
        score: 100 + tokenScore,
      };
    })
    .filter((result): result is KnowledgeGraphSearchResult & { score: number } => result !== null)
    .sort((left, right) => (
      left.score - right.score
      || left.document.title.localeCompare(right.document.title)
      || left.document.path.localeCompare(right.document.path)
    ))
    .slice(0, limit)
    .map(({ score: _score, ...result }) => result);
}

function documentFolderAncestors(path: string): string[] {
  const folder = documentFolder(path);
  if (folder === '/') return ['/'];
  const segments = folder.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

function matchesFolder(document: WorkspaceLinkDocument, folder: string): boolean {
  const documentPath = document.path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (folder === '/') return !documentPath.includes('/');
  return documentPath.startsWith(`${folder.replace(/^\/+|\/+$/g, '')}/`);
}

function incrementFacet(map: Map<string, number>, value: string): void {
  map.set(value, (map.get(value) ?? 0) + 1);
}

function toSortedFacets(map: Map<string, number>): KnowledgeGraphFacet[] {
  return [...map.entries()]
    .map(([value, count]) => ({ count, value }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

export function getKnowledgeGraphFacets(index: WorkspaceLinkIndex): KnowledgeGraphFacets {
  const folders = new Map<string, number>();
  const tags = new Map<string, number>();

  for (const document of index.documents) {
    for (const folder of documentFolderAncestors(document.path)) incrementFacet(folders, folder);
    for (const tag of new Set(document.tags)) incrementFacet(tags, tag);
  }

  return { folders: toSortedFacets(folders), tags: toSortedFacets(tags) };
}

function documentMatchesFilters(
  document: WorkspaceLinkDocument,
  selectedFolders: readonly string[],
  selectedTags: readonly string[],
): boolean {
  const folderMatches = selectedFolders.length === 0
    || selectedFolders.some((folder) => matchesFolder(document, folder));
  const tagMatches = selectedTags.length === 0
    || document.tags.some((tag) => selectedTags.includes(tag));
  return folderMatches && tagMatches;
}

function documentGroup(
  document: WorkspaceLinkDocument,
  degree: number,
  colorMode: KnowledgeGraphColorMode,
): string {
  if (colorMode === 'folder') return documentFolder(document.path);
  if (colorMode === 'tag') return document.tags[0] || 'untagged';
  return degree > 0 ? 'connected' : 'unlinked';
}

function documentColor(group: string, colorMode: KnowledgeGraphColorMode): string {
  if (colorMode === 'status') return group === 'connected' ? '#38bdf8' : '#94a3b8';
  return group === 'untagged' ? '#94a3b8' : groupColor(group);
}

function groupedPosition(input: {
  groupCount: number;
  groupIndex: number;
  id: string;
  itemCount: number;
  itemIndex: number;
}): { x: number; y: number } {
  const groupAngle = (input.groupIndex / Math.max(1, input.groupCount)) * Math.PI * 2;
  const groupRadius = input.groupCount <= 1 ? 0 : Math.max(14, input.groupCount * 4.5);
  const centerX = Math.cos(groupAngle) * groupRadius;
  const centerY = Math.sin(groupAngle) * groupRadius;
  const hash = hashString(input.id);
  const jitter = (hash % 10_000) / 10_000;
  const itemAngle = ((input.itemIndex + jitter) / Math.max(1, input.itemCount)) * Math.PI * 2;
  const itemRadius = input.itemCount <= 1 ? 0 : 2.5 + Math.sqrt(input.itemIndex + 1) * 1.7;
  return {
    x: centerX + Math.cos(itemAngle) * itemRadius,
    y: centerY + Math.sin(itemAngle) * itemRadius,
  };
}

function initialPosition(id: string, index: number, count: number): { x: number; y: number } {
  return groupedPosition({
    groupCount: 1,
    groupIndex: 0,
    id,
    itemCount: count,
    itemIndex: index,
  });
}

function unresolvedNodeId(edge: WorkspaceLinkEdge): string {
  return `unresolved:${edge.status}:${edge.targetText.trim().toLocaleLowerCase()}`;
}

export function buildKnowledgeGraphData(
  index: WorkspaceLinkIndex,
  options: KnowledgeGraphOptions,
): KnowledgeGraphData {
  const selectedFolders = options.selectedFolders ?? [];
  const selectedTags = options.selectedTags ?? [];
  const matchedDocuments = index.documents.filter((document) => (
    documentMatchesFilters(document, selectedFolders, selectedTags)
  ));
  const matchedDocumentIds = new Set(matchedDocuments.map((document) => document.path));
  const visibleEdges = (options.showBroken
    ? index.edges
    : index.edges.filter((edge) => edge.status === 'resolved'))
    .filter((edge) => (
      matchedDocumentIds.has(edge.sourcePath)
      && (!edge.targetPath || matchedDocumentIds.has(edge.targetPath))
    ));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of visibleEdges) {
    outgoing.set(edge.sourcePath, (outgoing.get(edge.sourcePath) ?? 0) + 1);
    if (edge.targetPath) incoming.set(edge.targetPath, (incoming.get(edge.targetPath) ?? 0) + 1);
  }

  const groupedDocuments = matchedDocuments.map((document) => {
    const incomingCount = incoming.get(document.path) ?? 0;
    const outgoingCount = outgoing.get(document.path) ?? 0;
    const degree = incomingCount + outgoingCount;
    return {
      degree,
      document,
      group: documentGroup(document, degree, options.colorMode),
      incomingCount,
      outgoingCount,
    };
  });
  const groupEntries = new Map<string, typeof groupedDocuments>();
  for (const entry of groupedDocuments) {
    const entries = groupEntries.get(entry.group) ?? [];
    entries.push(entry);
    groupEntries.set(entry.group, entries);
  }
  const groupKeys = [...groupEntries.keys()].sort();
  const groupIndexByKey = new Map(groupKeys.map((group, index) => [group, index]));
  const itemIndexByPath = new Map<string, number>();
  for (const entries of groupEntries.values()) {
    entries.forEach((entry, index) => itemIndexByPath.set(entry.document.path, index));
  }
  const documentNodes = groupedDocuments.map((entry) => {
    const entries = groupEntries.get(entry.group) ?? [entry];
    const position = groupedPosition({
      groupCount: groupKeys.length,
      groupIndex: groupIndexByKey.get(entry.group) ?? 0,
      id: entry.document.path,
      itemCount: entries.length,
      itemIndex: itemIndexByPath.get(entry.document.path) ?? 0,
    });
    return {
      aliases: entry.document.aliases,
      color: documentColor(entry.group, options.colorMode),
      degree: entry.degree,
      folder: documentFolder(entry.document.path),
      group: entry.group,
      id: entry.document.path,
      incoming: entry.incomingCount,
      kind: 'document' as const,
      label: entry.document.title,
      outgoing: entry.outgoingCount,
      path: entry.document.path,
      size: Math.min(16, 4.5 + Math.sqrt(entry.degree) * 2.2),
      tags: entry.document.tags,
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
        const position = initialPosition(
          targetId,
          nodes.length + unresolvedNodes.size,
          matchedDocuments.length + index.brokenLinks.length,
        );
        unresolvedNodes.set(targetId, {
          aliases: [],
          color: edge.status === 'ambiguous' ? '#fbbf24' : '#fb7185',
          degree: 1,
          folder: '',
          group: edge.status,
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
