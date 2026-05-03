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

function normalizeMarkdownForTelegram(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        return `**${heading[2].trim()}**`;
      }

      const unorderedListItem = line.match(/^(\s*)[-*]\s+(.+)$/);
      if (unorderedListItem) {
        return `${unorderedListItem[1]}• ${unorderedListItem[2]}`;
      }

      return line;
    })
    .join('\n');
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
