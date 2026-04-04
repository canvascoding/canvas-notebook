export interface SkillReferenceEntry {
  name: string;
  title: string;
  description: string;
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

function getMatchRank(entry: SkillReferenceEntry, normalizedQuery: string): number {
  const normalizedName = normalizeSearchValue(entry.name);
  const normalizedTitle = normalizeSearchValue(entry.title);
  const normalizedDescription = normalizeSearchValue(entry.description);

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedName === normalizedQuery) {
    return 0;
  }

  if (normalizedTitle === normalizedQuery) {
    return 1;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 2;
  }

  if (normalizedTitle.startsWith(normalizedQuery)) {
    return 3;
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 4;
  }

  if (normalizedTitle.includes(normalizedQuery)) {
    return 5;
  }

  if (normalizedDescription.includes(normalizedQuery)) {
    return 6;
  }

  return Number.POSITIVE_INFINITY;
}

export function searchSkillReferenceEntries<T extends SkillReferenceEntry>(
  entries: T[],
  query: string,
): T[] {
  const normalizedQuery = normalizeSearchValue(query);

  return entries
    .map((entry) => ({
      entry,
      rank: getMatchRank(entry, normalizedQuery),
      nameLength: entry.name.length,
    }))
    .filter((candidate) => Number.isFinite(candidate.rank))
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }

      if (left.nameLength !== right.nameLength) {
        return left.nameLength - right.nameLength;
      }

      return left.entry.name.localeCompare(right.entry.name);
    })
    .map((candidate) => candidate.entry);
}
