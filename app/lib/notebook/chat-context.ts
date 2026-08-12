import type {
  NotebookChatPlacement,
  NotebookRequestActiveSurface,
  NotebookRequestContext,
} from '@/app/lib/chat/types';
import type { NotebookMainSurface } from '@/app/lib/notebook/layout-state';

export type ResolveNotebookChatContextInput = {
  activeDocumentPath: string | null;
  chatPlacement: NotebookChatPlacement;
  mainSurface: NotebookMainSurface;
  openDocumentPaths: string[];
};

export type ResolvedNotebookChatContext = {
  activeFilePath: string | null;
  notebookContext: NotebookRequestContext;
};

function resolveActiveSurface(
  input: ResolveNotebookChatContextInput,
): NotebookRequestActiveSurface | null {
  // Implicit work context exists only when chat and work are genuinely visible
  // side by side. Full-screen and overlay chat deliberately provide no implicit
  // document, browser, or email subject.
  if (input.chatPlacement !== 'side') return null;

  if (input.mainSurface === 'document' && input.activeDocumentPath) {
    return { kind: 'document', path: input.activeDocumentPath };
  }
  if (input.mainSurface === 'browser') return { kind: 'browser' };
  if (input.mainSurface === 'email') return { kind: 'email' };
  return null;
}

export function resolveNotebookChatContext(
  input: ResolveNotebookChatContextInput,
): ResolvedNotebookChatContext {
  const activeSurface = resolveActiveSurface(input);
  return {
    activeFilePath: activeSurface?.kind === 'document' ? activeSurface.path : null,
    notebookContext: {
      activeSurface,
      chatPlacement: input.chatPlacement,
      openDocuments: input.openDocumentPaths.map((path) => ({
        path,
        state: activeSurface?.kind === 'document' && activeSurface.path === path
          ? 'active'
          : 'background',
      })),
    },
  };
}
