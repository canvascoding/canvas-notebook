import { expect, test, type Page } from '@playwright/test';

async function prepare(page: Page) {
  const login = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((candidate: { type: string }) => candidate.type === 'personal');
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  await page.route('**/api/files/quick-access?*', route => route.fulfill({ json: { success: true, data: { files: [], total: 0, workspaceFileCount: 0, view: 'recent', favorites: [] } } }));
  await page.route('**/api/home/chats?*', route => route.fulfill({ json: { success: true, data: { chats: [], hasMore: false } } }));
  await page.route('**/api/mobile-app-promotion', route => route.fulfill({ json: { success: true, promotion: { eligible: false } } }));
  return workspace as { id: string };
}

async function mockWidgets(page: Page, workspaceId: string, options: {
  brokenStudioImage?: boolean;
  failEmail?: boolean;
  longAutomationResult?: boolean;
  staleEmailFollowUp?: boolean;
} = {}) {
  const widgetRequests: string[] = [];
  let releaseEmailFollowUp: () => void = () => undefined;
  const emailFollowUpGate = new Promise<void>((resolve) => {
    releaseEmailFollowUp = resolve;
  });
  await page.route('**/api/home/workspace-widgets?*', async route => {
    widgetRequests.push(route.request().url());
    const requestUrl = new URL(route.request().url());
    expect(requestUrl.searchParams.get('workspaceId')).toBe(workspaceId);
    const isEmailFollowUp = requestUrl.searchParams.get('widgets') === 'emails';
    if (options.staleEmailFollowUp && isEmailFollowUp) await emailFollowUpGate;
    const cachedAt = '2026-09-08T12:00:00.000Z';
    const ready = <T,>(data: T) => ({ status: 'ready' as const, data, cachedAt, stale: false });
    const initialEmails = [
      { id: 'mail-sales', accountId: 'sales', accountLabel: 'sales@example.com', folder: 'INBOX', from: 'Mara', subject: 'Launch-Freigabe', date: '2026-09-07T12:00:00Z' },
      { id: 'mail-primary', accountId: 'primary', accountLabel: 'team@example.com', folder: 'INBOX', from: 'Jonas', subject: 'Wochenplanung', date: '2026-09-07T11:00:00Z' },
    ];
    const refreshedEmails = [
      { id: 'mail-refreshed', accountId: 'sales', accountLabel: 'sales@example.com', folder: 'INBOX', from: 'Mara', subject: 'Aktualisierte Freigabe', date: '2026-09-08T12:00:00Z' },
      ...initialEmails,
    ];
    const staleEmails = {
      status: 'ready' as const,
      data: initialEmails,
      cachedAt,
      stale: true,
      cache: {
        enabled: true,
        state: 'stale' as const,
        source: 'cache' as const,
        fetchedAt: cachedAt,
        staleAt: cachedAt,
        expiresAt: '2026-09-15T12:00:00.000Z',
        refreshQueued: true,
        refreshToken: 'home-email-widget-test-token',
        partial: false,
        accountCount: 1,
        successfulAccountCount: 1,
      },
    };
    return route.fulfill({ json: { success: true, data: {
      emails: options.failEmail
        ? { status: 'error', errorCode: 'source_unavailable' }
        : options.staleEmailFollowUp && !isEmailFollowUp
          ? staleEmails
          : ready(options.staleEmailFollowUp ? refreshedEmails : initialEmails),
      todos: ready([{ id: 'todo-critical', title: 'Launch prüfen', priority: 'high', dueAt: '2026-09-08T10:00:00Z', readState: 'unread' }]),
      automation: ready({ id: 'job-latest', name: 'Kampagnen-Report', status: 'active', lastRunAt: '2026-09-07T12:00:00Z', lastRunStatus: 'success', nextRunAt: '2026-09-08T12:00:00Z', resultText: options.longAutomationResult
        ? '**Aktuelle Woche:** KW 36\n- **Wöchentliche Follower-Zahlen** fehlen vollständig für Instagram, LinkedIn, X und mehrere weitere Kanäle mit einem absichtlich sehrlangenwortohnetrennzeichen'.repeat(4)
        : 'Kampagnendaten wurden aktualisiert.' }),
      studio: ready({ id: 'generation-latest', prompt: 'Editoriales Produktbild für den Launch', createdAt: '2026-09-07T12:00:00Z', status: 'completed', output: { id: 'output', mediaUrl: options.brokenStudioImage ? '/images/missing-widget-preview.png' : '/images/examples/aura_serum_produktfoto.png', mimeType: 'image/png' } }),
    } } });
  });
  return { releaseEmailFollowUp, widgetRequests };
}

