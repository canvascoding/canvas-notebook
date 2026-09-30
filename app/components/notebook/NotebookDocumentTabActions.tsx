'use client';

import { useState, type ReactNode } from 'react';
import { FileActionsDropdown } from '@/app/components/file-browser/FileActionsDropdown';
import { findNodeInTree } from '@/app/lib/files/tree-utils';
import type { FileNode } from '@/app/lib/files/types';
import { useFileStore } from '@/app/store/file-store';

export function NotebookDocumentTabActions({ path, children, onRevealInExplorer }: {
  path: string;
  children: ReactNode;
  onRevealInExplorer: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ node: FileNode; x: number; y: number } | null>(null);

  return (
    <>
      <div className="contents" onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const { fileTree, currentFile } = useFileStore.getState();
        const stats = currentFile?.path === path ? currentFile.stats : undefined;
        setMenu({
          node: findNodeInTree(path, fileTree) ?? {
            name: path.split('/').pop() || path,
            path,
            type: 'file',
            ...stats,
          },
          x: event.clientX,
          y: event.clientY,
        });
        setOpen(true);
      }}>
        {children}
      </div>
      {menu ? (
        <FileActionsDropdown
          node={menu.node}
          open={open}
          onOpenChange={setOpen}
          modal={false}
          showCreateActions={false}
          showMultiSelectActions={false}
          onRevealInExplorer={onRevealInExplorer}
          versionCenterSource="editor"
          contentProps={{
            align: 'start',
            sideOffset: 4,
            onCloseAutoFocus: (event) => event.preventDefault(),
          }}
        >
          <button type="button" tabIndex={-1} aria-hidden="true"
            className="pointer-events-none fixed h-1 w-1 opacity-0"
            style={{ left: menu.x, top: menu.y }} />
        </FileActionsDropdown>
      ) : null}
    </>
  );
}
