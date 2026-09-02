import type { PiThinkingLevel } from '@/app/lib/pi/config';

const MEMORY_REVIEW_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function diagnosticCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value.trim().replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || null;
}

/** Use the cheapest reasoning mode that the configured memory model actually supports. */
export function selectMemoryReviewThinkingLevel(
  supportedLevels: readonly PiThinkingLevel[],
): PiThinkingLevel {
  const supported = new Set(supportedLevels);
  const selected = MEMORY_REVIEW_THINKING_LEVELS.find((level) => supported.has(level));
  if (!selected) {
    throw new Error('The configured memory manager model exposes no supported thinking level.');
  }
  return selected;
}

/** Preserve stable provider/policy codes instead of collapsing every failure to its class name. */
export function memoryReviewErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = diagnosticCode((error as { code?: unknown }).code);
    if (code) return code;
  }
  if (error instanceof Error) {
    const name = diagnosticCode(error.name);
    if (name) return name;
  }
  return 'memory_review_failed';
}
