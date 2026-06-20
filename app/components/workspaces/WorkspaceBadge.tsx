'use client';

import { Building2, Lock, UserRound, UsersRound } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';

type WorkspaceBadgeProps = {
  workspace?: ClientWorkspaceSummary | null;
  compact?: boolean;
  className?: string;
};

function getWorkspaceKindLabel(workspace: ClientWorkspaceSummary | null) {
  if (workspace?.type === 'team') return 'Team';
  if (workspace?.type === 'project') return 'Project';
  return 'Personal';
}

function renderWorkspaceIcon(workspace: ClientWorkspaceSummary | null, className: string) {
  if (workspace?.type === 'team') return <UsersRound className={className} />;
  if (workspace?.type === 'project') return <Building2 className={className} />;
  return <UserRound className={className} />;
}

export function WorkspaceBadge({ workspace: providedWorkspace, compact = false, className }: WorkspaceBadgeProps) {
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const workspace = providedWorkspace ?? activeWorkspace;
  const label = workspace?.name || 'Workspace';
  const kindLabel = getWorkspaceKindLabel(workspace);
  const canWrite = Boolean(workspace?.permissions.canWrite);
  const title = workspace
    ? `${label} · ${canWrite ? 'Write access' : 'Read only'}`
    : 'Workspace context is loading';

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            data-testid="workspace-badge"
            data-active-workspace-id={workspace?.id ?? ''}
            data-active-workspace-type={workspace?.type ?? ''}
            className={cn(
              'h-7 max-w-full gap-1.5 rounded-md border-border/70 bg-muted/35 px-2 text-[11px] font-medium text-foreground hover:bg-muted/50',
              className
            )}
          >
            {renderWorkspaceIcon(workspace, 'h-3.5 w-3.5 shrink-0 text-muted-foreground')}
            {!compact && (
              <span className="min-w-0 truncate">
                {label}
              </span>
            )}
            {compact ? (
              <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{kindLabel}</span>
            ) : null}
            {!canWrite && workspace ? <Lock className="h-3 w-3 shrink-0 text-amber-500" /> : null}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
