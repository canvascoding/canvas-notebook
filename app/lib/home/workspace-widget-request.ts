export const HOME_WIDGET_NAMES = ['emails', 'todos', 'automation', 'studio'] as const;

export type HomeWidgetName = typeof HOME_WIDGET_NAMES[number];

export function isHomeWidgetName(value: unknown): value is HomeWidgetName {
  return typeof value === 'string' && HOME_WIDGET_NAMES.some((name) => name === value);
}

export function parseHomeWidgetSelection(
  value: string | null,
  fallback: readonly HomeWidgetName[],
): HomeWidgetName[] | null {
  if (value === null) return [...fallback];
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !isHomeWidgetName(entry))) return null;
  return HOME_WIDGET_NAMES.filter((name) => entries.includes(name));
}

export function claimHomeWidgetRefreshToken(
  seen: Set<string>,
  key: string | null,
  maxEntries = 200,
): boolean {
  if (!key || seen.has(key)) return false;
  seen.add(key);
  while (seen.size > maxEntries) {
    const oldest = seen.values().next().value;
    if (typeof oldest !== 'string') break;
    seen.delete(oldest);
  }
  return true;
}
