import { LocalMarkdownDocument } from './local-markdown-document';
import { LocalMarkdownOwnerCore } from './local-markdown-owner-core';
import type { MarkdownFrontmatterMode } from '../markdown/editor-document';

/** Web keeps its schema-backed document behind the portable owner protocol. */
export class LocalMarkdownOwner extends LocalMarkdownOwnerCore<LocalMarkdownDocument> {
  constructor(scope: string, value: string, enabled: boolean, frontmatter: MarkdownFrontmatterMode, readOnly: boolean) {
    super(scope, value, enabled, frontmatter, readOnly,
      ({ markdown, frontmatter, isWritable }) => new LocalMarkdownDocument(markdown, frontmatter, isWritable));
  }
}
