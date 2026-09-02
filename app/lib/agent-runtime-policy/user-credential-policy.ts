import type { AiWorkspaceModelPolicy } from '@/app/lib/agent-runtime-policy/types';
import type { WorkspaceType } from '@/app/lib/workspaces/types';

/**
 * Personal credentials are available for owner-scoped interactive runs unless
 * a non-personal workspace explicitly disables them. A missing workspace
 * policy inherits the permissive app catalog instead of becoming an implicit
 * deny that users cannot resolve themselves.
 */
export function workspaceAllowsInteractiveUserCredentials(input: {
  workspaceType: WorkspaceType;
  policy: AiWorkspaceModelPolicy | null;
}): boolean {
  return input.workspaceType === 'personal' || input.policy?.allowUserCredentials !== false;
}
