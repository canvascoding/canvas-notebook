import { test, expect } from '@playwright/test';

for (const cachedWorkspace of ['stale', 'valid']) {
  test(`home validates a ${cachedWorkspace} cached workspace before loading agents`, async ({ page }) => {
    const login = await page.request.post('/api/auth/sign-in/email', {
      headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
      data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    const response = await page.request.get('/api/workspaces');
    const workspaces = await response.json();
    const validId = workspaces.activeWorkspaceId;
    expect(validId).toBeTruthy();
    await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), cachedWorkspace === 'stale' ? 'ws_home_stale' : validId);
    let releaseWorkspaces!: () => void;
    const ready = new Promise<void>(resolve => { releaseWorkspaces = resolve; });
    const agentRequests: string[] = [];
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error' && /agent selector|chat agents/.test(message.text())) errors.push(message.text()); });
    await page.route('**/api/workspaces', async route => {
      await ready;
      await route.fulfill({ json: workspaces });
    });
    await page.route('**/api/agents?*', async route => {
      const id = new URL(route.request().url()).searchParams.get('workspaceId')!;
      agentRequests.push(id);
      if (id !== validId) return route.fulfill({ status: 404, json: { success: false, error: 'Workspace not found' } });
      await route.continue();
    });
    try {
      await page.goto('/de');
      await expect(page.getByTestId('home-files').getByRole('status')).toBeVisible();
      // Keep hydration pending long enough for the mounted prompt's effects to run.
      await page.waitForTimeout(300);
      expect(agentRequests).toEqual([]);
      const agentsLoaded = page.waitForResponse(response => response.url().includes('/api/agents?') && response.ok());
      releaseWorkspaces();
      await agentsLoaded;
      expect(agentRequests.length).toBeGreaterThan(0);
      expect(agentRequests.every(id => id === validId)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      releaseWorkspaces();
    }
  });
}
