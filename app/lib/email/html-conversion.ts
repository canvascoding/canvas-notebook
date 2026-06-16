export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function htmlToPlainText(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/giu, '')
    .replace(/<style\b[\s\S]*?<\/style>/giu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p>/giu, '\n\n')
    .replace(/<\/li>/giu, '\n')
    .replace(/<li[^>]*>/giu, '- ')
    .replace(/<\/(?:div|blockquote|h[1-6])>/giu, '\n\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/[ \t]*\n[ \t]*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[ \t]+/gu, ' ')
    .trim();
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
