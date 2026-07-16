import type {
  WorkspaceLinkDocument,
  WorkspaceLinkEdge,
  WorkspaceLinkIndex,
} from './workspace-link-index-core';
import { groupWorkspaceReferenceEdges } from './workspace-reference-groups';

export type WorkspaceDocumentRelation = {
  aliases: string[];
  bidirectional: boolean;
  blockIds: string[];
  headings: string[];
  linkAliases: string[];
  occurrences: number;
  path: string;
  tags: string[];
  title: string;
};

export type WorkspaceBrokenDocumentRelation = {
  candidates: string[];
  linkAliases: string[];
  occurrences: number;
  status: 'ambiguous' | 'missing';
  targetText: string;
};

export type WorkspaceNearbyDocument = {
  path: string;
  score: number;
  sharedTags: string[];
  tags: string[];
  title: string;
  viaDocuments: string[];
};

export type WorkspaceDocumentRelations = {
  brokenLinks: WorkspaceBrokenDocumentRelation[];
  document: WorkspaceLinkDocument | null;
  incoming: WorkspaceDocumentRelation[];
  outgoing: WorkspaceDocumentRelation[];
  related: WorkspaceNearbyDocument[];
};

export type WorkspaceDocumentRelationsOptions = {
  includeRelated?: boolean;
  relatedLimit?: number;
};

function uniqueSorted(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
    .sort((left, right) => left.localeCompare(right));
}

function sortRelations(relations: WorkspaceDocumentRelation[]): WorkspaceDocumentRelation[] {
  return relations.sort((left, right) => (
    Number(right.bidirectional) - Number(left.bidirectional)
    || right.occurrences - left.occurrences
    || left.title.localeCompare(right.title)
    || left.path.localeCompare(right.path)
  ));
}

function groupResolvedRelations(input: {
  bidirectionalPaths: ReadonlySet<string>;
  direction: 'incoming' | 'outgoing';
  documents: WorkspaceLinkDocument[];
  edges: WorkspaceLinkEdge[];
}): WorkspaceDocumentRelation[] {
  const documentByPath = new Map(input.documents.map((document) => [document.path, document]));
  const groups = groupWorkspaceReferenceEdges(input.edges, input.documents, input.direction);
  return sortRelations(groups.map((group) => {
    const document = documentByPath.get(group.reference.path);
    return {
      aliases: document?.aliases ?? [],
      bidirectional: input.bidirectionalPaths.has(group.reference.path),
      blockIds: uniqueSorted(group.edges.map((edge) => edge.blockId)),
      headings: uniqueSorted(group.edges.map((edge) => edge.heading)),
      linkAliases: uniqueSorted(group.edges.map((edge) => edge.alias)),
      occurrences: group.edges.length,
      path: group.reference.path,
      tags: document?.tags ?? [],
      title: group.reference.title,
    };
  }));
}

