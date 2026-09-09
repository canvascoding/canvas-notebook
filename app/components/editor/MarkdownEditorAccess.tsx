'use client';

import { createContext, useContext } from 'react';

/** UI capabilities only; the collaboration and asset endpoints enforce access. */
export type MarkdownEditorAccess =
  | { workspace: true }
  | { workspace: false; resolveImage: (source: string, filePath?: string) => string | null };

export const WORKSPACE_MARKDOWN_ACCESS: MarkdownEditorAccess = { workspace: true };
export const MarkdownEditorAccessContext = createContext<MarkdownEditorAccess>(WORKSPACE_MARKDOWN_ACCESS);
export const useMarkdownEditorAccess = () => useContext(MarkdownEditorAccessContext);
