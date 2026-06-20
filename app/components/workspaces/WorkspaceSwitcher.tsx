'use client';

import { useCallback, useEffect } from 'react';
import { Check, ChevronsUpDown, Loader2, Lock, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import {
  getWorkspaceKindLabel,
  renderWorkspaceIcon,
  type WorkspaceKindLabels,
} from '@/app/components/workspaces/workspace-utils';
import {
  selectActiveWorkspace,
  useWorkspaceStore,
  type WorkspaceSwitchSource,
} from '@/app/store/workspace-store';

type WorkspaceSwitcherVariant = 'default' | 'compact' | 'toolbar';

type WorkspaceSwitcherProps = {
  source: WorkspaceSwitchSource;
  variant?: WorkspaceSwitcherVariant;
  className?: string;
};

type WorkspaceAccessLabels = {
  readOnly: string;
  teamWrite: string;
  write: string;
};

function getAccessLabel(workspace: ClientWorkspaceSummary, labels: WorkspaceAccessLabels) {
  if (!workspace.permissions.canWrite) return labels.readOnly;
  if (workspace.type === 'team') return labels.teamWrite;
  return labels.write;
}

export function WorkspaceSwitcher({ source, variant = 'default', className }: WorkspaceSwitcherProps) {
  const t = useTranslations('workspaces');
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const isLoading = useWorkspaceStore((state) => state.isLoading);
  const initialized = useWorkspaceStore((state) => state.initialized);
  const error = useWorkspaceStore((state) => state.error);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const refreshWorkspaces = useWorkspaceStore((state) => state.refreshWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);

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
  const isToolbar = variant === 'toolbar';
  const kindLabels = {
    personal: t('types.personal'),
    team: t('types.team'),
    project: t('types.project'),
  } satisfies WorkspaceKindLabels;
  const accessLabels = {
    readOnly: t('access.readOnly'),
    teamWrite: t('access.teamWrite'),
    write: t('access.write'),
  } satisfies WorkspaceAccessLabels;
  const activeLabel = activeWorkspace?.name || (isLoading && !initialized ? t('loadingWorkspace') : t('label'));
  const canSwitch = workspaces.length > 1;

  if (!canSwitch && activeWorkspace && isCompact) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        data-testid="workspace-switcher"
        data-active-workspace-id={activeWorkspace.id}
        data-active-workspace-type={activeWorkspace.type}
        className={cn('h-8 min-w-0 gap-1.5 px-2 text-[11px] disabled:opacity-100', className)}
        title={`${activeWorkspace.name} · ${getAccessLabel(activeWorkspace, accessLabels)}`}
      >
        {renderWorkspaceIcon(activeWorkspace, 'h-3.5 w-3.5 shrink-0')}
        <span className="hidden min-w-0 truncate sm:inline">{getWorkspaceKindLabel(activeWorkspace, kindLabels)}</span>
        {!activeWorkspace.permissions.canWrite ? <Lock className="h-3 w-3 text-amber-500" /> : null}
      </Button>
    );
  }

  return (
    <DropdownMenu modal={false}>
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
            isCompact ? 'max-w-[9.5rem]' : 'max-w-[14rem]',
            isToolbar && 'bg-background/70',
            className
          )}
          title={activeWorkspace ? `${activeWorkspace.name} · ${getAccessLabel(activeWorkspace, accessLabels)}` : activeLabel}
        >
          {isLoading && !initialized ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            renderWorkspaceIcon(activeWorkspace, 'h-3.5 w-3.5 shrink-0')
          )}
          <span className={cn('min-w-0 truncate', isCompact && 'hidden sm:inline')}>
            {isCompact && activeWorkspace ? getWorkspaceKindLabel(activeWorkspace, kindLabels) : activeLabel}
          </span>
          {activeWorkspace && !activeWorkspace.permissions.canWrite ? <Lock className="h-3 w-3 shrink-0 text-amber-500" /> : null}
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-72">
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          <span>{t('label')}</span>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={(event) => {
              event.preventDefault();
              void refreshWorkspaces();
            }}
            aria-label={t('refresh')}
            title={t('refresh')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </button>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {error ? (
          <div className="px-2 py-1.5 text-xs text-destructive">{error}</div>
        ) : null}
        {workspaces.length === 0 && !error ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {isLoading ? t('loadingWorkspaces') : t('noWorkspaceAvailable')}
          </div>
        ) : null}
        {workspaces.map((workspace) => {
          const isActive = workspace.id === activeWorkspace?.id;
          const disabled = workspace.status !== 'active' || !workspace.permissions.canRead;

          return (
            <DropdownMenuItem
              key={workspace.id}
              disabled={disabled}
              onSelect={() => handleSelect(workspace)}
              data-testid={`workspace-option-${workspace.id}`}
              className="items-start gap-2"
            >
              {renderWorkspaceIcon(workspace, 'mt-0.5 h-4 w-4')}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{workspace.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {getWorkspaceKindLabel(workspace, kindLabels)} · {getAccessLabel(workspace, accessLabels)}
                </span>
              </span>
              {isActive ? <Check className="mt-0.5 h-4 w-4 text-primary" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
