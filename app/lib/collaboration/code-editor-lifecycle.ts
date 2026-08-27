export type CodeEditorLifecycleKeyInput = {
  workspaceId: string | null;
  path: string | undefined;
  collaborationRequested: boolean;
  collaborationRegistryKey: string | null;
  collaborationBindingReady: boolean;
};

/**
 * CodeMirror view plugins retain their configuration for the lifetime of an
 * EditorView. A yCollab plugin therefore cannot safely be rebound from a
 * draft-backed view to another Y.Text through a regular reconfigure effect.
 */
export function getCodeEditorLifecycleKey(input: CodeEditorLifecycleKeyInput): string {
  if (
    input.collaborationRequested
    && input.collaborationBindingReady
    && input.collaborationRegistryKey
  ) {
    return `collaboration\0${input.collaborationRegistryKey}`;
  }

  const documentKey = `${input.workspaceId || 'workspace-pending'}\0${input.path || 'document-pending'}`;
  return `${input.collaborationRequested ? 'collaboration-pending' : 'document'}\0${documentKey}`;
}
