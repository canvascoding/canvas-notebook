export const WORKSPACE_LAST_MANAGER_CODE = 'WORKSPACE_LAST_MANAGER';
export const WORKSPACE_LAST_MANAGER_MESSAGE = 'The last workspace manager cannot be removed or downgraded.';

export function wouldRemoveLastWorkspaceManager(params: {
  targetIsActiveManager: boolean;
  activeManagerCount: number;
  nextCanManage: boolean;
}): boolean {
  return params.targetIsActiveManager
    && params.activeManagerCount <= 1
    && !params.nextCanManage;
}

export function getSoleActiveWorkspaceManagerId(
  members: Array<{ userId: string; status?: string | null; canManage: boolean }>,
): string | null {
  const activeManagers = members.filter((member) => (
    member.canManage && (!member.status || member.status === 'active')
  ));
  return activeManagers.length === 1 ? activeManagers[0].userId : null;
}
