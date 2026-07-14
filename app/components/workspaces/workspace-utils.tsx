'use client';

import {
  BriefcaseBusiness,
  Building2,
  ChartNoAxesCombined,
  Code2,
  FolderKanban,
  GraduationCap,
  HeartHandshake,
  Landmark,
  Megaphone,
  NotebookPen,
  Palette,
  Rocket,
  UserRound,
  UsersRound,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import type { ClientWorkspaceSummary, ClientWorkspaceType } from '@/app/lib/workspaces/client-types';
import { getDefaultWorkspaceIcon, type WorkspaceIcon } from '@/app/lib/workspaces/icons';

export type WorkspaceKindLabels = Record<ClientWorkspaceType, string>;

const workspaceIconComponents: Record<WorkspaceIcon, LucideIcon> = {
  'notebook-pen': NotebookPen,
  'code-2': Code2,
  'briefcase-business': BriefcaseBusiness,
  megaphone: Megaphone,
  palette: Palette,
  rocket: Rocket,
  'chart-no-axes-combined': ChartNoAxesCombined,
  'graduation-cap': GraduationCap,
  'heart-handshake': HeartHandshake,
  'folder-kanban': FolderKanban,
  workflow: Workflow,
  landmark: Landmark,
  'users-round': UsersRound,
  'user-round': UserRound,
  'building-2': Building2,
};

export function getWorkspaceKindLabel(
  workspace: ClientWorkspaceSummary | null | undefined,
  labels: WorkspaceKindLabels
) {
  const type = workspace?.type ?? 'personal';
  return labels[type] ?? labels.personal;
}

export function renderWorkspaceIconById(icon: WorkspaceIcon, className: string) {
  const Icon = workspaceIconComponents[icon];
  return <Icon className={className} />;
}

export function renderWorkspaceIcon(workspace: ClientWorkspaceSummary | null | undefined, className: string) {
  return renderWorkspaceIconById(workspace?.icon ?? getDefaultWorkspaceIcon(workspace?.type), className);
}
