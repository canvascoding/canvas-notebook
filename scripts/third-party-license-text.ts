export function decodeBasicHtmlEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

export function extractCopyrightNotices(
  ...texts: Array<string | null | undefined>
): string[] {
  const notices = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const line of text.split('\n')) {
      const normalized = line.trim().replace(/^[*#/\s-]+/u, '').trim();
      const containsAttributionMarker = /\bcopyright\b|\(c\)|©/iu.test(normalized);
      const isLicenseBoilerplate = (
        /\bcopyright (?:holder|owner|notice|law|laws|license|permission|statement|doctrine|treaty|interest|ownership)\b/iu.test(normalized)
        || /\bcopyright and (?:related|similar) rights\b/iu.test(normalized)
        || /\b(?:authors?|copyright holders?)\b.*\b(?:liable|liability|claim|damage|warranty)\b/iu.test(normalized)
        || /\b(?:retain|remove|reproduce|publish|include|provided that|add|authorized by).*\bcopyright\b/iu.test(normalized)
        || /\b(?:copyright|patent|trademark),?\s+(?:and\s+)?attribution notices\b/iu.test(normalized)
        || /\bcopyright\b.*\b(?:infringement|fair use|public license|covered work)\b/iu.test(normalized)
        || /^(?:this software is provided|noninfringement\b|\(including copyright notices)/iu.test(normalized)
      );
      if (
        containsAttributionMarker
        && !isLicenseBoilerplate
        && normalized.length <= 500
        && !/copyright\s*\[[^\]]+\]/iu.test(normalized)
        && !/<copyright holder>/iu.test(normalized)
      ) {
        notices.add(normalized);
      }
    }
  }
  return [...notices].sort((left, right) => left.localeCompare(right));
}
