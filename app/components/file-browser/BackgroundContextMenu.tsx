'use client';

import { useCallback, useState } from 'react';
import {
  FilePlus,
  FolderPlus,
  PenTool,
  Upload,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFileStore } from '@/app/store/file-store';
import { CreateItemDialog } from './CreateItemDialog';
import { UploadDialog } from './UploadDialog';
import { useCreateItemDialog } from './useCreateItemDialog';

export function BackgroundContextMenu() {
  const t = useTranslations('notebook');
  const [uploadOpen, setUploadOpen] = useState(false);

  const {
    backgroundContextMenuPosition,
    backgroundContextMenuDirectory,
    isBackgroundContextMenuOpen,
    backgroundContextMenuRequestId,
    closeBackgroundContextMenu,
    uploadFile,
    currentDirectory,
  } = useFileStore();

  const closeMenu = useCallback(() => {
    closeBackgroundContextMenu();
  }, [closeBackgroundContextMenu]);

  const { createDialogProps, openCreateDialog } = useCreateItemDialog(closeMenu);

  const handleNewFile = () => {
    openCreateDialog('file');
  };

  const handleNewExcalidraw = () => {
    openCreateDialog('excalidraw');
  };

  const handleNewFolder = () => {
    openCreateDialog('directory');
  };

  const handleUpload = () => {
    closeMenu();
    setUploadOpen(true);
  };

  const handleUploadFiles = async (files: File[], targetDir: string) => {
    await uploadFile(files, targetDir);
  };

  const directory = backgroundContextMenuDirectory || currentDirectory || '.';

  if (!isBackgroundContextMenuOpen) {
    return (
      <>
        <CreateItemDialog
          {...createDialogProps}
          defaultPath={directory}
        />
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          defaultPath={directory}
          onUpload={handleUploadFiles}
        />
      </>
    );
  }

  return (
    <>
      <DropdownMenu
        open={isBackgroundContextMenuOpen}
        onOpenChange={(open) => {
          if (!open) closeBackgroundContextMenu();
        }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            className="pointer-events-none fixed h-1 w-1 opacity-0"
            style={{
              left: backgroundContextMenuPosition?.x ?? 0,
              top: backgroundContextMenuPosition?.y ?? 0,
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          key={backgroundContextMenuRequestId}
          align="start"
          sideOffset={4}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenuLabel className="px-2 py-1 text-xs font-medium text-muted-foreground">
            {t('create')}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={handleNewFolder}>
            <FolderPlus className="h-4 w-4" />
            {t('newFolder')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleNewFile}>
            <FilePlus className="h-4 w-4" />
            {t('newFile')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleNewExcalidraw}>
            <PenTool className="h-4 w-4" />
            {t('newExcalidraw')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleUpload}>
            <Upload className="h-4 w-4" />
            {t('upload')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateItemDialog
        {...createDialogProps}
        defaultPath={directory}
      />

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        defaultPath={directory}
        onUpload={handleUploadFiles}
      />
    </>
  );
}