test('workspace widgets fill page two with stable, directly actionable previews', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  const { widgetRequests } = await mockWidgets(page, workspace.id);
  await page.goto('/de');
  expect(widgetRequests).toHaveLength(0);

  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
  const workspacePage = page.locator('#home-workspace');
  const cards = workspacePage.locator('article[data-testid^="workspace-widget-"]');
  await expect(cards).toHaveCount(4);
  await expect(page.getByTestId('workspace-widget-email-preview').getByText('2 ungelesene Nachrichten')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-todos-preview').getByText('Launch prüfen')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-automation-preview').getByText('Kampagnen-Report')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-studio-preview').getByText('Editoriales Produktbild für den Launch')).toBeVisible();
  await expect.poll(() => page.getByTestId('workspace-widget-studio-preview').locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(widgetRequests).toHaveLength(1);

  const emailCard = page.getByTestId('workspace-widget-email');
  const emailPreview = page.getByTestId('workspace-widget-email-preview');
  await expect(emailPreview.getByText('Launch-Freigabe')).toBeVisible();
  const boxBeforeHover = await emailCard.boundingBox();
  await emailCard.hover();
  await expect(emailPreview.getByText('Launch-Freigabe')).toBeVisible();
  const boxAfterHover = await emailCard.boundingBox();
  expect(boxAfterHover?.width).toBe(boxBeforeHover?.width);
  expect(boxAfterHover?.height).toBe(boxBeforeHover?.height);
  await expect(emailCard.getByRole('link', { name: /Launch-Freigabe/ })).toHaveAttribute('href', /accountId=sales.*messageId=mail-sales/);

  const todoCard = page.getByTestId('workspace-widget-todos');
  await todoCard.getByRole('link', { name: 'To-dos öffnen', exact: true }).focus();
  await expect(todoCard.getByRole('link', { name: /Launch prüfen/ })).toHaveAttribute('href', new RegExp(`todo=todo-critical.*workspaceId=${workspace.id}`));

  const automationCard = page.getByTestId('workspace-widget-automation');
  await expect(automationCard.getByRole('link', { name: /Kampagnen-Report/ })).toHaveAttribute('href', '/de/automations/job-latest');
  await expect(automationCard.getByRole('link', { name: 'Automationen öffnen', exact: true }).last()).toHaveAttribute('href', '/de/automations/job-latest');

  const studioCard = page.getByTestId('workspace-widget-studio');
  const studioPreviewHref = await studioCard.getByRole('link', { name: /Editoriales Produktbild für den Launch/ }).getAttribute('href');
  const studioPreviewUrl = new URL(studioPreviewHref || '', 'http://localhost');
  expect(studioPreviewUrl.pathname).toBe('/de/studio');
  expect(studioPreviewUrl.searchParams.get('workspaceId')).toBe(workspace.id);
  expect(studioPreviewUrl.searchParams.get('generation')).toBe('generation-latest');
  expect(studioPreviewUrl.searchParams.get('output')).toBe('output');

  const firstBox = await cards.nth(0).boundingBox();
  const secondBox = await cards.nth(1).boundingBox();
  expect(firstBox?.height).toBeGreaterThanOrEqual(240);
  expect(Math.abs((firstBox?.height ?? 0) - (secondBox?.height ?? 0))).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('workspace-widgets-desktop.png'), animations: 'disabled' });
});

test('studio widget link switches workspace before opening the requested output', async ({ page }) => {
  const workspace = await prepare(page);
  const workspacesResponse = await page.request.get('/api/workspaces');
  expect(workspacesResponse.ok()).toBeTruthy();
  const workspacePayload = await workspacesResponse.json();
  const previousWorkspace = {
    ...workspace,
    id: 'previous-workspace',
    name: 'Previous workspace',
    isDefault: false,
  };

  await mockWidgets(page, workspace.id);
  await page.goto('/de');
  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
  const studioHref = await page.getByTestId('workspace-widget-studio')
    .getByRole('link', { name: /Editoriales Produktbild für den Launch/ })
    .getAttribute('href');
  expect(studioHref).toBeTruthy();

  await page.route('**/api/workspaces', route => route.fulfill({
    json: {
      ...workspacePayload,
      activeWorkspaceId: previousWorkspace.id,
      workspaces: [previousWorkspace, ...workspacePayload.workspaces],
    },
  }));
  const generationWorkspaceIds: Array<string | undefined> = [];
  await page.route('**/api/studio/generations/generation-latest', route => {
    generationWorkspaceIds.push(route.request().headers()['x-canvas-workspace-id']);
    return route.fulfill({ json: {
      success: true,
      generation: {
        id: 'generation-latest',
        userId: 'widget-test-user',
        mode: 'image',
        prompt: 'Editoriales Produktbild für den Launch',
        rawPrompt: 'Editoriales Produktbild für den Launch',
        provider: 'gemini',
        model: 'gemini-3.1-flash-image',
        aspectRatio: '1:1',
        status: 'completed',
        createdAt: '2026-09-07T12:00:00Z',
        outputs: [{
          id: 'output',
          generationId: 'generation-latest',
          type: 'image',
          filePath: 'studio/outputs/widget-output.png',
          fileName: 'widget-output.png',
          mediaUrl: '/images/examples/aura_serum_produktfoto.png',
          mimeType: 'image/png',
          isFavorite: false,
        }],
      },
    } });
  });
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), previousWorkspace.id);
  await page.goto(studioHref!);

  await expect(page.getByRole('region', { name: 'Studio output preview' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId'))).toBe(workspace.id);
  expect(generationWorkspaceIds.length).toBeGreaterThan(0);
  expect(new Set(generationWorkspaceIds)).toEqual(new Set([workspace.id]));
});

test('touch layout keeps quick selections visible in one column', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workspace = await prepare(page);
  const { widgetRequests } = await mockWidgets(page, workspace.id);
  await page.goto('/de');
  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
  const cards = page.locator('#home-workspace article[data-testid^="workspace-widget-"]');
  await expect(cards).toHaveCount(4);
  await expect.poll(() => widgetRequests.map(request => new URL(request).searchParams.get('widgets'))).toContain('emails,todos,automation,studio');
  await expect(page.getByTestId('workspace-widget-email-preview').getByText('Schnellauswahl')).toBeVisible();
  const [firstBox, secondBox] = await cards.evaluateAll(elements => elements.slice(0, 2).map(element => {
    const box = element.getBoundingClientRect();
    return { y: box.y, height: box.height };
  }));
  expect(secondBox.y).toBeGreaterThan(firstBox.y + firstBox.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('workspace-widgets-mobile.png'), animations: 'disabled' });
});

