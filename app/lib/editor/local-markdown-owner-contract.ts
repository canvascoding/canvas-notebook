import type { MarkdownFrontmatterMode } from '../markdown/editor-document';

/** Content changes and derived projections have separate controlled-value effects. */
export type LocalMarkdownChangeOrigin = 'source' | 'rich' | 'history' | 'external' | 'projection';
export type LocalMarkdownOwnerSnapshot = { markdown: string };
export type LocalMarkdownOwnerBackendChange = {
  origin: LocalMarkdownChangeOrigin;
  snapshot: LocalMarkdownOwnerSnapshot;
};

/** The owner does not parse Markdown or know how the backend stores history. */
export interface LocalMarkdownOwnerBackend {
  getSnapshot(): LocalMarkdownOwnerSnapshot;
  subscribe(listener: (change: LocalMarkdownOwnerBackendChange) => void): () => void;
  replaceExternal(markdown: string): void;
}

export type LocalMarkdownOwnerBackendFactory<TBackend extends LocalMarkdownOwnerBackend> = (input: {
  scope: string;
  markdown: string;
  frontmatter: MarkdownFrontmatterMode;
  isWritable: () => boolean;
}) => TBackend;
