type ExtensionMetadata = Readonly<{ name: string; title: string; description: string }>;

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').trim();
}

function words(value: string): string[] {
  return [...new Set(normalize(value).split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2))].slice(0, 32);
}

function hasPartialWord(candidates: ReadonlySet<string>, term: string): boolean {
  if (term.length < 4) return false;
  for (const candidate of candidates) {
    if (candidate.length >= 4 && (candidate.includes(term) || term.includes(candidate))) return true;
  }
  return false;
}

/** One ordering for task discovery, selected context and the shared picker. */
export function scoreExtensionMetadata(entry: ExtensionMetadata, query: string): number {
  const term = normalize(query);
  if (!term) return 0;
  const name = normalize(entry.name), title = normalize(entry.title);
  if (name === term || title === term) return 1_000;
  if (name.startsWith(term) || title.startsWith(term)) return 800;
  if (name.includes(term) || title.includes(term)) return 600;
  const titleWords = new Set(words(`${entry.name} ${entry.title}`));
  const descriptionWords = new Set(words(entry.description));
  // Bounded word containment handles compounds and plural suffixes without
  // turning short description fragments into broad matches or guessing stems.
  return words(term).reduce((score, word) => score + (titleWords.has(word) ? 20
    : hasPartialWord(titleWords, word) ? 10 : descriptionWords.has(word) ? 2
      : hasPartialWord(descriptionWords, word) ? 1 : 0), 0);
}
