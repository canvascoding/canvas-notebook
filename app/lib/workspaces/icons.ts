export const WORKSPACE_ICON_OPTIONS = [
  'notebook-pen',
  'code-2',
  'briefcase-business',
  'megaphone',
  'palette',
  'rocket',
  'chart-no-axes-combined',
  'graduation-cap',
  'heart-handshake',
  'folder-kanban',
  'workflow',
  'landmark',
  'users-round',
  'user-round',
  'building-2',
] as const;

export type WorkspaceIcon = (typeof WORKSPACE_ICON_OPTIONS)[number];

type WorkspaceIconType = 'personal' | 'organization' | 'team' | 'project';

const DEFAULT_WORKSPACE_ICONS: Record<WorkspaceIconType, WorkspaceIcon> = {
  personal: 'user-round',
  organization: 'landmark',
  team: 'users-round',
  project: 'folder-kanban',
};

export function isWorkspaceIcon(value: unknown): value is WorkspaceIcon {
  return typeof value === 'string' && (WORKSPACE_ICON_OPTIONS as readonly string[]).includes(value);
}

export function getDefaultWorkspaceIcon(type: WorkspaceIconType | string | null | undefined): WorkspaceIcon {
  if (type === 'organization' || type === 'team' || type === 'project') {
    return DEFAULT_WORKSPACE_ICONS[type];
  }
  return DEFAULT_WORKSPACE_ICONS.personal;
}
