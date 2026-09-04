'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronsUpDown, Loader2, Lock, Pencil, Plus, RefreshCw, Star, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TeamModeHostedOnlyNotice } from '@/app/components/team/TeamModeHostedOnlyNotice';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { CreateWorkspaceDialog } from '@/app/components/settings/CreateWorkspaceDialog';
import { EditWorkspaceDialog } from '@/app/components/settings/EditWorkspaceDialog';
import { WorkspaceIdentityMark } from '@/app/components/workspaces/WorkspaceIdentityMark';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import {
  getWorkspaceKindLabel,
  type WorkspaceKindLabels,
} from '@/app/components/workspaces/workspace-utils';
import {
  selectActiveWorkspace,
  useWorkspaceStore,
  type WorkspaceSwitchSource,
} from '@/app/store/workspace-store';

type WorkspaceSwitcherVariant = 'default' | 'compact' | 'chat-compact' | 'toolbar' | 'file-toolbar' | 'mobile-sheet';

type WorkspaceSwitcherProps = {
  source: WorkspaceSwitchSource;
  variant?: WorkspaceSwitcherVariant;
  className?: string;
  mobileSheetOpen?: boolean;
  onMobileSheetOpenChange?: (open: boolean) => void;
  hideMobileSheetTrigger?: boolean;
};

type WorkspaceAccessLabels = {
  readOnly: string;
  teamWrite: string;
  write: string;
};

function getAccessLabel(workspace: ClientWorkspaceSummary, labels: WorkspaceAccessLabels) {
  if (!workspace.permissions.canWrite) return labels.readOnly;
  if (workspace.type === 'organization' || workspace.type === 'team') return labels.teamWrite;
  return labels.write;
}

function getSwitchableWorkspaces(workspaces: ClientWorkspaceSummary[]) {
  return workspaces.filter((workspace) => workspace.status === 'active' && workspace.permissions.canRead);
}

export function hasWorkspaceSwitcherOptions(workspaces: ClientWorkspaceSummary[]) {
  const switchableWorkspaces = getSwitchableWorkspaces(workspaces);
  return switchableWorkspaces.length > 1;
}

export function hasWorkspaceManagementControls(workspaces: ClientWorkspaceSummary[]) {
  return workspaces.some((workspace) => workspace.status === 'active' && workspace.permissions.canManageWorkspace);
}

