import {
  createObsidianSyntaxMask,
  parseObsidianBlockIds,
  parseObsidianWikiTarget,
} from './obsidian-flavored-markdown';

type HeadingLocation = {
  depth: number;
  end: number;
  start: number;
  text: string;
};

function cleanHeading(value: string): string {
  return value
    .replace(/[ \t]+#+[ \t]*$/u, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_~`]/gu, '')
    .trim();
}

function collectHeadingLocations(markdown: string): HeadingLocation[] {
  const mask = createObsidianSyntaxMask(markdown);
  const lines: Array<{ end: number; mask: string; source: string; start: number }> = [];
  let start = 0;
  while (start <= markdown.length) {
    const newline = markdown.indexOf('\n', start);
    const end = newline >= 0 ? newline : markdown.length;
    lines.push({
      end: newline >= 0 ? newline + 1 : end,
      mask: mask.slice(start, end).replace(/\r$/u, ''),
      source: markdown.slice(start, end).replace(/\r$/u, ''),
      start,
    });
    if (newline < 0) break;
    start = newline + 1;
  }

  const headings: HeadingLocation[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const atx = line.mask.match(/^ {0,3}(#{1,6})[ \t]+/u);
    if (atx) {
      const text = cleanHeading(line.source.slice(atx[0].length));
      if (text) headings.push({ depth: atx[1].length, end: line.end, start: line.start, text });
      continue;
    }

    const underline = lines[index + 1]?.mask.match(/^ {0,3}(=+|-+)[ \t]*$/u);
    if (line.source.trim() && underline) {
      const text = cleanHeading(line.source);
      if (text) {
        headings.push({
          depth: underline[1][0] === '=' ? 1 : 2,
          end: lines[index + 1].end,
          start: line.start,
          text,
        });
      }
      index += 1;
    }
  }
  return headings;
}

function selectHeading(markdown: string, heading: string): string | null {
  const headings = collectHeadingLocations(markdown);
  const wanted = cleanHeading(heading).toLocaleLowerCase();
  const index = headings.findIndex((candidate) => candidate.text.toLocaleLowerCase() === wanted);
  if (index < 0) return null;
  const current = headings[index];
  const next = headings.slice(index + 1).find((candidate) => candidate.depth <= current.depth);
  return markdown.slice(current.start, next?.start ?? markdown.length).trim();
}

function selectBlock(markdown: string, blockId: string): string | null {
  const block = parseObsidianBlockIds(markdown).find((candidate) => candidate.id === blockId);
  if (!block) return null;
  const before = markdown.lastIndexOf('\n\n', block.start);
  const after = markdown.indexOf('\n\n', block.end);
  return markdown
    .slice(before >= 0 ? before + 2 : 0, after >= 0 ? after : markdown.length)
    .replace(new RegExp(`(?:^|[ \\t])\\^${blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'mu'), '')
    .trim();
}

export function selectObsidianEmbedContent(markdown: string, rawTarget: string): string {
  const target = parseObsidianWikiTarget(rawTarget);
  if (!target) return markdown;
  if (target.blockId) return selectBlock(markdown, target.blockId) ?? markdown;
  if (target.heading) return selectHeading(markdown, target.heading) ?? markdown;
  return markdown;
}
