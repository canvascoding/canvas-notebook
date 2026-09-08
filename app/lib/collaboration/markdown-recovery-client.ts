'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useTranslations } from 'next-intl';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { writeWorkspaceFile } from '@/app/lib/files/client';
import { createRichMarkdownManager, restoreRichMarkdownFinalLineEnding } from '@/app/lib/markdown/rich-markdown-codec';
import { readRichDocumentJson } from './rich-document';
import { preserveCollaborationDocumentRecovery, type CollaborationDocument } from './client';
import { isRichTextCollaborationRepresentation } from './types';

/** Serialize the committed backup, never a render's possibly stale Markdown prop. */
function recoveryMarkdown(snapshot: Uint8Array, representation: string): string {
  const saved = new Y.Doc();
  try {
    Y.applyUpdate(saved, snapshot);
    if (representation === 'plain_text') return saved.getText('content').toString();
    if (!isRichTextCollaborationRepresentation(representation)) throw new Error('Unsupported recovery format.');
    return saved.getText('frontmatter').toString() + restoreRichMarkdownFinalLineEnding(
      saved.getText('bodyFinalLineEnding').toString(), createRichMarkdownManager().serialize(readRichDocumentJson(saved)),
    );
  } finally { saved.destroy(); }
}

function matchesSnapshot(doc: Y.Doc, snapshot: Uint8Array): boolean {
  const current = Y.encodeStateAsUpdate(doc);
  return snapshot.length === current.length && snapshot.every((value, index) => value === current[index]);
}

/** A recovery operation belongs to one open document, including while requests are pending. */
export function useMarkdownRecoveryCopy(collaboration: CollaborationDocument | null, filePath?: string) {
  const t = useTranslations('notebook.editorModes');
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const file = useFileStore((state) => state.currentFile);
  const fileWorkspaceId = useFileStore((state) => state.currentFileWorkspaceId);
  const treeGeneration = useFileStore((state) => state.treeGeneration);
  const doc = collaboration?.doc;
  const documentId = collaboration?.session?.documentId;
  const generation = collaboration?.session?.lifecycleGeneration;
  const representation = collaboration?.session?.representation;
  const permission = collaboration?.session?.permission;
  const denied = collaboration?.connection === 'denied';
  const registryKey = collaboration?.registryKey;
  const editorIdentity = file?.editorIdentity;
  const lifetime = useMemo(() => ({ doc, documentId, generation, representation, permission, denied, registryKey,
    workspaceId, fileWorkspaceId, filePath, openedPath: file?.path, editorIdentity, treeGeneration }), [doc, documentId, generation, representation, permission, denied, registryKey,
    workspaceId, fileWorkspaceId, filePath, file?.path, editorIdentity, treeGeneration]);
  const active = useRef<{ lifetime: typeof lifetime; running: boolean } | null>(null);
  const [state, setState] = useState<{ lifetime: typeof lifetime; busy: boolean; error: string | null; copyPath: string | null } | null>(null);
  if (state && state.lifetime !== lifetime) setState(null);
  useLayoutEffect(() => {
    active.current = { lifetime, running: false };
    return () => { if (active.current?.lifetime === lifetime) active.current = null; };
  }, [lifetime]);
  const eligible = Boolean(doc && !doc.isDestroyed && !denied && workspaceId && fileWorkspaceId === workspaceId
    && filePath && file?.path === filePath && file.collaboration?.crdtCapable
    && (!file.collaboration.document?.id || file.collaboration.document.id === documentId)
    && registryKey?.startsWith(`${workspaceId}\0`) && permission === 'write' && representation);
  const isCurrent = () => {
    const current = useFileStore.getState();
    return eligible && active.current?.lifetime === lifetime && !doc!.isDestroyed
      && useWorkspaceStore.getState().activeWorkspaceId === workspaceId
      && current.currentFileWorkspaceId === workspaceId && current.treeGeneration === treeGeneration
      && current.currentFile?.path === filePath && current.currentFile?.editorIdentity === editorIdentity
      && current.currentFile?.collaboration?.crdtCapable
      && (!current.currentFile.collaboration.document?.id || current.currentFile.collaboration.document.id === documentId);
  };
  const createCopy = async () => {
    if (!isCurrent() || active.current?.running || !collaboration || !doc || !filePath || !workspaceId || !representation) return;
    active.current!.running = true;
    setState({ lifetime, busy: true, error: null, copyPath: null });
    const { openFileRequestId, fileLoadRequestId } = useFileStore.getState();
    const noNewNavigation = () => isCurrent() && useFileStore.getState().openFileRequestId === openFileRequestId
      && useFileStore.getState().fileLoadRequestId === fileLoadRequestId;
    try {
      const snapshot = await preserveCollaborationDocumentRecovery(collaboration);
      if (!noNewNavigation()) return;
      if (!matchesSnapshot(doc, snapshot)) throw new Error(t('recoveryChanged'));
      const content = recoveryMarkdown(snapshot, representation);
      const copyPath = filePath.replace(/(\.[^/.]+)?$/u, `.recovered-${crypto.randomUUID()}$1`);
      await writeWorkspaceFile(copyPath, content, { workspaceId, expectedSha256: null, baseRevisionId: null });
      if (!noNewNavigation()) return;
      if (!matchesSnapshot(doc, snapshot)) {
        setState({ lifetime, busy: false, error: null, copyPath });
        return;
      }
      // The store fences subsequent navigation and preserves the original again before closing it.
      const opened = await useFileStore.getState().revealAndLoadFile(copyPath, { workspaceId });
      if (opened.status === 'failed') throw new Error(opened.error);
    } catch (failure) {
      if (isCurrent()) setState({ lifetime, busy: false, error: failure instanceof Error ? failure.message : String(failure), copyPath: null });
    } finally {
      if (active.current?.lifetime === lifetime) {
        active.current.running = false;
        setState((previous) => previous?.lifetime === lifetime ? { ...previous, busy: false } : previous);
      }
    }
  };
  const visible = state?.lifetime === lifetime ? state : null;
  return { actionScope: lifetime, isCurrent, canCreate: eligible, createCopy, busy: visible?.busy ?? false,
    error: visible?.error ?? null, copyPath: visible?.copyPath ?? null };
}
