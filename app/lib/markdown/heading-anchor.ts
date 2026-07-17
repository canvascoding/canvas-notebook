const UNSUPPORTED_ANCHOR_CHARACTERS = /[^\p{Letter}\p{Number}\p{Mark}\s-]/gu;
const ANCHOR_SEPARATOR_CHARACTERS = /[\s-]+/gu;

export function markdownHeadingAnchorBase(heading: string): string {
  const anchor = heading
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(UNSUPPORTED_ANCHOR_CHARACTERS, '')
    .replace(ANCHOR_SEPARATOR_CHARACTERS, '-')
    .replace(/^-+|-+$/gu, '');

  return anchor || 'section';
}

export function createMarkdownHeadingAnchorFactory(): (heading: string) => string {
  const nextSuffixes = new Map<string, number>();
  const usedAnchors = new Set<string>();

  return (heading: string) => {
    const base = markdownHeadingAnchorBase(heading);
    let suffix = nextSuffixes.get(base) ?? 0;
    let anchor = suffix === 0 ? base : `${base}-${suffix}`;

    while (usedAnchors.has(anchor)) {
      suffix += 1;
      anchor = `${base}-${suffix}`;
    }

    nextSuffixes.set(base, suffix + 1);
    usedAnchors.add(anchor);
    return anchor;
  };
}

export function markdownHeadingAnchorFromHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed.startsWith('#') || trimmed.length === 1) return null;

  const fragment = trimmed.slice(1);
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

export function findMarkdownHeadingAnchor(
  root: ParentNode,
  href: string,
): HTMLElement | null {
  const anchor = markdownHeadingAnchorFromHref(href);
  if (!anchor) return null;

  for (const heading of root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')) {
    if (heading.id === anchor) return heading;
  }
  return null;
}

export function scrollToMarkdownHeadingAnchor(root: ParentNode, href: string): boolean {
  const heading = findMarkdownHeadingAnchor(root, href);
  if (!heading) return false;

  const reduceMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  heading.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'start',
  });
  return true;
}
