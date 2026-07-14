export type ObsidianWikiTarget = {
  alias: string | null;
  blockId: string | null;
  heading: string | null;
  path: string;
  raw: string;
  target: string;
};

export type ObsidianWikiLink = ObsidianWikiTarget & {
  embed: boolean;
  end: number;
  start: number;
};

export type ObsidianCallout = {
  end: number;
  fold: '+' | '-' | null;
  start: number;
  title: string | null;
  type: string;
};

export type ObsidianBlockId = {
  end: number;
  id: string;
  start: number;
};

function countRun(value: string, start: number, char: string): number {
  let length = 0;
  while (value[start + length] === char) length += 1;
  return length;
}

function blankRange(mask: string[], source: string, start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (source[index] !== '\n' && source[index] !== '\r') mask[index] = ' ';
  }
}

/**
 * Produces a same-length copy with fenced/inline code and %% comments blanked.
 * Offsets from regex matches against this mask always map to the source string.
 */
function scanObsidianSyntax(markdown: string): { hasComment: boolean; mask: string } {
  const mask = Array.from(markdown);
  let commentOpen = false;
  let hasComment = false;
  let fence: { char: '`' | '~'; length: number } | null = null;
  let lineStart = 0;

  while (lineStart <= markdown.length) {
    const newlineIndex = markdown.indexOf('\n', lineStart);
    const lineEnd = newlineIndex < 0 ? markdown.length : newlineIndex;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, '');
    const fenceMatch = !commentOpen ? line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) : null;

    if (fence) {
      blankRange(mask, markdown, lineStart, lineEnd);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        const closesFence =
          marker[0] === fence.char &&
          marker.length >= fence.length &&
          fenceMatch[2].trim().length === 0;
        if (closesFence) fence = null;
      }
    } else if (fenceMatch) {
      const marker = fenceMatch[1];
      fence = { char: marker[0] as '`' | '~', length: marker.length };
      blankRange(mask, markdown, lineStart, lineEnd);
    } else {
      let inlineCodeLength = 0;
      let index = lineStart;

      while (index < lineEnd) {
        if (commentOpen) {
          const commentEnd = markdown.indexOf('%%', index);
          if (commentEnd < 0 || commentEnd >= lineEnd) {
            blankRange(mask, markdown, index, lineEnd);
            index = lineEnd;
            continue;
          }
          blankRange(mask, markdown, index, commentEnd + 2);
          commentOpen = false;
          index = commentEnd + 2;
          continue;
        }

        if (inlineCodeLength > 0) {
          if (markdown[index] === '`') {
            const runLength = countRun(markdown, index, '`');
            blankRange(mask, markdown, index, Math.min(lineEnd, index + runLength));
            if (runLength === inlineCodeLength) inlineCodeLength = 0;
            index += runLength;
          } else {
            mask[index] = ' ';
            index += 1;
          }
          continue;
        }

        if (markdown.startsWith('%%', index)) {
          blankRange(mask, markdown, index, index + 2);
          hasComment = true;
          commentOpen = true;
          index += 2;
          continue;
        }

        if (markdown[index] === '`') {
          inlineCodeLength = countRun(markdown, index, '`');
          blankRange(mask, markdown, index, Math.min(lineEnd, index + inlineCodeLength));
          index += inlineCodeLength;
          continue;
        }

        index += 1;
      }
    }

    if (newlineIndex < 0) break;
    lineStart = newlineIndex + 1;
  }

  return { hasComment, mask: mask.join('') };
}

export function createObsidianSyntaxMask(markdown: string): string {
  return scanObsidianSyntax(markdown).mask;
}

function findUnescapedPipe(value: string): number {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] !== '|') continue;
    let backslashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
      backslashCount += 1;
    }
    if (backslashCount % 2 === 0) return index;
  }
  return -1;
}