test('one unavailable source does not block the other workspace widgets', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  await mockWidgets(page, workspace.id, { failEmail: true });
  await page.goto('/de');
  await page.getByRole('navigation', { name: 'Startseitenansichten' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByTestId('workspace-widget-email').getByText('Gerade nicht verfügbar')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-todos-preview').getByText('Launch prüfen')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-automation-preview').getByText('Kampagnen-Report')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-studio-preview').getByText('Editoriales Produktbild für den Launch')).toBeVisible();
});

test('email preview keeps its active click targets stable during a delayed refresh', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  const { releaseEmailFollowUp, widgetRequests } = await mockWidgets(page, workspace.id, { staleEmailFollowUp: true });
  await page.goto('/de');
  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();

  const emailCard = page.getByTestId('workspace-widget-email');
  await expect(emailCard.getByText('Launch-Freigabe')).toBeVisible();
  await emailCard.hover();
  await expect.poll(() => widgetRequests.length).toBe(2);
  releaseEmailFollowUp();
  await page.waitForTimeout(100);
  await expect(emailCard.getByText('Launch-Freigabe')).toBeVisible();
  await expect(emailCard.getByText('Aktualisierte Freigabe')).toBeHidden();

  await page.mouse.move(0, 0);
  await expect(emailCard.getByText('Aktualisierte Freigabe')).toBeVisible();
});

test('workspace widgets keep their hierarchy in dark mode', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  await mockWidgets(page, workspace.id);
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.goto('/de');
  await page.getByRole('navigation', { name: 'Startseitenansichten' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  const studioCard = page.getByTestId('workspace-widget-studio');
  await studioCard.hover();
  await expect(page.getByTestId('workspace-widget-studio-preview').getByText('Editoriales Produktbild für den Launch')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: info.outputPath('workspace-widgets-dark.png'), animations: 'disabled' });
});

test('long automation output stays inside its card and renders as plain preview text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  await mockWidgets(page, workspace.id, { longAutomationResult: true });
  await page.goto('/de');
  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
  const card = page.getByTestId('workspace-widget-automation');
  await card.hover();
  const preview = card.getByText(/Aktuelle Woche:/);
  await expect(preview).toBeVisible();
  await expect(preview).not.toContainText('**');
  const readGeometry = () => card.evaluate(element => {
    const cardBox = element.getBoundingClientRect();
    const footerBox = element.querySelector(':scope > a:last-child')?.getBoundingClientRect();
    const previewBox = element.querySelector('[data-testid$="-preview"]')?.getBoundingClientRect();
    return { cardBottom: cardBox.bottom, previewBottom: previewBox?.bottom, footerBottom: footerBox?.bottom, footerTop: footerBox?.top };
  });
  await expect.poll(async () => {
    const geometry = await readGeometry();
    return (geometry.previewBottom ?? 0) <= (geometry.footerTop ?? 0) + 1;
  }).toBe(true);
  const geometry = await readGeometry();
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.cardBottom + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('broken studio previews fall back without breaking the card', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  await mockWidgets(page, workspace.id, { brokenStudioImage: true });
  await page.goto('/de');
  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
  const preview = page.getByTestId('workspace-widget-studio-preview');
  await expect(preview.locator('img')).toHaveCount(0);
  await expect(preview.getByText('Editoriales Produktbild für den Launch')).toBeVisible();
});
