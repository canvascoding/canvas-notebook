export type RichMarkdownJsonNode = {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: RichMarkdownJsonNode[];
  text?: string;
  marks?: unknown[];
};

const nodeFingerprintCache = new WeakMap<RichMarkdownJsonNode, string>();

function comparableNodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparableNodeValue);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(source).map(([key, entry]) => {
      if (key !== 'attrs' || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return [key, comparableNodeValue(entry)];
      }
      const { id: _id, ...attrs } = entry as Record<string, unknown>;
      return [key, comparableNodeValue(attrs)];
    }),
  );
}

function nodeFingerprint(node: RichMarkdownJsonNode): string {
  const cached = nodeFingerprintCache.get(node);
  if (cached) return cached;
  const fingerprint = JSON.stringify(comparableNodeValue(node));
  nodeFingerprintCache.set(node, fingerprint);
  return fingerprint;
}

function nodeText(node: RichMarkdownJsonNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content || []).map(nodeText).join('');
}

function textSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const maximum = Math.max(left.length, right.length);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]
  ) suffix += 1;
  return (prefix + suffix) / maximum;
}

function nodeMatchScore(left: RichMarkdownJsonNode, right: RichMarkdownJsonNode): number {
  if (!left.type || left.type !== right.type) return Number.NEGATIVE_INFINITY;
  if (nodeFingerprint(left) === nodeFingerprint(right)) return 10_000;
  const leftChildTypes = (left.content || []).map((child) => child.type || '').join('\u0000');
  const rightChildTypes = (right.content || []).map((child) => child.type || '').join('\u0000');
  return 10 + (textSimilarity(nodeText(left), nodeText(right)) * 100)
    + (leftChildTypes === rightChildTypes ? 20 : 0);
}

function alignChangedNodePairs(
  current: RichMarkdownJsonNode[],
  next: RichMarkdownJsonNode[],
): Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> {
  if (current.length * next.length > 4_096) {
    const pairs: Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> = [];
    let currentIndex = 0;
    let nextIndex = 0;
    while (currentIndex < current.length && nextIndex < next.length) {
      const currentNode = current[currentIndex];
      const nextNode = next[nextIndex];
      if (currentNode.type === nextNode.type) {
        pairs.push([currentNode, nextNode]);
        currentIndex += 1;
        nextIndex += 1;
        continue;
      }
      const matchingNext = next.slice(nextIndex + 1, nextIndex + 9)
        .findIndex((candidate) => candidate.type === currentNode.type);
      const matchingCurrent = current.slice(currentIndex + 1, currentIndex + 9)
        .findIndex((candidate) => candidate.type === nextNode.type);
      if (matchingNext >= 0 && (matchingCurrent < 0 || matchingNext <= matchingCurrent)) {
        nextIndex += 1;
      } else if (matchingCurrent >= 0) {
        currentIndex += 1;
      } else {
        currentIndex += 1;
        nextIndex += 1;
      }
    }
    return pairs;
  }

  const scores = Array.from({ length: current.length + 1 }, () => (
    Array<number>(next.length + 1).fill(0)
  ));
  for (let currentIndex = 1; currentIndex <= current.length; currentIndex += 1) {
    for (let nextIndex = 1; nextIndex <= next.length; nextIndex += 1) {
      const matchScore = nodeMatchScore(current[currentIndex - 1], next[nextIndex - 1]);
      scores[currentIndex][nextIndex] = Math.max(
        scores[currentIndex - 1][nextIndex],
        scores[currentIndex][nextIndex - 1],
        Number.isFinite(matchScore)
          ? scores[currentIndex - 1][nextIndex - 1] + matchScore
          : Number.NEGATIVE_INFINITY,
      );
    }
  }

  const pairs: Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> = [];
  let currentIndex = current.length;
  let nextIndex = next.length;
  while (currentIndex > 0 && nextIndex > 0) {
    const matchScore = nodeMatchScore(current[currentIndex - 1], next[nextIndex - 1]);
    if (
      Number.isFinite(matchScore)
      && scores[currentIndex][nextIndex] === scores[currentIndex - 1][nextIndex - 1] + matchScore
    ) {
      pairs.push([current[currentIndex - 1], next[nextIndex - 1]]);
      currentIndex -= 1;
      nextIndex -= 1;
    } else if (scores[currentIndex][nextIndex] === scores[currentIndex][nextIndex - 1]) {
      nextIndex -= 1;
    } else {
      currentIndex -= 1;
    }
  }
  return pairs.reverse();
}

/**
 * Aligns sibling nodes without relying on the fresh IDs generated while parsing
 * the replacement Markdown. Exact unchanged subtrees dominate the alignment;
 * edited siblings fall back to type, text similarity, and document order.
 */
function alignedNodePairs(
  current: RichMarkdownJsonNode[],
  next: RichMarkdownJsonNode[],
): Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> {
  const currentByFingerprint = new Map<string, RichMarkdownJsonNode[]>();
  for (const node of current) {
    const fingerprint = nodeFingerprint(node);
    const matches = currentByFingerprint.get(fingerprint) || [];
    matches.push(node);
    currentByFingerprint.set(fingerprint, matches);
  }
  const exactPairs: Array<[RichMarkdownJsonNode, RichMarkdownJsonNode]> = [];
  const exactlyMatchedCurrent = new Set<RichMarkdownJsonNode>();
  const exactlyMatchedNext = new Set<RichMarkdownJsonNode>();
  for (const node of next) {
    const match = currentByFingerprint.get(nodeFingerprint(node))?.shift();
    if (!match) continue;
    exactPairs.push([match, node]);
    exactlyMatchedCurrent.add(match);
    exactlyMatchedNext.add(node);
  }
  const changedPairs = alignChangedNodePairs(
    current.filter((node) => !exactlyMatchedCurrent.has(node)),
    next.filter((node) => !exactlyMatchedNext.has(node)),
  );
  return [...exactPairs, ...changedPairs];
}

export function stableIdCounts(node: RichMarkdownJsonNode, counts = new Map<string, number>()): Map<string, number> {
  const id = node.attrs?.id;
  if (typeof id === 'string' && id.trim()) counts.set(id, (counts.get(id) || 0) + 1);
  for (const child of node.content || []) stableIdCounts(child, counts);
  return counts;
}

export function preserveAlignedStableIds(
  current: RichMarkdownJsonNode,
  next: RichMarkdownJsonNode,
  currentIdCounts: Map<string, number>,
): void {
  const id = current.attrs?.id;
  if (
    current.type !== 'doc'
    && current.type !== 'text'
    && typeof id === 'string'
    && id.trim()
    && currentIdCounts.get(id) === 1
  ) {
    next.attrs = { ...(next.attrs || {}), id };
  }
  for (const [currentChild, nextChild] of alignedNodePairs(current.content || [], next.content || [])) {
    preserveAlignedStableIds(currentChild, nextChild, currentIdCounts);
  }
}

