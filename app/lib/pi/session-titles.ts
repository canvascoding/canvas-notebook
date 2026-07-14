export const DEFAULT_SESSION_TITLE = 'New session';
export const DEFAULT_PI_SESSION_TITLE = 'New PI Chat';
export const SESSION_TITLE_MAX_LENGTH = 48;

export const PI_SESSION_TITLE_GENERATION_STATES = [
  'pending',
  'generating',
  'generated',
  'manual',
  'fallback',
] as const;

export type PiSessionTitleGenerationState = typeof PI_SESSION_TITLE_GENERATION_STATES[number];

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

export function isSessionTitleGenerating(value: string | null | undefined): boolean {
  return value === 'pending' || value === 'generating';
}

function truncateSessionTitle(value: string): string {
  if (value.length <= SESSION_TITLE_MAX_LENGTH) {
    return value;
  }

  return `${value.slice(0, SESSION_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

/**
 * Normalizes a one-line, model-generated title before it reaches the database
 * or UI. This is deliberately shared with the fallback path so both respect
 * the same length and presentation guarantees.
 */
export function normalizeSessionTitle(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value
    .replace(/\s+/gu, ' ')
    .replace(/^(?:title|titel)\s*:\s*/iu, '')
    .trim()
    .replace(/^["'“”„`]+|["'“”„`]+$/gu, '')
    .trim();

  return normalized ? truncateSessionTitle(normalized) : '';
}

export function createSessionTitleFallback(value: string | null | undefined): string {
  return normalizeSessionTitle(value) || DEFAULT_PI_SESSION_TITLE;
}
