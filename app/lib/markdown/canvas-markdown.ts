import type { KatexOptions } from 'katex';
import type { Options as ReactMarkdownOptions } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex, { type Options as RehypeKatexOptions } from 'rehype-katex';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { rehypeInlineColorSwatch } from './rehype-inline-color-swatch';
import { remarkObsidianFlavoredMarkdown } from './remark-obsidian-flavored-markdown';

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

export const CANVAS_MARKDOWN_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions['remarkPlugins']> = [
  remarkGfm,
  [remarkFrontmatter, ['yaml']],
  [remarkMath, { singleDollarTextMath: true }],
  remarkObsidianFlavoredMarkdown,
];

export const CANVAS_MARKDOWN_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions['rehypePlugins']> = [
  rehypeInlineColorSwatch,
  [rehypeKatex, CANVAS_REHYPE_KATEX_OPTIONS],
  rehypeHighlight,
];
