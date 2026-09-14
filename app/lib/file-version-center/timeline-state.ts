import type {
  FileVersionCenterRequestV1,
  FileVersionTimelineEntryV1,
  FileVersionTimelineResponseV1,
} from './contracts/v1';

export type FileVersionTimelineEntryKey = `agent_operation:${string}` | 'current' | `revision:${string}`;

export type FileVersionTimelineGroups = {
  reviews: Extract<FileVersionTimelineEntryV1, { kind: 'agent_operation' }>[];
  current: Extract<FileVersionTimelineEntryV1, { kind: 'current' }> | null;
  revisions: Extract<FileVersionTimelineEntryV1, { kind: 'revision' }>[];
};

export type FileVersionTimelineSelection = {
  key: FileVersionTimelineEntryKey;
  entry: FileVersionTimelineEntryV1 | null;
  state: 'selected' | 'pending' | 'invalidated';
  invalidatedKey?: FileVersionTimelineEntryKey;
};

export function fileVersionTimelineEntryKey(entry: FileVersionTimelineEntryV1): FileVersionTimelineEntryKey {
  if (entry.kind === 'current') return 'current';
  return `${entry.kind}:${entry.id}`;
}

export function requestSelectionKey(
  request: FileVersionCenterRequestV1,
): FileVersionTimelineEntryKey | null {
  return request.selectedEntry ? `${request.selectedEntry.kind}:${request.selectedEntry.id}` : null;
}

export function groupFileVersionTimeline(
  entries: FileVersionTimelineEntryV1[],
): FileVersionTimelineGroups {
  const reviews: FileVersionTimelineGroups['reviews'] = [];
  const revisions: FileVersionTimelineGroups['revisions'] = [];
  let current: FileVersionTimelineGroups['current'] = null;
  for (const entry of entries) {
    if (entry.kind === 'agent_operation') reviews.push(entry);
    else if (entry.kind === 'current') current = entry;
    else revisions.push(entry);
  }
  return { reviews, current, revisions };
}

export function mergeFileVersionTimelinePage(
  previous: FileVersionTimelineResponseV1,
  next: FileVersionTimelineResponseV1,
): FileVersionTimelineResponseV1 {
  if (previous.document.workspaceId !== next.document.workspaceId
    || previous.document.lineageId !== next.document.lineageId) {
    throw new Error('The timeline page belongs to another document.');
  }
  const entries = new Map<FileVersionTimelineEntryKey, FileVersionTimelineEntryV1>();
  for (const entry of [...previous.entries, ...next.entries]) {
    entries.set(fileVersionTimelineEntryKey(entry), entry);
  }
  return {
    ...next,
    entries: [...entries.values()],
  };
}

export function reconcileFileVersionTimelineSelection(input: {
  request: FileVersionCenterRequestV1;
  timeline: FileVersionTimelineResponseV1;
  selectedKey?: FileVersionTimelineEntryKey | null;
}): FileVersionTimelineSelection {
  const requestedKey = input.selectedKey ?? requestSelectionKey(input.request);
  const indexed = new Map(input.timeline.entries.map((entry) => [fileVersionTimelineEntryKey(entry), entry]));
  const defaultCandidate = input.request.initialView === 'reviews'
    ? input.timeline.entries.find((entry) => entry.kind === 'agent_operation')
      ?? input.timeline.entries.find((entry) => entry.kind === 'current')
      ?? input.timeline.entries[0]
    : input.timeline.entries.find((entry) => entry.kind === 'current')
      ?? input.timeline.entries[0];
  const defaultKey: FileVersionTimelineEntryKey = defaultCandidate
    ? fileVersionTimelineEntryKey(defaultCandidate)
    : 'current';
  const defaultEntry = indexed.get(defaultKey) ?? input.timeline.entries[0] ?? null;
  const safeDefaultKey = defaultEntry ? fileVersionTimelineEntryKey(defaultEntry) : 'current';

  if (!requestedKey) {
    return { key: safeDefaultKey, entry: defaultEntry, state: 'selected' };
  }
  const selected = indexed.get(requestedKey);
  if (selected) return { key: requestedKey, entry: selected, state: 'selected' };
  if (input.timeline.page.hasMore) return { key: requestedKey, entry: null, state: 'pending' };
  return {
    key: safeDefaultKey,
    entry: defaultEntry,
    state: 'invalidated',
    invalidatedKey: requestedKey,
  };
}
