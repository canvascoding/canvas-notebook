'use client';

import { Building2, UserRound, UsersRound } from 'lucide-react';

import type { ClientWorkspaceSummary, ClientWorkspaceType } from '@/app/lib/workspaces/client-types';

export type WorkspaceKindLabels = Record<ClientWorkspaceType, string>;

export function getWorkspaceKindLabel(
  workspace: ClientWorkspaceSummary | null | undefined,
  labels: WorkspaceKindLabels
) {
  const type = workspace?.type ?? 'personal';
  return labels[type] ?? labels.personal;
}

export function renderWorkspaceIcon(workspace: ClientWorkspaceSummary | null | undefined, className: string) {
  if (workspace?.type === 'team') return <UsersRound className={className} />;
  if (workspace?.type === 'project') return <Building2 className={className} />;
  return <UserRound className={className} />;
}
