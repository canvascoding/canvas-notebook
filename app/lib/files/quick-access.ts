import type { FileNode } from './types';
import { normalizeWorkspacePathParam } from './path-utils';

export const FILE_HISTORY_LIMIT = 100;
export type FileVisit = { path: string; openedAt: number; count: number };
export type QuickAccessView = 'recent' | 'favorites' | 'frequent' | 'all';
export type QuickAccessFile = Pick<FileNode, 'path' | 'name' | 'title' | 'isFavorite' | 'pinnedAt'> & {
  openedAt: number | null;
};
export type QuickAccessResult = { files: QuickAccessFile[]; total: number; workspaceFileCount: number };

export function normalizeFileVisits(value: unknown): FileVisit[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((item): item is FileVisit => {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string') return false;
    if (normalizeWorkspacePathParam(item.path) !== item.path || seen.has(item.path)) return false;
    if (!Number.isSafeInteger(item.openedAt) || item.openedAt <= 0 || !Number.isSafeInteger(item.count) || item.count < 1) return false;
    seen.add(item.path);
    return true;
  }).sort((a, b) => b.openedAt - a.openedAt).slice(0, FILE_HISTORY_LIMIT);
}

export function addFileVisit(visits: FileVisit[], path: string, now = Date.now()): FileVisit[] {
  const previous = visits.find((visit) => visit.path === path);
  // Restoring tabs or opening a reference twice in quick succession is one visit.
  const count = previous && now - previous.openedAt < 60_000 ? previous.count : (previous?.count ?? 0) + 1;
  return [{ path, openedAt: now, count }, ...visits.filter((visit) => visit.path !== path)].slice(0, FILE_HISTORY_LIMIT);
}

export function selectQuickAccessFiles(
  nodes: FileNode[], visits: FileVisit[], view: QuickAccessView, query = '', limit = 6,
): QuickAccessResult {
  const history = new Map(visits.map((visit) => [visit.path, visit]));
  const search = query.trim().toLocaleLowerCase();
  const available = nodes.filter((node) => node.type === 'file');
  const files = available.filter((node) => {
    if (search) return `${node.title ?? ''} ${node.name} ${node.path}`.toLocaleLowerCase().includes(search);
    if (view === 'favorites') return node.isFavorite || node.pinnedAt != null;
    if (view === 'recent' || view === 'frequent') return history.has(node.path);
    return true;
  }).sort((a, b) => {
    if (!search && view === 'favorites') {
      const pins = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
      if (pins) return pins;
    }
    if (!search && view === 'frequent') {
      const frequency = (history.get(b.path)?.count ?? 0) - (history.get(a.path)?.count ?? 0);
      if (frequency) return frequency;
    }
    if (!search && (view === 'recent' || view === 'frequent')) {
      const recency = (history.get(b.path)?.openedAt ?? 0) - (history.get(a.path)?.openedAt ?? 0);
      if (recency) return recency;
    }
    return (a.title || a.name).localeCompare(b.title || b.name, undefined, { numeric: true });
  });
  return {
    files: files.slice(0, limit).map((node) => ({
      path: node.path, name: node.name, title: node.title,
      isFavorite: node.isFavorite, pinnedAt: node.pinnedAt,
      openedAt: history.get(node.path)?.openedAt ?? null,
    })),
    total: files.length,
    workspaceFileCount: available.length,
  };
}

export function notebookFileHref(path: string, workspaceId: string) {
  return `/notebook?${new URLSearchParams({ path, workspaceId })}`;
}
