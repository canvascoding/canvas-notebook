export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function htmlToPlainText(value: string): string {
  let output = '';
  let index = 0;
  let ignoredTag: 'script' | 'style' | null = null;

  while (index < value.length) {
    const tagStart = value.indexOf('<', index);
    if (tagStart === -1) {
      if (!ignoredTag) output += value.slice(index);
      break;
    }

    if (!ignoredTag) output += value.slice(index, tagStart);
    const tagEnd = value.indexOf('>', tagStart + 1);
    if (tagEnd === -1) {
      if (!ignoredTag) output += value.slice(tagStart);
      break;
    }

    const rawTag = value.slice(tagStart + 1, tagEnd).trim();
    const closing = rawTag.startsWith('/');
    const tagName = rawTag
      .slice(closing ? 1 : 0)
      .trimStart()
      .split(/\s+/u, 1)[0]
      ?.toLowerCase() || '';

    if (ignoredTag) {
      if (closing && tagName === ignoredTag) {
        ignoredTag = null;
      }
      index = tagEnd + 1;
      continue;
    }

    if (!closing && (tagName === 'script' || tagName === 'style')) {
      ignoredTag = tagName;
    } else if (!closing && tagName === 'li') {
      output += '- ';
    } else if (tagName === 'br' || (closing && tagName === 'li') || (closing && tagName === 'tr')) {
      output += '\n';
    } else if (closing && (tagName === 'td' || tagName === 'th')) {
      output += '\t';
    } else if (closing && ['p', 'div', 'blockquote', 'table', 'thead', 'tbody', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
      output += '\n\n';
    } else {
      output += ' ';
    }

    index = tagEnd + 1;
  }

  return decodeEmailHtmlEntities(output)
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\t[ \t]*/gu, '\t')
    .replace(/\t\n/gu, '\n')
    .replace(/[ \t]*\n[ \t]*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/ {2,}/gu, ' ')
    .trim();
}

function decodeEmailHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (entity, rawName: string) => {
    const name = rawName.toLowerCase();
    if (name === '#39' || name === '#x27') return "'";
    if (name.startsWith('#x')) {
      const codePoint = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (name.startsWith('#')) {
      const codePoint = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return namedEntities[name] ?? entity;
  });
}

export function plainTextToEmailHtml(value: string): string {
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return '';

  return normalized
    .split(/\n{2,}/u)
    .map((paragraph) => {
      const lines = paragraph
        .split('\n')
        .map((line) => escapeEmailHtml(line))
        .join('<br>');
      return `<p>${lines}</p>`;
    })
    .join('');
}

export function emailHtmlToPlainTextFallback(html: string, fallback = ''): string {
  const text = htmlToPlainText(html);
  return text || fallback.trim();
}
