'use client';

import { useEffect, useMemo } from 'react';
import { ChevronDown, FileText, Loader2, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
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
import { AgentSettingsAccordionCard } from './AgentSettingsAccordionCard';

export const MANAGED_FILES = ['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'] as const;
export const AGENT_FILE_TABS = ['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;
const SPECIAL_AGENT_INHERITED_FILES = ['USER.md'] as const;
const SPECIAL_AGENT_VISIBLE_FILES = AGENT_FILE_TABS.filter((fileName) => !SPECIAL_AGENT_INHERITED_FILES.includes(fileName as typeof SPECIAL_AGENT_INHERITED_FILES[number]));

export type ManagedFileName = (typeof MANAGED_FILES)[number];
export type ResetTarget = 'current' | 'all';

export function getVisibleManagedFileNames(isMainAgent: boolean): ManagedFileName[] {
  return [...(isMainAgent ? AGENT_FILE_TABS : SPECIAL_AGENT_VISIBLE_FILES)];
}

type AgentManagedFilesEditorProps = {
  isMainAgent: boolean;
  files: Record<ManagedFileName, string> | null;
  fileDrafts: Record<ManagedFileName, string>;
  activeFile: ManagedFileName;
  filesLoading: boolean;
  onActiveFileChange: (fileName: ManagedFileName) => void;
  onDraftChange: (fileName: ManagedFileName, value: string) => void;
  visibleFileNames?: readonly ManagedFileName[];
  showInheritedFiles?: boolean;
  editorClassName?: string;
};

type AgentManagedFilesCardProps = AgentManagedFilesEditorProps & {
  filesSaving: boolean;
  filesResetting: boolean;
  filesError: string | null;
  filesSuccess: string | null;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  resetDialogOpen: boolean;
  resetTarget: ResetTarget | null;
  onSaveActiveFile: () => void;
  onReloadFiles: () => void;
  onOpenResetDialog: (target: ResetTarget) => void;
  onResetDialogOpenChange: (open: boolean) => void;
  onClearResetTarget: () => void;
  onResetFile: () => void;
  title?: string;
  description?: string;
};

export function AgentManagedFilesEditor({
  isMainAgent,
  files,
  fileDrafts,
  activeFile,
  filesLoading,
  onActiveFileChange,
  onDraftChange,
  visibleFileNames: visibleFileNamesOverride,
  showInheritedFiles = true,
  editorClassName = 'h-[400px]',
}: AgentManagedFilesEditorProps) {
  const t = useTranslations('settings');
  const visibleFileNames = useMemo(
    () => [...(visibleFileNamesOverride || getVisibleManagedFileNames(isMainAgent))],
    [isMainAgent, visibleFileNamesOverride],
  );

  useEffect(() => {
    if (!visibleFileNames.includes(activeFile)) {
      onActiveFileChange('AGENTS.md');
    }
  }, [activeFile, onActiveFileChange, visibleFileNames]);

  if (filesLoading || !files) {
    return (
      <div className="flex items-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('agentPanel.files.loading')}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <Tabs value={activeFile} onValueChange={(value) => onActiveFileChange(value as ManagedFileName)} className="min-w-0">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-2 overflow-x-hidden bg-transparent p-0 pb-1">
          {visibleFileNames.map((fileName) => (
            <TabsTrigger key={fileName} value={fileName} className="shrink-0 border border-border data-[state=active]:bg-muted">
              {fileName}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {!isMainAgent && showInheritedFiles && (
        <div className="grid min-w-0 gap-2 md:grid-cols-2">
          {SPECIAL_AGENT_INHERITED_FILES.map((fileName) => (
            <div key={fileName} className="min-w-0 rounded-md border bg-muted/30 p-3 text-xs">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{fileName}</span>
                <span className="max-w-full rounded bg-background px-2 py-0.5 text-muted-foreground">
                  {t('agentPanel.files.inheritedFromCanvas')}
                </span>
              </div>
              <p className="line-clamp-2 whitespace-pre-wrap text-muted-foreground">
                {(files[fileName] || '').trim() || t('agentPanel.files.emptyInherited')}
              </p>
            </div>
          ))}
        </div>
      )}

      <div
        data-testid="agent-managed-file-editor"
        className={`${editorClassName} overflow-hidden rounded-md border border-input`}
      >
        <MarkdownEditor
          value={fileDrafts[activeFile] ?? ''}
          onChange={(nextValue) => onDraftChange(activeFile, nextValue)}
        />
      </div>
    </div>
  );
}

export function AgentManagedFilesCard({
  isMainAgent,
  files,
  fileDrafts,
  activeFile,
  filesLoading,
  filesSaving,
  filesResetting,
  filesError,
  filesSuccess,
  isOpen,
  onOpenChange,
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
  visibleFileNames,
  showInheritedFiles,
  editorClassName,
  title,
  description,
}: AgentManagedFilesCardProps) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const resolvedTitle = title || t('agentPanel.files.title');
  const resolvedDescription = description || t('agentPanel.files.description');
  const visibleSummaryFileNames = useMemo(
    () => [...(visibleFileNames || getVisibleManagedFileNames(isMainAgent))],
    [isMainAgent, visibleFileNames],
  );
  const summaryItems = [
    filesLoading
      ? t('agentPanel.files.loading')
      : t('agentPanel.files.summary', { count: visibleSummaryFileNames.length }),
    filesError ? t('agentPanel.files.errorSummary') : t('agentPanel.files.activeFileSummary', { fileName: activeFile }),
  ];

  return (
    <>
      <AgentSettingsAccordionCard
        id="onboarding-settings-managedFiles"
        title={resolvedTitle}
        description={resolvedDescription}
        icon={FileText}
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        summaryItems={summaryItems}
        contentClassName="space-y-3"
      >
          <AgentManagedFilesEditor
            isMainAgent={isMainAgent}
            files={files}
            fileDrafts={fileDrafts}
            activeFile={activeFile}
            filesLoading={filesLoading}
            onActiveFileChange={onActiveFileChange}
            onDraftChange={onDraftChange}
            visibleFileNames={visibleFileNames}
            showInheritedFiles={showInheritedFiles}
            editorClassName={editorClassName}
          />

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
      </AgentSettingsAccordionCard>

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
