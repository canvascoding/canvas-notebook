import type { KatexOptions } from 'katex';
import type { Options as RehypeKatexOptions } from 'rehype-katex';

const SHARED_KATEX_OPTIONS = {
  maxExpand: 1_000,
  maxSize: 20,
  output: 'htmlAndMathml',
  strict: 'warn',
  trust: false,
} as const;

/** Safe defaults for LaTeX originating from workspace files or agent output. */
export const CANVAS_KATEX_OPTIONS = {
  ...SHARED_KATEX_OPTIONS,
  throwOnError: false,
} satisfies KatexOptions;

/** rehype-katex always renders parse errors instead of throwing. */
export const CANVAS_REHYPE_KATEX_OPTIONS = {
  ...SHARED_KATEX_OPTIONS,
} satisfies RehypeKatexOptions;
