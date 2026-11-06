// Ordinary editor features, local persistence and peer/recovery behavior. No
// document-review fixture or file-operation Undo suite belongs to this profile.
export const regularCollaborationFiles = [
  'editor-block-command-menu.spec.ts', 'editor-empty-quote.spec.ts',
  'editor-first-session-recovery.spec.ts', 'editor-focus-width.spec.ts',
  'editor-image-controls.spec.ts', 'editor-markdown-insertion.spec.ts',
  'editor-mobile-block-moves.spec.ts', 'editor-mode-position.spec.ts',
  'editor-selection-menu.spec.ts', 'editor-structure-lifecycle.spec.ts',
  'editor-table-menu.spec.ts', 'pdf-viewer-layers.spec.ts',
  'editor-formatting-syntax.spec.ts', 'editor-url-paste.spec.ts',
  'file-live-collaboration.spec.ts', 'editor-offline-collaboration.spec.ts',
  'file-create-confirmation.spec.ts',
  'file-delete-external-autolinks.spec.ts',
];

export const deferredReviewAndUndoFiles = [
  '**/file-version-center*.spec.ts', '**/document-review-production.spec.ts',
  '**/editor-agent-review-lifecycle.spec.ts', '**/excalidraw-review-disabled.spec.ts',
  '**/*undo*.spec.ts',
];
