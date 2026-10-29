import type { WorkspaceLinkReadIndex } from './workspace-document-link-index-contract';

/** Older cached responses remain conservative until the reader refreshes them. */
export function workspaceLinkIndexDiagnostics(index: WorkspaceLinkReadIndex): NonNullable<WorkspaceLinkReadIndex['diagnostics']> {
  return index.diagnostics ?? { sourcesComplete: index.coverage.complete,
    sourceGaps: index.omittedDocuments.map(item => ({ code: item.reason, path: item.path })),
    metadataErrors: [], htmlSources: [] };
}
