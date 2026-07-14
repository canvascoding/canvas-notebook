'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  hasPendingFileReferenceValidationRetry,
  subscribeToFileReferenceValidationInvalidation,
  validateFileReference,
  type FileReferenceValidationResult,
} from '@/app/lib/chat/validate-file-paths';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/constants';

type ValidationSnapshot = {
  key: string;
  results: Map<string, FileReferenceValidationResult>;
};

const EMPTY_RESULTS = new Map<string, FileReferenceValidationResult>();

export function useChatFileReferenceValidation(pathKey: string) {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const fileTree = useFileStore((state) => state.fileTree);
  const fileTreeWorkspaceId = useFileStore((state) => state.fileTreeWorkspaceId);
  const [validationVersion, setValidationVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<ValidationSnapshot | null>(null);
  const paths = useMemo(() => pathKey.split('\n').filter(Boolean), [pathKey]);
  const workspaceKey = activeWorkspaceId ?? LEGACY_PERSONAL_WORKSPACE_ID;
  const validationKey = `${workspaceKey}\0${pathKey}`;

  useEffect(() => subscribeToFileReferenceValidationInvalidation((event) => {
    if (event.workspaceId !== workspaceKey) return;
    if (event.path && !paths.some((path) => (
      path === event.path
      || path.startsWith(`${event.path}/`)
      || event.path?.startsWith(`${path}/`)
    ))) return;
    setValidationVersion((version) => version + 1);
  }), [paths, workspaceKey]);

  useEffect(() => {
    if (paths.length === 0) return;

    let ignore = false;
    void Promise.all(paths.map(async (path) => (
      [path, await validateFileReference(path, fileTree, { fileTreeWorkspaceId })] as const
    ))).then((entries) => {
      if (ignore) return;
      const settledEntries = entries.filter(([, result]) => (
        result.type !== 'missing' || !hasPendingFileReferenceValidationRetry(result.path)
      ));
      setSnapshot({
        key: validationKey,
        results: new Map(settledEntries),
      });
    });

    return () => {
      ignore = true;
    };
  }, [fileTree, fileTreeWorkspaceId, paths, validationKey, validationVersion]);

  const results = snapshot?.key === validationKey ? snapshot.results : EMPTY_RESULTS;
  return {
    isResolving: paths.some((path) => !results.has(path)),
    results,
  };
}
