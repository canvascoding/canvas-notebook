import { parseEmailSearchQuery, type EmailSearchExpression } from '@/app/lib/email/search-query';

export function emailSearchHighlightTerms(query: string): string[] {
  try {
    const values: string[] = [];
    const visit = (node: EmailSearchExpression | null): void => {
      if (!node) return;
      if (node.type === 'term') values.push(node.value);
      else { visit(node.left); visit(node.right); }
    };
    visit(parseEmailSearchQuery(query));
    return [...new Set(values)].sort((a, b) => b.length - a.length);
  } catch { return []; }
}

/** React text nodes only; provider HTML is never injected into a search result. */
export function highlightEmailSearchText(text: string, terms: string[]) {
  if (!terms.length) return text;
  const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const matcher = new RegExp(`(${escaped.join('|')})`, 'giu');
  return text.split(matcher).map((part, index) => index % 2
    ? <mark key={index} className="rounded-sm bg-yellow-200/70 text-inherit dark:bg-yellow-500/25">{part}</mark>
    : part);
}
