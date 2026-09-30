import 'server-only';

import fs from 'node:fs/promises';

import { filesystemFileVersion } from '@/app/lib/filesystem/file-version';
import { resolveExistingWorkspacePath, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import type { WorkspaceFileOperationPreview } from '@/app/lib/markdown/workspace-file-operation-planner';

export type WorkspacePathPhaseProbe = 'before' | 'after' | 'unknown';

type PathState = { exists: false } | { exists: true; version: string };

async function readPathState(path: string, options: WorkspaceFileOperationOptions): Promise<PathState> {
  try {
    const absolutePath = await resolveExistingWorkspacePath(path, options);
    return { exists: true, version: filesystemFileVersion(await fs.stat(absolutePath)) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { exists: false };
    throw error;
  }
}

/** Physical path evidence only. An unreceipted post-state cannot prove collaboration/metadata projections. */
export async function probeWorkspacePathOperation(input: {
  plan: WorkspaceFileOperationPreview;
  sourceOptions: WorkspaceFileOperationOptions;
  destinationOptions: WorkspaceFileOperationOptions;
  /** True only after the journal has a durable path-service receipt. */
  pathReceiptApplied: boolean;
}): Promise<WorkspacePathPhaseProbe> {
  const { plan } = input;
  if (plan.readiness !== 'ready' || plan.pathMappings.length === 0) return 'unknown';
  const selectedSources = new Set(plan.pathMappings.map((mapping) => mapping.sourcePath));
  const selectedDestinations = new Set(plan.pathMappings.map((mapping) => mapping.destinationPath));
  const stateCache = new Map<string, PathState>();
  const state = async (workspaceId: string, path: string): Promise<PathState> => {
    const key = `${workspaceId}\0${path}`;
    const cached = stateCache.get(key);
    if (cached) return cached;
    const options = workspaceId === plan.pathMappings[0].sourceWorkspaceId
      ? input.sourceOptions : input.destinationOptions;
    const result = await readPathState(path, options);
    stateCache.set(key, result);
    return result;
  };

  let before = true;
  let after = input.pathReceiptApplied;
  for (const mapping of plan.pathMappings) {
    const source = await state(mapping.sourceWorkspaceId, mapping.sourcePath);
    const destination = await state(mapping.destinationWorkspaceId, mapping.destinationPath);
    if (!source.exists || source.version !== mapping.sourceIdentity) before = false;
    if (destination.exists && !(plan.kind !== 'copy' && selectedSources.has(mapping.destinationPath)
      && mapping.sourceWorkspaceId === mapping.destinationWorkspaceId)) before = false;
    if (!destination.exists) after = false;
    if (plan.kind !== 'copy' && source.exists && !selectedDestinations.has(mapping.sourcePath)) after = false;
  }
  if (before && !after) return 'before';
  if (after && !before) return 'after';
  return 'unknown';
}

/** Copy one selected root at a time; an unreceipted copy is never treated as committed. */
export async function probeWorkspacePathSelectionOperation(input: {
  plan: WorkspaceFileOperationPreview;
  selection: { sourcePath: string; destinationPath: string };
  sourceOptions: WorkspaceFileOperationOptions;
  destinationOptions: WorkspaceFileOperationOptions;
  pathReceiptApplied: boolean;
}): Promise<WorkspacePathPhaseProbe> {
  if (input.plan.kind !== 'copy') return 'unknown';
  const mappings = input.plan.pathMappings.filter((mapping) =>
    (mapping.sourcePath === input.selection.sourcePath
      || mapping.sourcePath.startsWith(`${input.selection.sourcePath}/`))
    && (mapping.destinationPath === input.selection.destinationPath
      || mapping.destinationPath.startsWith(`${input.selection.destinationPath}/`)));
  if (mappings.length === 0 || !mappings.some((mapping) =>
    mapping.sourcePath === input.selection.sourcePath
      && mapping.destinationPath === input.selection.destinationPath)) return 'unknown';
  return probeWorkspacePathOperation({
    ...input,
    plan: { ...input.plan, pathMappings: mappings },
  });
}
