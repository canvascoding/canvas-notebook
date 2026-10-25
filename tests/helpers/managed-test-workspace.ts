import type { APIRequestContext, Page } from '@playwright/test';

/** Select an explicit primary-user fixture only for an unselected browser page. */
export async function initializeManagedTestWorkspace(input: {
  page: Page; request: APIRequestContext; email: string; primaryEmail?: string;
  workspaceName?: string; baseUrl: string; timeout: number;
}): Promise<void> {
  const name = input.workspaceName?.trim();
  if (!name || input.email !== input.primaryEmail) return;
  const response = await input.request.get('/api/workspaces', { timeout: input.timeout });
  if (!response.ok()) throw new Error(`Managed test workspace lookup failed (${response.status()}).`);
  const body = await response.json() as { workspaces?: Array<{
    id?: string; name?: string; status?: string; permissions?: { canRead?: boolean };
  }> };
  const matches = body.workspaces?.filter(workspace => workspace.name === name && workspace.status === 'active') ?? [];
  if (matches.length !== 1 || !matches[0].id || matches[0].permissions?.canRead !== true) {
    throw new Error('TEST_WORKSPACE_NAME must identify one active, readable workspace for the configured primary user.');
  }
  await input.page.context().addInitScript(({ workspaceId, origin }) => {
    if (location.origin === origin && !localStorage.getItem('canvas.activeWorkspaceId')) {
      localStorage.setItem('canvas.activeWorkspaceId', workspaceId);
    }
  }, { workspaceId: matches[0].id, origin: new URL(input.baseUrl).origin });
}
