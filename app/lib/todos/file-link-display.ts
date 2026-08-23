import { parseCanvasMarkdownDocument } from '@/app/lib/markdown/obsidian-metadata';

export function getTodoFileFallbackTitle(workspacePath: string): string {
  const fileName = workspacePath.split('/').filter(Boolean).at(-1) || workspacePath;
  const extensionIndex = fileName.lastIndexOf('.');

  return extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
}

export function getTodoFileMetadataTitle(content: string): string | null {
  return parseCanvasMarkdownDocument(content).frontmatter?.title ?? null;
}

export function buildTodoFileNotebookHref(input: {
  path: string;
  workspaceId: string | null;
}): string {
  const params = new URLSearchParams({ path: input.path });
  if (input.workspaceId?.trim()) params.set('workspaceId', input.workspaceId.trim());
  return `/notebook?${params.toString()}`;
}
