export type AutomationMutationWorkspace = {
  jobId: string | null;
  workspaceId: string | null;
  scope: 'personal' | 'organization';
};

export function buildAutomationMutationPayload<T extends Record<string, unknown>>(
  fields: T,
  workspace: AutomationMutationWorkspace,
): T | (T & Pick<AutomationMutationWorkspace, 'workspaceId' | 'scope'>) {
  if (workspace.jobId) return fields;

  return {
    ...fields,
    workspaceId: workspace.workspaceId,
    scope: workspace.scope,
  };
}
