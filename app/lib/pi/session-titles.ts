export const DEFAULT_SESSION_TITLE = 'New session';
export const DEFAULT_PI_SESSION_TITLE = 'New PI Chat';

const LEGACY_LOCALIZED_AUTOMATIC_TITLES = [
  'New chat',
  'Neuer Chat',
];

const AUTOMATIC_SESSION_TITLES = new Set([
  '',
  DEFAULT_SESSION_TITLE,
  DEFAULT_PI_SESSION_TITLE,
  ...LEGACY_LOCALIZED_AUTOMATIC_TITLES,
]);

export function isAutomaticSessionTitle(value: string | null | undefined): boolean {
  if (typeof value !== 'string') {
    return true;
  }

  return AUTOMATIC_SESSION_TITLES.has(value.trim());
}

export function getSessionDisplayTitle(
  title: string | null | undefined,
  fallbackTitle: string,
): string {
  if (!title || isAutomaticSessionTitle(title)) {
    return fallbackTitle;
  }

  return title.trim();
}
