import type { ChatFileReference } from './tool-file-references';
import type { BuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';
import type { FileChangeAppData, FileChangeAppEntryData, FileChangeAppEntryState } from '@/app/lib/tool-apps/file-change-data';

export type FileSummaryChange = { groupId: string; workspaceId: string; entry: FileChangeAppEntryData };
export type FileSummaryRow = {
  reference: ChatFileReference;
  changes: FileSummaryChange[];
  status?: FileChangeAppEntryState | 'loading';
  additions?: number | null;
  deletions?: number | null;
  incomplete?: boolean;
};

export function fileSummaryNeedsReview(entry: FileChangeAppEntryData): boolean {
  return entry.state === 'conflict' || entry.state === 'review_required' || entry.proposal?.lifecycle === 'open';
}

function priority(entry: FileChangeAppEntryData): number {
  if (entry.state === 'conflict') return 3;
  if (fileSummaryNeedsReview(entry)) return 2;
  return entry.state === 'failed' ? 1 : 0;
}

/** Preserve each distinct operation, with outstanding reviews before applied changes. */
export function summarizeFileChanges(
  references: ChatFileReference[], groups: FileChangeAppData[], apps: BuiltinToolAppDescriptor[],
  loadState: 'loading' | 'ready' | 'error',
): FileSummaryRow[] {
  const rows = new Map<string, FileSummaryRow>();
  const key = (workspaceId: string, path: string) => `${workspaceId}:${path}`;
  const toolCalls = new Set(apps.map(app => app.toolCallId));
  const loadedGroupIds = new Set(groups.map(group => group.id));
  const appOrder = new Map(apps.map((app, index) => [app.entityId, index]));
  const missingToolCalls = new Set(apps.filter(app => !loadedGroupIds.has(app.entityId)).map(app => app.toolCallId));
  for (const reference of references) {
    const id = key(reference.workspaceId, reference.path);
    const existing = rows.get(id);
    if (existing) {
      if (existing.reference.kind === 'read' || reference.kind === 'review_required') existing.reference = reference;
      if (reference.kind !== 'read' && missingToolCalls.has(reference.toolCallId)) existing.incomplete = true;
      continue;
    }
    rows.set(id, { reference, changes: [], ...(reference.kind !== 'read' && missingToolCalls.has(reference.toolCallId) ? { incomplete: true } : {}), ...(reference.kind !== 'read' && toolCalls.has(reference.toolCallId)
      ? { status: loadState === 'loading' ? 'loading' : 'unavailable' } : {}) });
  }
  // Read retries may return an older group last. Original tool-call order,
  // rather than network completion order, determines the latest change.
  for (const group of [...groups].sort((a, b) => (appOrder.get(a.id) ?? -1) - (appOrder.get(b.id) ?? -1))) {
    for (const entry of group.entries) {
      const id = key(group.workspaceId, entry.pathHint);
      let row = rows.get(id);
      if (!row) {
        const app = apps.find(app => app.entityId === group.id);
        row = { reference: { workspaceId: group.workspaceId, path: entry.pathHint,
          toolCallId: app?.toolCallId ?? group.id, kind: 'changed' }, changes: [] };
        rows.set(id, row);
      }
      if (row.reference.kind === 'read') row.reference = { ...row.reference, kind: 'changed' };
      const operationKey = entry.operationId ? `operation:${entry.operationId}`
        : entry.revisionId ? `revision:${entry.revisionId}` : `${group.id}:${entry.id}`;
      const duplicateIndex = row.changes.findIndex(change => (change.entry.operationId ? `operation:${change.entry.operationId}`
        : change.entry.revisionId ? `revision:${change.entry.revisionId}` : `${change.groupId}:${change.entry.id}`) === operationKey);
      const change = { groupId: group.id, workspaceId: group.workspaceId, entry };
      if (duplicateIndex >= 0) row.changes[duplicateIndex] = change;
      else row.changes.push(change);
    }
  }
  for (const row of rows.values()) {
    if (!row.changes.length) continue;
    row.changes.reverse();
    row.changes.sort((a, b) => priority(b.entry) - priority(a.entry));
    const preferred = row.changes[0].entry;
    row.status = row.incomplete && !fileSummaryNeedsReview(preferred)
      ? loadState === 'loading' ? 'loading' : 'unavailable' : preferred.state;
    if (fileSummaryNeedsReview(preferred)) row.reference = { ...row.reference, kind: 'review_required' };
    if (row.changes.length === 1 && !row.incomplete) {
      row.additions = preferred.additions;
      row.deletions = preferred.deletions;
    }
  }
  return [...rows.values()];
}
