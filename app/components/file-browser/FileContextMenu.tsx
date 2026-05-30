'use client';

import { useFileStore } from '@/app/store/file-store';
import { FileActionsDropdown } from './FileActionsDropdown';

export function FileContextMenu() {
  const contextMenuNode = useFileStore((s) => s.contextMenuNode);
  const contextMenuPosition = useFileStore((s) => s.contextMenuPosition);
  const isContextMenuOpen = useFileStore((s) => s.isContextMenuOpen);
  const contextMenuRequestId = useFileStore((s) => s.contextMenuRequestId);
  const closeContextMenu = useFileStore((s) => s.closeContextMenu);

  if (!contextMenuNode) {
    return null;
  }

  return (
    <FileActionsDropdown
      key={contextMenuRequestId}
      node={contextMenuNode}
      open={isContextMenuOpen}
      onOpenChange={(open) => {
        if (!open) closeContextMenu();
      }}
      modal={false}
      contentProps={{
        align: 'start',
        sideOffset: 4,
        onCloseAutoFocus: (event) => event.preventDefault(),
      }}
    >
      <button
        type="button"
        aria-hidden="true"
        className="pointer-events-none fixed h-1 w-1 opacity-0"
        style={{ left: contextMenuPosition?.x ?? 0, top: contextMenuPosition?.y ?? 0 }}
      />
    </FileActionsDropdown>
  );
}
