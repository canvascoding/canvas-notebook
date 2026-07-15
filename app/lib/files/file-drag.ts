import { compactWorkspaceSelection, createWorkspaceMovePlan } from './operation-flows';

export const WORKSPACE_FILE_DRAG_TYPE = 'application/x-canvas-workspace-paths';

export interface WorkspaceFileDragPayload {
  workspaceId: string | null;
  paths: string[];
}

export type WorkspaceFileDropInvalidReason =
  | 'empty-selection'
  | 'protected-path'
  | 'move-into-self'
  | 'same-location';

export type WorkspaceFileDropValidation =
  | { valid: true }
  | { valid: false; reason: WorkspaceFileDropInvalidReason };

export function encodeWorkspaceFileDrag(payload: WorkspaceFileDragPayload): string {
  return JSON.stringify({
    workspaceId: payload.workspaceId,
    paths: compactWorkspaceSelection(payload.paths),
  });
}

export function decodeWorkspaceFileDrag(value: string): WorkspaceFileDragPayload | null {
  try {
    const parsed = JSON.parse(value) as { workspaceId?: unknown; paths?: unknown };
    if (parsed.workspaceId !== null && typeof parsed.workspaceId !== 'string') return null;
    if (!Array.isArray(parsed.paths) || !parsed.paths.every((path) => typeof path === 'string')) return null;
    const paths = compactWorkspaceSelection(parsed.paths);
    if (paths.length === 0) return null;
    return {
      workspaceId: parsed.workspaceId ?? null,
      paths,
    };
  } catch {
    return null;
  }
}

export function hasWorkspaceFileDragType(types: Iterable<string>): boolean {
  return Array.from(types).includes(WORKSPACE_FILE_DRAG_TYPE);
}

export function getWorkspaceFileDragPaths(
  sourcePath: string,
  selectedPaths: Iterable<string>,
): string[] {
  const selection = new Set(selectedPaths);
  return selection.has(sourcePath)
    ? compactWorkspaceSelection(selection)
    : [sourcePath];
}

export function validateWorkspaceFileDrop(
  paths: Iterable<string>,
  targetDir: string,
): WorkspaceFileDropValidation {
  const plan = createWorkspaceMovePlan(paths, targetDir);
  if (plan.sourcePaths.length === 0) return { valid: false, reason: 'empty-selection' };
  if (plan.protectedPaths.length > 0) return { valid: false, reason: 'protected-path' };
  if (plan.invalidSourcePath) return { valid: false, reason: 'move-into-self' };
  if (plan.entries.every(({ sourcePath, destinationPath }) => sourcePath === destinationPath)) {
    return { valid: false, reason: 'same-location' };
  }
  return { valid: true };
}
