import type { Options as ReactMarkdownOptions } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { CANVAS_REHYPE_KATEX_OPTIONS } from './katex-options';
import { rehypeInlineColorSwatch } from './rehype-inline-color-swatch';
import { rehypeHeadingAnchors } from './rehype-heading-anchors';
import { remarkObsidianFlavoredMarkdown } from './remark-obsidian-flavored-markdown';
import { remarkPortableImages } from './remark-portable-images';

export { CANVAS_KATEX_OPTIONS, CANVAS_REHYPE_KATEX_OPTIONS } from './katex-options';

export const CANVAS_MARKDOWN_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions['remarkPlugins']> = [
  remarkGfm,
  [remarkFrontmatter, ['yaml']],
  [remarkMath, { singleDollarTextMath: true }],
  remarkObsidianFlavoredMarkdown,
  remarkPortableImages,
];

export const CANVAS_MARKDOWN_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions['rehypePlugins']> = [
  rehypeHeadingAnchors,
  rehypeInlineColorSwatch,
  [rehypeKatex, CANVAS_REHYPE_KATEX_OPTIONS],
  rehypeHighlight,
];
