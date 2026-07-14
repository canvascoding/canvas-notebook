'use client';

import { useFileStore } from '@/app/store/file-store';

import type { ObsidianLinkResolution } from './obsidian-link-resolver';
import { requestWorkspaceMarkdownLocation } from './workspace-markdown-navigation';
import {
  loadWorkspaceLinkIndex,
  resolveWorkspaceLinkFromIndex,
} from './workspace-link-index-client';

export type WorkspaceMarkdownOpenResult = {
  error?: string;
  path?: string;
  resolution?: ObsidianLinkResolution | null;
  status: 'ambiguous' | 'failed' | 'missing' | 'opened' | 'superseded';
};

export async function openWorkspaceMarkdownPath(input: {
  blockId?: string | null;
  heading?: string | null;
  path: string;
  workspaceId: string | null;
}): Promise<WorkspaceMarkdownOpenResult> {
  if (!input.workspaceId) {
    return { status: 'failed', error: 'Workspace context is not ready', path: input.path };
  }

  const result = await useFileStore.getState().revealAndLoadFile(input.path, {
    workspaceId: input.workspaceId,
  });
  if (result.status === 'opened') {
    if (input.blockId || input.heading) {
      requestWorkspaceMarkdownLocation({
        blockId: input.blockId ?? null,
        heading: input.heading ?? null,
        path: result.path,
      });
    }
    return { status: 'opened', path: result.path };
  }
  if (result.status === 'superseded') return { status: 'superseded', path: result.path };
  return { status: 'failed', error: result.error, path: result.path };
}

export async function openWorkspaceMarkdownTarget(input: {
  sourcePath?: string | null;
  target: string;
  workspaceId: string | null;
}): Promise<WorkspaceMarkdownOpenResult> {
  if (!input.workspaceId) {
    return { status: 'failed', error: 'Workspace context is not ready' };
  }

  try {
    const index = await loadWorkspaceLinkIndex(input.workspaceId);
    const resolution = resolveWorkspaceLinkFromIndex(input.target, index, input.sourcePath);
    if (!resolution) {
      return { status: 'missing', error: `Document not found: ${input.target}`, resolution };
    }
    if (resolution.status !== 'resolved' || !resolution.path) {
      const status = resolution.status === 'ambiguous' ? 'ambiguous' : 'missing';
      return {
        status,
        error: status === 'ambiguous'
          ? `Ambiguous link: ${resolution.candidates.join(', ')}`
          : `Document not found: ${resolution.target.path || input.target}`,
        resolution,
      };
    }

    const result = await openWorkspaceMarkdownPath({
      blockId: resolution.blockId,
      heading: resolution.heading,
      path: resolution.path,
      workspaceId: input.workspaceId,
    });
    return { ...result, resolution };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Document link could not be opened',
    };
  }
}
