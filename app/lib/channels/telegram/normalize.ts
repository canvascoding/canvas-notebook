const TELEGRAM_MAX_LENGTH = 4000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function sanitizeTelegramHref(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;

  const withoutOuterPipes = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '');
  const cells = withoutOuterPipes.split('|').map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  if (!cells) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function buildTelegramTableBullets(headers: string[], rows: string[][]): string[] {
  const cleanHeaders = headers.map((header, index) => header.replace(/\s+/g, ' ').trim() || `Spalte ${index + 1}`);

  return rows
    .map((row) => {
      const values = cleanHeaders
        .map((header, index) => {
          const value = (row[index] ?? '').replace(/\s+/g, ' ').trim();
          return value ? `${header}: ${value}` : '';
        })
        .filter(Boolean);

      return values.length > 0 ? `• ${values.join('; ')}` : '';
    })
    .filter(Boolean);
}

function normalizeMarkdownForTelegram(markdown: string): string {
  const lines = markdown.split('\n');
  const normalized: string[] = [];
  let inFencedCodeBlock = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line.trimStart().startsWith('```')) {
      inFencedCodeBlock = !inFencedCodeBlock;
      normalized.push(line);
      continue;
    }

    if (inFencedCodeBlock) {
      normalized.push(line);
      continue;
    }

    const tableHeaders = splitMarkdownTableRow(line);
    const nextLine = lines[index + 1];
    if (tableHeaders && nextLine && isMarkdownTableSeparator(nextLine)) {
      const rows: string[][] = [];
      let tableEndIndex = index + 2;

      while (tableEndIndex < lines.length) {
        const row = splitMarkdownTableRow(lines[tableEndIndex]);
        if (!row || isMarkdownTableSeparator(lines[tableEndIndex])) {
          break;
        }

        rows.push(row);
        tableEndIndex++;
      }

      if (rows.length > 0) {
        normalized.push(...buildTelegramTableBullets(tableHeaders, rows));
        index = tableEndIndex - 1;
        continue;
      }
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      normalized.push(`**${heading[2].trim()}**`);
      continue;
    }

    const unorderedListItem = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (unorderedListItem) {
      normalized.push(`${unorderedListItem[1]}• ${unorderedListItem[2]}`);
      continue;
    }

    normalized.push(line);
  }

  return normalized.join('\n');
}

export function markdownToTelegramHtml(markdown: string): string {
  let html = escapeHtml(normalizeMarkdownForTelegram(markdown));

  html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const sanitizedHref = sanitizeTelegramHref(href.replace(/&amp;/g, '&'));
    if (!sanitizedHref) return label;
    return `<a href="${escapeAttribute(sanitizedHref)}">${label}</a>`;
  });

  return html;
}

export function chunkTelegramMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = -1;

    const paragraphBreak = remaining.lastIndexOf('\n\n', maxLength);
    if (paragraphBreak > maxLength * 0.3) {
      splitIndex = paragraphBreak + 2;
    }

    if (splitIndex === -1) {
      const lineBreak = remaining.lastIndexOf('\n', maxLength);
      if (lineBreak > maxLength * 0.3) {
        splitIndex = lineBreak + 1;
      }
    }

    if (splitIndex === -1) {
      const sentenceEnd = Math.max(
        remaining.lastIndexOf('. ', maxLength),
        remaining.lastIndexOf('! ', maxLength),
        remaining.lastIndexOf('? ', maxLength),
      );
      if (sentenceEnd > maxLength * 0.3) {
        splitIndex = sentenceEnd + 2;
      }
    }

    if (splitIndex === -1) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return chunks;
}