function isEscapedAt(value: string, start: number): boolean {
  let backslashCount = 0;
  for (let index = start - 1; index >= 0 && value[index] === '\\'; index -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

export function parseObsidianWikiTarget(rawTarget: string): ObsidianWikiTarget | null {
  const raw = rawTarget.trim();
  if (!raw) return null;

  const pipeIndex = findUnescapedPipe(raw);
  const target = (pipeIndex >= 0 ? raw.slice(0, pipeIndex) : raw).trim();
  const aliasValue = pipeIndex >= 0 ? raw.slice(pipeIndex + 1).trim().replace(/\\\|/g, '|') : '';
  if (!target) return null;

  const hashIndex = target.indexOf('#');
  const path = (hashIndex >= 0 ? target.slice(0, hashIndex) : target).trim();
  const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1).trim() : '';

  return {
    alias: aliasValue || null,
    blockId: fragment.startsWith('^') && fragment.length > 1 ? fragment.slice(1) : null,
    heading: fragment && !fragment.startsWith('^') ? fragment : null,
    path,
    raw,
    target,
  };
}

export function getObsidianWikiDisplayLabel(target: ObsidianWikiTarget): string {
  if (target.alias) return target.alias;
  if (!target.path && target.heading) return target.heading;
  if (!target.path && target.blockId) return target.blockId;

  const fileName = target.path.split('/').filter(Boolean).pop() || target.path;
  return fileName.replace(/\.(?:md|markdown)$/i, '') || target.target;
}

export function parseObsidianWikiLinks(markdown: string): ObsidianWikiLink[] {
  const mask = createObsidianSyntaxMask(markdown);
  const pattern = /(!)?\[\[([^\]\r\n]+)\]\]/g;
  const links: ObsidianWikiLink[] = [];

  for (const match of mask.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (isEscapedAt(markdown, start)) continue;
    const rawInnerStart = start + (match[1] ? 3 : 2);
    const rawInnerEnd = start + match[0].length - 2;
    const parsed = parseObsidianWikiTarget(markdown.slice(rawInnerStart, rawInnerEnd));
    if (!parsed) continue;

    links.push({
      ...parsed,
      embed: Boolean(match[1]),
      end: start + match[0].length,
      start,
    });
  }

  return links;
}

export function parseObsidianCallouts(markdown: string): ObsidianCallout[] {
  const mask = createObsidianSyntaxMask(markdown);
  const pattern = /^(?: {0,3}>[ \t]*)+\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+([^\r\n]*))?[ \t]*$/gm;
  const callouts: ObsidianCallout[] = [];

  for (const match of mask.matchAll(pattern)) {
    const start = match.index ?? 0;
    callouts.push({
      end: start + match[0].length,
      fold: match[2] === '+' || match[2] === '-' ? match[2] : null,
      start,
      title: match[3]?.trim() || null,
      type: match[1].toLowerCase(),
    });
  }

  return callouts;
}

export function parseObsidianBlockIds(markdown: string): ObsidianBlockId[] {
  const mask = createObsidianSyntaxMask(markdown);
  const pattern = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/gm;
  const blockIds: ObsidianBlockId[] = [];

  for (const match of mask.matchAll(pattern)) {
    const fullStart = match.index ?? 0;
    const caretOffset = match[0].indexOf('^');
    const start = fullStart + Math.max(0, caretOffset);
    blockIds.push({
      end: fullStart + match[0].length,
      id: match[1],
      start,
    });
  }

  return blockIds;
}

export function hasObsidianRichEditorUnsupportedSyntax(markdown: string): boolean {
  const trimmed = markdown.trimStart();
  if (/^---[ \t]*\r?\n/.test(trimmed)) return true;
  if (parseObsidianWikiLinks(markdown).length > 0) return true;
  if (parseObsidianCallouts(markdown).length > 0) return true;
  if (parseObsidianBlockIds(markdown).length > 0) return true;

  const { hasComment, mask } = scanObsidianSyntax(markdown);
  return (
    hasComment ||
    /==[^=\r\n]+==/.test(mask) ||
    /(?:^|\s)\^\[[^\]\r\n]+\]/m.test(mask) ||
    /\[\^[^\]\r\n]+\]/.test(mask) ||
    /^\[\^[^\]\r\n]+\]:/m.test(mask)
  );
}
