export interface FileReferenceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  isImage: boolean;
  size?: number;
  created?: number;
  modified?: number;
}

export type FileReferenceSortKey = 'name' | 'created' | 'modified' | 'size';

const fileNameCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

function getBasenameWithoutExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return fileName;
  }
  return fileName.slice(0, dotIndex);
}

function getPathDepth(filePath: string): number {
  return filePath.split('/').filter(Boolean).length;
}

function getMatchRank(entry: FileReferenceEntry, normalizedQuery: string): number {
  const normalizedName = normalizeSearchValue(entry.name);
  const normalizedBaseName = normalizeSearchValue(getBasenameWithoutExtension(entry.name));
  const normalizedPath = normalizeSearchValue(entry.path);

  if (normalizedBaseName === normalizedQuery) {
    return 0;
  }

  if (normalizedName === normalizedQuery) {
    return 1;
  }

  if (normalizedBaseName.startsWith(normalizedQuery) || normalizedName.startsWith(normalizedQuery)) {
    return 2;
  }

  if (normalizedBaseName.includes(normalizedQuery) || normalizedName.includes(normalizedQuery)) {
    return 3;
  }

  if (normalizedPath.includes(normalizedQuery)) {
    return 4;
  }

  return Number.POSITIVE_INFINITY;
}

export function searchFileReferenceEntries(
  entries: FileReferenceEntry[],
  query: string,
): FileReferenceEntry[] {
  const normalizedQuery = normalizeSearchValue(query);

  if (!normalizedQuery) {
    return [...entries].sort((left, right) => left.path.localeCompare(right.path));
  }

  return entries
    .map((entry) => ({
      entry,
      matchRank: getMatchRank(entry, normalizedQuery),
      depth: getPathDepth(entry.path),
      nameLength: entry.name.length,
    }))
    .filter((candidate) => Number.isFinite(candidate.matchRank))
    .sort((left, right) => {
      if (left.matchRank !== right.matchRank) {
        return left.matchRank - right.matchRank;
      }

      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }

      if (left.nameLength !== right.nameLength) {
        return left.nameLength - right.nameLength;
      }

      return left.entry.path.localeCompare(right.entry.path);
    })
    .map((candidate) => candidate.entry);
}

export function sortFileReferenceEntries(
  entries: FileReferenceEntry[],
  sortKey: FileReferenceSortKey,
): FileReferenceEntry[] {
  return [...entries].sort((left, right) => {
    if (sortKey === 'name') return fileNameCollator.compare(left.path, right.path);

    const leftValue = left[sortKey];
    const rightValue = right[sortKey];
    if (leftValue === undefined && rightValue === undefined) {
      return fileNameCollator.compare(left.path, right.path);
    }
    if (leftValue === undefined) return 1;
    if (rightValue === undefined) return -1;
    if (leftValue !== rightValue) return rightValue - leftValue;
    return fileNameCollator.compare(left.path, right.path);
  });
}
