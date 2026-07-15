type WorkspaceExportType = 'personal' | 'organization' | 'team' | 'project';

export interface WorkspaceFileExportAccessInput {
  workspaceType: WorkspaceExportType;
  isPersonalOwner: boolean;
  isInstanceAdmin: boolean;
  canRead: boolean;
  status?: string | null;
}

export function canExportWorkspaceFiles({
  workspaceType,
  isPersonalOwner,
  isInstanceAdmin,
  canRead,
  status,
}: WorkspaceFileExportAccessInput): boolean {
  if (!canRead || (status && status !== 'active')) return false;
  if (workspaceType === 'personal') return isPersonalOwner;
  return isInstanceAdmin;
}
