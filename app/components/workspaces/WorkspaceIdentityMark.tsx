'use client';

import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { DEFAULT_WORKSPACE_COLOR } from '@/app/lib/workspaces/colors';
import { cn } from '@/lib/utils';
import { renderWorkspaceIcon } from './workspace-utils';

type WorkspaceIdentityMarkProps = {
  workspace: ClientWorkspaceSummary | null | undefined;
  className?: string;
  iconClassName?: string;
};

export function WorkspaceIdentityMark({
  workspace,
  className,
  iconClassName = 'h-3.5 w-3.5',
}: WorkspaceIdentityMarkProps) {
  const color = workspace?.color || DEFAULT_WORKSPACE_COLOR;

  return (
    <span
      aria-hidden="true"
      data-workspace-color={color}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white shadow-xs ring-1 ring-black/10',
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {renderWorkspaceIcon(workspace, cn('text-white', iconClassName))}
    </span>
  );
}