export function useShouldShowWorkspaceSwitcher() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const teamModeUnavailable = useWorkspaceStore((state) => state.teamModeUnavailable);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);

  useEffect(() => {
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  return Boolean(teamModeUnavailable)
    || hasWorkspaceSwitcherOptions(workspaces)
    || hasWorkspaceManagementControls(workspaces);
}

export function WorkspaceSwitcher({
  source,
  variant = 'default',
  className,
  mobileSheetOpen: controlledMobileSheetOpen,
  onMobileSheetOpenChange,
  hideMobileSheetTrigger = false,
}: WorkspaceSwitcherProps) {
  const t = useTranslations('workspaces');
  const [internalMobileSheetOpen, setInternalMobileSheetOpen] = useState(false);
  const [desktopMenuOpen, setDesktopMenuOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ClientWorkspaceSummary | null>(null);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const isLoading = useWorkspaceStore((state) => state.isLoading);
  const initialized = useWorkspaceStore((state) => state.initialized);
  const error = useWorkspaceStore((state) => state.error);
  const teamModeUnavailable = useWorkspaceStore((state) => state.teamModeUnavailable);
  const teamFeaturesEnabled = useWorkspaceStore((state) => state.teamFeaturesEnabled);
  const projectFeaturesEnabled = useWorkspaceStore((state) => state.projectFeaturesEnabled);
  const canCreateSharedWorkspaces = useWorkspaceStore((state) => state.canCreateSharedWorkspaces);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const refreshWorkspaces = useWorkspaceStore((state) => state.refreshWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const mobileSheetOpen = controlledMobileSheetOpen ?? internalMobileSheetOpen;
  const setMobileSheetOpen = useCallback((open: boolean) => {
    if (controlledMobileSheetOpen === undefined) {
      setInternalMobileSheetOpen(open);
    }
    onMobileSheetOpenChange?.(open);
  }, [controlledMobileSheetOpen, onMobileSheetOpenChange]);

  useEffect(() => {
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  const handleSelect = useCallback(
    (workspace: ClientWorkspaceSummary) => {
      setActiveWorkspace(workspace.id, source);
    },
    [setActiveWorkspace, source]
  );

  const isCompact = variant === 'compact';
  const isChatCompact = variant === 'chat-compact';
  const isToolbar = variant === 'toolbar';
  const isFileToolbar = variant === 'file-toolbar';
  const isMobileSheet = variant === 'mobile-sheet';
  const switchableWorkspaces = getSwitchableWorkspaces(workspaces);
  const canManageWorkspaces = hasWorkspaceManagementControls(workspaces);
  const hasOrganizationWorkspace = workspaces.some(
    (workspace) => workspace.type === 'organization' && workspace.status === 'active',
  );
  const kindLabels = {
    personal: t('types.personal'),
    organization: t('types.organization'),
    team: t('types.team'),
    project: t('types.project'),
  } satisfies WorkspaceKindLabels;
  const accessLabels = {
    readOnly: t('access.readOnly'),
    teamWrite: t('access.teamWrite'),
    write: t('access.write'),
  } satisfies WorkspaceAccessLabels;
  const activeLabel = activeWorkspace?.name || (isLoading && !initialized ? t('loadingWorkspace') : t('label'));
  const canSwitch = hasWorkspaceSwitcherOptions(workspaces);
  const showTeamModeNotice = Boolean(teamModeUnavailable);

  const handleWorkspaceChanged = useCallback(async () => {
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  const handleWorkspaceCreated = useCallback(async (workspace: ClientWorkspaceSummary) => {
    await refreshWorkspaces();
    setActiveWorkspace(workspace.id, source);
  }, [refreshWorkspaces, setActiveWorkspace, source]);

  const workspaceDialogs = (
    <>
      <CreateWorkspaceDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        canCreateSharedWorkspace={canCreateSharedWorkspaces}
        hasOrganizationWorkspace={hasOrganizationWorkspace}
        teamFeaturesEnabled={teamFeaturesEnabled}
        projectFeaturesEnabled={projectFeaturesEnabled}
        onCreated={handleWorkspaceCreated}
      />
      <EditWorkspaceDialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        workspace={editTarget}
        onChanged={handleWorkspaceChanged}
      />
    </>
  );

  if (!canSwitch && !canManageWorkspaces && !showTeamModeNotice) {
    return null;
  }

  if (isMobileSheet) {
    const buttonTitle = activeWorkspace ? `${activeWorkspace.name} · ${getAccessLabel(activeWorkspace, accessLabels)}` : activeLabel;

    return (
      <>
      <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
        {!hideMobileSheetTrigger ? (
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={isLoading && !initialized}
              data-testid="workspace-switcher"
              data-active-workspace-id={activeWorkspace?.id ?? ''}
              data-active-workspace-type={activeWorkspace?.type ?? ''}
              className={cn('h-10 w-full justify-between gap-2 px-3 text-left', className)}
              title={buttonTitle}
            >
              <span className="flex min-w-0 items-center gap-2">
                {isLoading && !initialized ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <WorkspaceIdentityMark workspace={activeWorkspace} className="h-6 w-6" iconClassName="h-3.5 w-3.5" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{activeLabel}</span>
                  {activeWorkspace ? (
                    <span className="block truncate text-[11px] font-normal text-muted-foreground">
                      {getWorkspaceKindLabel(activeWorkspace, kindLabels)} · {getAccessLabel(activeWorkspace, accessLabels)}
                    </span>
                  ) : null}
                </span>
              </span>
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          </SheetTrigger>
        ) : null}
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[75dvh] gap-0 overflow-hidden rounded-t-xl p-0"
        >
          <SheetHeader className="border-b border-border px-4 py-3 text-left">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <SheetTitle>{t('label')}</SheetTitle>
                <SheetDescription>
                  {activeWorkspace ? `${activeWorkspace.name} · ${getAccessLabel(activeWorkspace, accessLabels)}` : activeLabel}
                </SheetDescription>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canManageWorkspaces ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileSheetOpen(false);
                      setCreateDialogOpen(true);
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={t('create')}
                    aria-label={t('create')}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                ) : null}
                <SheetClose asChild>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('close')}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </SheetClose>
              </div>
            </div>
          </SheetHeader>
          <div className="max-h-[calc(75dvh-5rem)] overflow-y-auto p-2">
            <button
              type="button"
              className="mb-1 flex h-9 w-full items-center justify-center gap-2 rounded-md text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => void refreshWorkspaces()}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              {t('refresh')}
            </button>
            {showTeamModeNotice ? (
              <TeamModeHostedOnlyNotice compact className="mb-2" />
            ) : error ? (
              <div className="rounded-md px-2 py-1.5 text-xs text-destructive">{error}</div>
            ) : null}
            {workspaces.length === 0 && !error && !showTeamModeNotice ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                {isLoading ? t('loadingWorkspaces') : t('noWorkspaceAvailable')}
              </div>
            ) : null}
            {switchableWorkspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspace?.id;
              const disabled = workspace.status !== 'active' || !workspace.permissions.canRead;
              const item = (
                <button
                  type="button"
                  disabled={disabled}
                  data-testid={`workspace-option-${workspace.id}`}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors',
                    disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent hover:text-accent-foreground',
                    isActive && 'bg-accent/70'
                  )}
                  onClick={() => {
                    if (disabled) return;
                    handleSelect(workspace);
                    setMobileSheetOpen(false);
                  }}
                >
                  <WorkspaceIdentityMark workspace={workspace} className="mt-0.5 h-7 w-7" iconClassName="h-4 w-4" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="min-w-0 truncate">{workspace.name}</span>
                      {workspace.isDefault ? (
                        <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
                          <Star className="h-3 w-3" />
                          {t('badge.default')}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {getWorkspaceKindLabel(workspace, kindLabels)} · {getAccessLabel(workspace, accessLabels)}
                    </span>
                  </span>
                  {isActive ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : null}
                </button>
              );

              return (
                <div key={workspace.id} className="group flex min-w-0 items-center gap-1">
                  <div className="min-w-0 flex-1">
                    {disabled ? item : (
                      <SheetClose asChild>{item}</SheetClose>
                    )}
                  </div>
                  {workspace.permissions.canManageWorkspace ? (
                    <button
                      type="button"
                      onClick={() => {
                        setMobileSheetOpen(false);
                        setEditTarget(workspace);
                      }}
                      className="mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={t('edit')}
                      aria-label={t('edit')}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
      {workspaceDialogs}
      </>
    );
  }

  return (
    <>
    <DropdownMenu modal={false} open={desktopMenuOpen} onOpenChange={setDesktopMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={isToolbar ? 'ghost' : 'outline'}
          size="sm"
          disabled={isLoading && !initialized}
          data-testid="workspace-switcher"
          data-active-workspace-id={activeWorkspace?.id ?? ''}
          data-active-workspace-type={activeWorkspace?.type ?? ''}
          className={cn(
            'h-8 min-w-0 gap-1.5 px-2 text-xs',
            isFileToolbar ? 'w-full max-w-none @container' : isChatCompact ? 'max-w-[8rem]' : isCompact ? 'max-w-[9.5rem] md:max-w-[18rem] xl:max-w-[24rem]' : 'max-w-[14rem]',
            isToolbar && 'bg-background/70',
            className
          )}
          title={activeWorkspace ? `${activeWorkspace.name} · ${getAccessLabel(activeWorkspace, accessLabels)}` : activeLabel}
        >
          {isLoading && !initialized ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <WorkspaceIdentityMark workspace={activeWorkspace} className="h-5 w-5 rounded-[5px]" iconClassName="h-3 w-3" />
          )}
          <span className={cn(
            'min-w-0 truncate',
            isFileToolbar && 'hidden @[8.5rem]:inline',
            isCompact && !isFileToolbar && 'hidden sm:inline',
            isChatCompact && 'hidden md:inline',
          )}>
            {activeLabel}
          </span>
          {activeWorkspace && !activeWorkspace.permissions.canWrite ? <Lock className="h-3 w-3 shrink-0 text-amber-500" /> : null}
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="flex w-72 max-h-[min(32rem,calc(100dvh-2rem))] flex-col overflow-hidden"
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          <span>{t('label')}</span>
          <span className="flex items-center gap-1">
            {canManageWorkspaces ? (
              <button
                type="button"
                onClick={() => {
                  setDesktopMenuOpen(false);
                  setCreateDialogOpen(true);
                }}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={t('create')}
                aria-label={t('create')}
              >
                <Plus className="h-4 w-4" />
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={(event) => {
                event.preventDefault();
                void refreshWorkspaces();
              }}
              aria-label={t('refresh')}
              title={t('refresh')}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            </button>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div
          className="min-h-0 overflow-y-auto py-1"
          data-testid="workspace-switcher-options"
        >
          {showTeamModeNotice ? (
            <div className="p-2">
              <TeamModeHostedOnlyNotice compact />
            </div>
          ) : error ? (
            <div className="px-2 py-1.5 text-xs text-destructive">{error}</div>
          ) : null}
          {workspaces.length === 0 && !error && !showTeamModeNotice ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {isLoading ? t('loadingWorkspaces') : t('noWorkspaceAvailable')}
            </div>
          ) : null}
          {switchableWorkspaces.map((workspace) => {
            const isActive = workspace.id === activeWorkspace?.id;
            const disabled = workspace.status !== 'active' || !workspace.permissions.canRead;

            return (
              <div key={workspace.id} className="group flex min-w-0 items-center gap-1">
                <DropdownMenuItem
                  disabled={disabled}
                  onSelect={() => handleSelect(workspace)}
                  data-testid={`workspace-option-${workspace.id}`}
                  className="min-w-0 flex-1 items-start gap-2"
                >
                  <WorkspaceIdentityMark workspace={workspace} className="mt-0.5 h-7 w-7" iconClassName="h-4 w-4" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="min-w-0 truncate">{workspace.name}</span>
                      {workspace.isDefault ? (
                        <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
                          <Star className="h-3 w-3" />
                          {t('badge.default')}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {getWorkspaceKindLabel(workspace, kindLabels)} · {getAccessLabel(workspace, accessLabels)}
                    </span>
                  </span>
                  {isActive ? <Check className="mt-0.5 h-4 w-4 text-primary" /> : null}
                </DropdownMenuItem>
                {workspace.permissions.canManageWorkspace ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDesktopMenuOpen(false);
                      setEditTarget(workspace);
                    }}
                    className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-100 transition-all hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100"
                    title={t('edit')}
                    aria-label={t('edit')}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
    {workspaceDialogs}
    </>
  );
}
