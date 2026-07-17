export type ComposioToolSummary = {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
};

type ConnectedToolkit = {
  status?: string;
  toolkit?: {
    slug?: string;
    name?: string;
  };
};

function normalizeWords(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function normalizedPhrase(value: string): string {
  return normalizeWords(value).join(' ');
}

export function normalizeComposioToolkits(toolkits: string[] | undefined, limit = 10): string[] {
  return Array.from(new Set(
    (toolkits || [])
      .map((toolkit) => toolkit.trim().toLowerCase())
      .filter(Boolean),
  )).slice(0, limit);
}

export function inferConnectedComposioToolkits(query: string, accounts: ConnectedToolkit[]): string[] {
  const phrase = normalizedPhrase(query);
  const queryWords = new Set(normalizeWords(query));
  if (!phrase) return [];

  return normalizeComposioToolkits(accounts
    .filter((account) => !account.status || account.status === 'ACTIVE')
    .filter((account) => {
      const candidates = [account.toolkit?.slug, account.toolkit?.name]
        .filter((value): value is string => Boolean(value?.trim()))
        .map(normalizedPhrase)
        .filter(Boolean);
      return candidates.some((candidate) => phrase.includes(candidate)
        || candidate.split(' ').every((word) => queryWords.has(word))
        || candidate.split(' ').some((word) => Array.from(queryWords).some((queryWord) => (
          queryWord.length >= 4 && word.startsWith(queryWord)
        ))));
    })
    .map((account) => account.toolkit?.slug || ''));
}

export function selectComposioToolSearchResults(
  tools: ComposioToolSummary[],
  query: string,
  scopedToolkits: string[],
  limit = 20,
): { tools: ComposioToolSummary[]; totalCount: number; fallback: boolean } {
  const ignoredWords = new Set(scopedToolkits.flatMap(normalizeWords));
  const terms = normalizeWords(query).filter((term) => !ignoredWords.has(term));
  if (terms.length === 0) {
    return { tools: tools.slice(0, limit), totalCount: tools.length, fallback: false };
  }

  const ranked = tools
    .map((tool, index) => {
      const identity = `${tool.slug} ${tool.name}`.toLowerCase();
      const description = tool.description.toLowerCase();
      const score = terms.reduce((total, term) => {
        if (identity.includes(term)) return total + 3;
        if (description.includes(term)) return total + 1;
        return total;
      }, 0);
      return { tool, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (ranked.length === 0) {
    return { tools: tools.slice(0, limit), totalCount: tools.length, fallback: true };
  }

  return {
    tools: ranked.slice(0, limit).map((entry) => entry.tool),
    totalCount: ranked.length,
    fallback: false,
  };
}