function groupBrokenLinks(edges: WorkspaceLinkEdge[]): WorkspaceBrokenDocumentRelation[] {
  const groups = new Map<string, WorkspaceBrokenDocumentRelation>();
  for (const edge of edges) {
    if (edge.status === 'resolved') continue;
    const key = `${edge.status}\0${edge.targetText.trim().toLocaleLowerCase()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.candidates = uniqueSorted([...existing.candidates, ...edge.candidates]);
      existing.linkAliases = uniqueSorted([...existing.linkAliases, edge.alias]);
      continue;
    }
    groups.set(key, {
      candidates: uniqueSorted(edge.candidates),
      linkAliases: uniqueSorted([edge.alias]),
      occurrences: 1,
      status: edge.status,
      targetText: edge.targetText,
    });
  }
  return [...groups.values()].sort((left, right) => (
    right.occurrences - left.occurrences
    || left.targetText.localeCompare(right.targetText)
  ));
}

function addAdjacent(adjacency: Map<string, Set<string>>, source: string, target: string): void {
  const neighbors = adjacency.get(source) ?? new Set<string>();
  neighbors.add(target);
  adjacency.set(source, neighbors);
}

function getNearbyDocuments(input: {
  directPaths: ReadonlySet<string>;
  document: WorkspaceLinkDocument;
  index: WorkspaceLinkIndex;
  limit: number;
}): WorkspaceNearbyDocument[] {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of input.index.edges) {
    if (edge.status !== 'resolved' || !edge.targetPath) continue;
    addAdjacent(adjacency, edge.sourcePath, edge.targetPath);
    addAdjacent(adjacency, edge.targetPath, edge.sourcePath);
  }

  const excludedPaths = new Set([input.document.path, ...input.directPaths]);
  const candidateReasons = new Map<string, { sharedTags: Set<string>; viaDocuments: Set<string> }>();
  const ensureCandidate = (candidatePath: string) => {
    const existing = candidateReasons.get(candidatePath);
    if (existing) return existing;
    const next = { sharedTags: new Set<string>(), viaDocuments: new Set<string>() };
    candidateReasons.set(candidatePath, next);
    return next;
  };

  for (const directPath of input.directPaths) {
    for (const candidatePath of adjacency.get(directPath) ?? []) {
      if (excludedPaths.has(candidatePath)) continue;
      ensureCandidate(candidatePath).viaDocuments.add(directPath);
    }
  }

  const sourceTags = new Set(input.document.tags);
  for (const document of input.index.documents) {
    if (excludedPaths.has(document.path)) continue;
    const sharedTags = document.tags.filter((tag) => sourceTags.has(tag));
    if (sharedTags.length === 0) continue;
    const reasons = ensureCandidate(document.path);
    for (const tag of sharedTags) reasons.sharedTags.add(tag);
  }

  const documentByPath = new Map(input.index.documents.map((document) => [document.path, document]));
  return [...candidateReasons.entries()]
    .flatMap(([candidatePath, reasons]) => {
      const document = documentByPath.get(candidatePath);
      if (!document) return [];
      const sharedTags = [...reasons.sharedTags].sort();
      const viaDocuments = [...reasons.viaDocuments].sort();
      return [{
        path: document.path,
        score: viaDocuments.length * 4 + sharedTags.length,
        sharedTags,
        tags: document.tags,
        title: document.title,
        viaDocuments,
      }];
    })
    .sort((left, right) => (
      right.score - left.score
      || left.title.localeCompare(right.title)
      || left.path.localeCompare(right.path)
    ))
    .slice(0, input.limit);
}

export function getWorkspaceDocumentRelations(
  index: WorkspaceLinkIndex,
  documentPath: string,
  options: WorkspaceDocumentRelationsOptions = {},
): WorkspaceDocumentRelations {
  const document = index.documents.find((candidate) => candidate.path === documentPath) ?? null;
  if (!document) {
    return { brokenLinks: [], document: null, incoming: [], outgoing: [], related: [] };
  }

  const incomingEdges = index.backlinks[documentPath] ?? [];
  const outgoingEdges = index.edges.filter((edge) => (
    edge.sourcePath === documentPath && edge.status === 'resolved' && edge.targetPath
  ));
  const brokenEdges = index.edges.filter((edge) => (
    edge.sourcePath === documentPath && edge.status !== 'resolved'
  ));
  const incomingPaths = new Set(incomingEdges.map((edge) => edge.sourcePath));
  const outgoingPaths = new Set(outgoingEdges.flatMap((edge) => edge.targetPath ? [edge.targetPath] : []));
  const bidirectionalPaths = new Set(
    [...incomingPaths].filter((path) => outgoingPaths.has(path)),
  );
  const directPaths = new Set([...incomingPaths, ...outgoingPaths]);
  const relatedLimit = Math.max(1, Math.min(50, Math.trunc(options.relatedLimit ?? 20)));

  return {
    brokenLinks: groupBrokenLinks(brokenEdges),
    document,
    incoming: groupResolvedRelations({
      bidirectionalPaths,
      direction: 'incoming',
      documents: index.documents,
      edges: incomingEdges,
    }),
    outgoing: groupResolvedRelations({
      bidirectionalPaths,
      direction: 'outgoing',
      documents: index.documents,
      edges: outgoingEdges,
    }),
    related: options.includeRelated
      ? getNearbyDocuments({ directPaths, document, index, limit: relatedLimit })
      : [],
  };
}
