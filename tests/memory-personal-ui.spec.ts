import { expect, test, type Page } from '@playwright/test';

const EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
const enabled = process.env.E2E_MEMORY_UI === '1' && Boolean(EMAIL && PASSWORD);
const restartPhase = process.env.E2E_MEMORY_RESTART_PHASE;
const restartMemory = process.env.E2E_MEMORY_RESTART_CONTENT
  || 'UI-Neustartprüfung: Antworten sollen klare nächste Schritte enthalten.';

async function login(page: Page) {
  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /email/i }).fill(EMAIL!);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD!);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes('/login'), { waitUntil: 'domcontentloaded' }),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function useGermanAccountLocale(page: Page) {
  const response = await page.request.patch('/api/user-preferences', { data: { locale: 'de' } });
  const payload = await response.json() as { success?: boolean; data?: { locale?: string } };
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  expect(payload.data?.locale).toBe('de');
}

async function openGermanPrivateMemory(page: Page) {
  await page.goto('/de/settings?tab=memory&scope=user', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Memory Manager', { exact: true })).toBeVisible();
  await expect(page.getByText('Memory-Bereiche', { exact: true })).toBeVisible();
  await expect(page.getByText('Memories werden geladen…')).not.toBeVisible();
}

test.describe('Memory Manager settings', () => {
  test.skip(!enabled, 'Requires an explicitly enabled local server and login credentials.');
  test.setTimeout(120_000);

  test('renders private memory and the dedicated review configuration without mutation', async ({ page }, testInfo) => {
    await login(page);
    await page.goto('/en/settings?tab=memory&scope=user', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Memory Manager', { exact: true })).toBeVisible();
    await expect(page.getByText(/Automatic review is optional/i)).toBeVisible();
    const scopeTabs = page.getByRole('tablist', { name: 'Memory scope' });
    await expect(scopeTabs).toBeVisible();
    await expect(scopeTabs.getByRole('button', { name: 'My memory' })).toBeVisible();
    await expect(scopeTabs.getByRole('button', { name: 'Agent memory' })).toBeVisible();
    await expect(scopeTabs.getByRole('button', { name: 'Workspace' })).toBeVisible();
    await expect(scopeTabs.getByRole('button', { name: 'Organization' })).toBeVisible();
    await expect(page.getByText('Memory categories', { exact: true })).toBeVisible();
    await expect(page.getByText('These cards are categories, not projects. Each category groups individual memory entries that remain available over time.')).toBeVisible();
    const reviewerSwitch = page.getByRole('switch', { name: 'Automatic memory review' });
    await expect(reviewerSwitch).toBeVisible();
    await expect(reviewerSwitch).toBeEnabled();
    if (await reviewerSwitch.isChecked()) {
      await expect(page.getByTestId('memory-reviewer-settings')).toBeVisible();
      await expect(page.getByLabel('Organization provider')).toBeVisible();
      await expect(page.getByLabel('Memory Reviewer model')).toBeVisible();
      await expect(page.getByLabel('Prompt budget (tokens)')).toBeVisible();
    } else {
      await expect(page.getByTestId('memory-reviewer-settings')).toHaveCount(0);
      await expect(page.getByLabel('Organization provider')).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: 'Import JSON' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete all private memory' })).toBeVisible();
    await expect(page.getByText('Loading memory…')).not.toBeVisible();

    await scopeTabs.getByRole('button', { name: 'Agent memory' }).click();
    await expect(page.getByText('Agent memory owner', { exact: true })).toBeVisible();
    await expect(page.getByTestId('agent-memory-owner-card')).toBeVisible();
    await expect(page.getByTestId('agent-memory-owner-select')).toBeVisible();
    await expect(page.getByTestId('agent-memory-owner-select')).not.toHaveValue('');
    await expect(page.getByText('Loading memory…')).not.toBeVisible();

    const missingAgentResponse = await page.request.get('/api/memory?scope=agent');
    expect(missingAgentResponse.ok()).toBe(false);

    await page.goto('/en/settings?tab=agent-settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('memory-review-agent-card')).toBeVisible();
    await expect(page.getByText('memory-manager', { exact: true })).toBeVisible();
    await expect(page.getByText('Loading reviewer status…')).not.toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('memory-manager.png'), fullPage: true });
  });

  test('saves reviewer opt-out immediately and progressively hides reviewer controls', async ({ page }) => {
    await login(page);
    await page.goto('/en/settings?tab=memory&scope=user', { waitUntil: 'domcontentloaded' });
    const settingsResponse = await page.request.get('/api/memory?settings=1');
    const settingsPayload = await settingsResponse.json() as {
      success?: boolean;
      data?: { automaticMemoryEnabled?: boolean; memoryReviewWorkerAvailable?: boolean };
    };
    expect(settingsResponse.ok(), JSON.stringify(settingsPayload)).toBeTruthy();
    test.skip(settingsPayload.data?.memoryReviewWorkerAvailable !== true, 'The server-wide worker kill switch is active.');
    const originalEnabled = settingsPayload.data?.automaticMemoryEnabled === true;
    const reviewerSwitch = page.getByRole('switch', { name: 'Automatic memory review' });
    await expect(reviewerSwitch).toBeEnabled();

    if (!await reviewerSwitch.isChecked()) {
      const [enableResponse] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/memory') && response.request().method() === 'PATCH'),
        reviewerSwitch.click(),
      ]);
      expect(enableResponse.ok(), await enableResponse.text()).toBeTruthy();
    }
    await expect(page.getByTestId('memory-reviewer-settings')).toBeVisible();

    const [disableResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/memory') && response.request().method() === 'PATCH'),
      reviewerSwitch.click(),
    ]);
    expect(disableResponse.ok(), await disableResponse.text()).toBeTruthy();
    await expect(reviewerSwitch).not.toBeChecked();
    await expect(page.getByText('No chats are queued or reviewed. Your saved memories and all manual controls remain available.')).toBeVisible();
    await expect(page.getByTestId('memory-reviewer-settings')).toHaveCount(0);
    await expect(page.getByLabel('Organization provider')).toHaveCount(0);
    await expect(page.getByLabel('Memory Reviewer model')).toHaveCount(0);
    await expect(page.getByLabel('Prompt budget (tokens)')).toHaveCount(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('switch', { name: 'Automatic memory review' })).not.toBeChecked();
    await expect(page.getByTestId('memory-reviewer-settings')).toHaveCount(0);

    await page.goto('/en/settings?tab=agent-settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('memory-review-agent-card')).toBeVisible();
    await expect(page.getByTestId('memory-review-agent-disabled-copy')).toBeVisible();
    await expect(page.getByTestId('memory-review-agent-runtime-details')).toHaveCount(0);

    if (originalEnabled) {
      const restore = await page.request.patch('/api/memory', { data: { automaticMemoryEnabled: true } });
      expect(restore.ok(), await restore.text()).toBeTruthy();
    }
  });

  test('shows German category names and keeps a private memory across a server restart', async ({ page }, testInfo) => {
    test.skip(!restartPhase, 'Set E2E_MEMORY_RESTART_PHASE=create or verify for the restart acceptance test.');
    expect(['create', 'verify']).toContain(restartPhase);

    await page.setViewportSize({ width: 1440, height: 1100 });
    await login(page);
    await useGermanAccountLocale(page);
    await openGermanPrivateMemory(page);

    const scopeTabs = page.getByRole('tablist', { name: 'Memory-Bereich' });
    await expect(page.getByText('Memory-Bereiche', { exact: true })).toBeVisible();
    await expect(page.getByText('Diese Karten sind Kategorien, keine Projekte. Jede Kategorie bündelt einzelne, dauerhaft gespeicherte Memory-Einträge.')).toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: /^.*0 Einträge.*$/ })).toHaveCount(0);
    const contextCategory = page.getByRole('button', { name: /^Kontext\b/u }).first();
    await expect(contextCategory).toBeVisible();

    if (restartPhase === 'create') {
      const reviewerSwitch = page.getByRole('switch', { name: 'Automatische Memory-Prüfung' });
      await expect(reviewerSwitch).toBeEnabled();
      if (await reviewerSwitch.isChecked()) {
        const [toggleResponse] = await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/api/memory') && response.request().method() === 'PATCH'),
          reviewerSwitch.click(),
        ]);
        expect(toggleResponse.ok(), await toggleResponse.text()).toBeTruthy();
      }
      await expect(reviewerSwitch).not.toBeChecked();
      await expect(page.getByTestId('memory-reviewer-settings')).toHaveCount(0);
      await page.getByPlaceholder('z. B. Bevorzugt kurze, eindeutige Wochen-Updates.').fill(restartMemory);
      await expect(page.getByRole('button', { name: 'Memory speichern', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Memory speichern', exact: true }).click();
      await expect(page.getByText('Memory wurde gespeichert.', { exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('switch', { name: 'Automatische Memory-Prüfung' })).not.toBeChecked();
      await expect(page.getByTestId('memory-reviewer-settings')).toHaveCount(0);
    }

    await contextCategory.click();

    const selectedCategory = page.getByTestId('selected-memory-category');
    await expect(selectedCategory).toBeVisible();
    await expect(selectedCategory.getByText('Ausgewählter Memory-Bereich', { exact: true })).toBeVisible();
    await expect(selectedCategory.getByText('Kontext', { exact: true })).toBeVisible();
    await expect(selectedCategory.getByText('Gemeinsamer, dauerhaft relevanter Kontext.', { exact: true })).toBeVisible();
    await expect(page.getByText(restartMemory, { exact: true })).toBeVisible();

    const selectedBox = await selectedCategory.boundingBox();
    const memoryBox = await page.getByText(restartMemory, { exact: true }).boundingBox();
    expect(selectedBox).not.toBeNull();
    expect(memoryBox).not.toBeNull();
    expect(memoryBox!.y).toBeGreaterThan(selectedBox!.y + selectedBox!.height - 1);

    const search = page.getByLabel('Memories durchsuchen');
    await search.fill('kein-treffer-fuer-diesen-ui-test');
    await expect(page.getByText('Keine Memory-Einträge entsprechen dieser Suche.', { exact: true })).toBeVisible();
    await search.fill('');
    await expect(page.getByText(restartMemory, { exact: true })).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath(`memory-german-${restartPhase}-desktop.png`), fullPage: true });

    const [organizationResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/memory?scope=organization')),
      scopeTabs.getByRole('button', { name: 'Organisation' }).click(),
    ]);
    expect(organizationResponse.ok(), await organizationResponse.text()).toBeTruthy();
    await expect(page).toHaveURL(/scope=organization/u);
    await expect(page.getByText('Memories werden geladen…')).not.toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: /^.*0 Einträge.*$/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`memory-organization-${restartPhase}-desktop.png`), fullPage: true });

    const [privateResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/memory?scope=user')),
      scopeTabs.getByRole('button', { name: 'Meine Memories' }).click(),
    ]);
    expect(privateResponse.ok(), await privateResponse.text()).toBeTruthy();
    await expect(page.getByText(restartMemory, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const viewportMetrics = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewportMetrics.scrollWidth).toBeLessThanOrEqual(viewportMetrics.clientWidth + 1);
    await page.screenshot({ path: testInfo.outputPath(`memory-german-${restartPhase}-mobile.png`), fullPage: true });

    const preferenceResponse = await page.request.get('/api/user-preferences');
    const preferencePayload = await preferenceResponse.json() as { success?: boolean; data?: { locale?: string } };
    expect(preferenceResponse.ok(), JSON.stringify(preferencePayload)).toBeTruthy();
    expect(preferencePayload.data?.locale).toBe('de');
  });
});
