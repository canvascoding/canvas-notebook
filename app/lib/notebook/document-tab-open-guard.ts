export type NotebookDocumentOpenGuardInput = {
  path: string;
  workspaceId: string | null;
};

export type NotebookDocumentOpenGuardResult =
  | { allowed: true }
  | { allowed: false; error: string };

type NotebookDocumentOpenGuard = (
  input: NotebookDocumentOpenGuardInput,
) => NotebookDocumentOpenGuardResult;

let activeGuard: NotebookDocumentOpenGuard | null = null;

export function registerNotebookDocumentOpenGuard(guard: NotebookDocumentOpenGuard) {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

export function checkNotebookDocumentOpen(
  input: NotebookDocumentOpenGuardInput,
): NotebookDocumentOpenGuardResult {
  return activeGuard?.(input) ?? { allowed: true };
}
