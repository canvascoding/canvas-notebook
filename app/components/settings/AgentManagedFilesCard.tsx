'use client';

import { ChevronDown, Loader2, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarkdownEditor } from '@/app/components/editor/MarkdownEditor';

export const MANAGED_FILES = ['AGENTS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'] as const;

export type ManagedFileName = (typeof MANAGED_FILES)[number];
export type ResetTarget = 'current' | 'all';

type AgentManagedFilesCardProps = {
  files: Record<ManagedFileName, string> | null;
  fileDrafts: Record<ManagedFileName, string>;
  activeFile: ManagedFileName;
  filesLoading: boolean;
  filesSaving: boolean;
  filesResetting: boolean;
  filesError: string | null;
  filesSuccess: string | null;
  resetDialogOpen: boolean;
  resetTarget: ResetTarget | null;
  onActiveFileChange: (fileName: ManagedFileName) => void;
  onDraftChange: (fileName: ManagedFileName, value: string) => void;
  onSaveActiveFile: () => void;
  onReloadFiles: () => void;
  onOpenResetDialog: (target: ResetTarget) => void;
  onResetDialogOpenChange: (open: boolean) => void;
  onClearResetTarget: () => void;
  onResetFile: () => void;
};

export function AgentManagedFilesCard({
  files,
  fileDrafts,
  activeFile,
  filesLoading,
  filesSaving,
  filesResetting,
  filesError,
  filesSuccess,
  resetDialogOpen,
  resetTarget,
  onActiveFileChange,
  onDraftChange,
  onSaveActiveFile,
  onReloadFiles,
  onOpenResetDialog,
  onResetDialogOpenChange,
  onClearResetTarget,
  onResetFile,
}: AgentManagedFilesCardProps) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');

  return (
    <>
      <Card id="onboarding-settings-managedFiles">
        <CardHeader>
          <CardTitle>{t('agentPanel.files.title')}</CardTitle>
          <CardDescription>{t('agentPanel.files.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {filesLoading || !files ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('agentPanel.files.loading')}
            </div>
          ) : (
            <>
              <Tabs value={activeFile} onValueChange={(value) => onActiveFileChange(value as ManagedFileName)}>
                <TabsList className="flex h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
                  {MANAGED_FILES.map((fileName) => (
                    <TabsTrigger key={fileName} value={fileName} className="border border-border data-[state=active]:bg-muted">
                      {fileName}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              <div
                data-testid="agent-managed-file-editor"
                className="h-[400px] overflow-hidden rounded-md border border-input"
              >
                <MarkdownEditor
                  value={fileDrafts[activeFile] ?? ''}
                  onChange={(nextValue) => onDraftChange(activeFile, nextValue)}
                />
              </div>

              {filesError && <p className="text-sm text-destructive">{filesError}</p>}
              {filesSuccess && <p className="text-sm text-primary">{filesSuccess}</p>}

              <div className="flex flex-wrap gap-2">
                <Button data-testid="agent-managed-file-save" onClick={onSaveActiveFile} disabled={filesSaving || filesResetting}>
                  {filesSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {t('agentPanel.files.save')}
                </Button>
                <Button variant="outline" onClick={onReloadFiles} disabled={filesLoading || filesSaving || filesResetting}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('agentPanel.files.reload')}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" disabled={filesLoading || filesSaving || filesResetting}>
                      {filesResetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                      {t('agentPanel.files.reset')}
                      <ChevronDown className="ml-2 h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => onOpenResetDialog('current')}>
                      {t('agentPanel.files.resetCurrentFile')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onOpenResetDialog('all')}>
                      {t('agentPanel.files.resetAllFiles')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={resetDialogOpen} onOpenChange={onResetDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resetTarget === 'all' ? t('agentPanel.files.confirmResetAllTitle') : t('agentPanel.files.confirmResetTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resetTarget === 'all' ? t('agentPanel.files.confirmResetAll') : t('agentPanel.files.confirmReset', { fileName: activeFile })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onClearResetTarget}>
              {tCommon('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onResetFile}>
              {t('agentPanel.files.reset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
