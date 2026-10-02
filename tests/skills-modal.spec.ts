import { test, expect, type Browser, type Page } from '@playwright/test';
import { chmod } from 'node:fs/promises';
import type { CanvasSkill } from '../app/lib/skills/canvas-skill-manifest';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = 'test-results/skills-modal-auth.json';

async function login(page: Page) {
  await page.goto('/en/login');
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toMatch(/^\/en\/?$/);
}

test.describe('Skill modal layout', () => {
  test.setTimeout(60_000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    try {
      const page = await context.newPage();
      await login(page);
      await context.storageState({ path: AUTH_STATE_PATH });
      await chmod(AUTH_STATE_PATH, 0o600);
    } finally {
      await context.close();
    }
  });

  test('keeps the docs dialog inside the viewport and scrollable on desktop and mobile', async ({ page }) => {
    const skillsResponse = await page.request.get('/api/skills?scope=user');
    expect(skillsResponse.status()).toBe(200);
    const skillsPayload = await skillsResponse.json();
    expect(skillsPayload.success).toBe(true);
    const coreSkills = (skillsPayload.skills as CanvasSkill[])
      .filter(skill => (skill.core || skill.sourceType === 'core') && typeof skill.content === 'string')
      .sort((left, right) => right.content.length - left.content.length);
    expect(coreSkills.length, 'A built-in skill is required for the read-only documentation layout check.').toBeGreaterThan(0);
    const skill = coreSkills[0];
    await page.goto('/en/settings?tab=skills');
    await page.getByRole('tab', { name: 'Skills', exact: true }).click();
    const skillRow = page.getByTestId('skills-tree-scroll').getByRole('button')
      .filter({ has: page.getByText(skill.name, { exact: true }) });
    await expect(skillRow).toHaveCount(1);
    await skillRow.click();
    const documentation = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/skills/${encodeURIComponent(skill.name)}/readme`
        && response.request().method() === 'GET';
    });
    await page.getByRole('button', { name: 'View documentation', exact: true }).click();
    const documentationResponse = await documentation;
    expect(documentationResponse.status()).toBe(200);
    const documentationPayload = await documentationResponse.json();
    expect(documentationPayload.success).toBe(true);
    expect(typeof documentationPayload.content).toBe('string');
    expect(documentationPayload.content.length).toBeGreaterThan(1_000);

    const dialog = page.getByTestId('skill-detail-dialog');
    const scrollArea = page.getByTestId('skill-detail-scroll-area');
    const closeButton = page.getByTestId('skill-detail-close');

    await expect(dialog).toBeVisible();
    await expect(closeButton).toBeVisible();

    const desktopViewport = page.viewportSize();
    const desktopBox = await dialog.boundingBox();
    expect(desktopViewport).not.toBeNull();
    expect(desktopBox).not.toBeNull();

    const desktopWidth = desktopViewport?.width ?? 0;
    const desktopHeight = desktopViewport?.height ?? 0;
    expect(desktopBox!.x).toBeGreaterThanOrEqual(0);
    expect(desktopBox!.y).toBeGreaterThanOrEqual(0);
    expect(desktopBox!.x + desktopBox!.width).toBeLessThanOrEqual(desktopWidth);
    expect(desktopBox!.y + desktopBox!.height).toBeLessThanOrEqual(desktopHeight);

    const desktopScrollMetrics = await scrollArea.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(desktopScrollMetrics.scrollHeight).toBeGreaterThan(desktopScrollMetrics.clientHeight);

    await scrollArea.hover();
    await page.mouse.wheel(0, 1200);

    await expect
      .poll(() => scrollArea.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(desktopScrollMetrics.scrollTop);

    await page.setViewportSize({ width: 390, height: 844 });

    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return box && Math.max(Math.abs(box.x), Math.abs(box.y),
        Math.abs(box.width - 390), Math.abs(box.height - 844));
    }, { message: 'The documentation dialog must fill the settled mobile viewport.' }).toBeLessThan(0.05);

    const mobileBox = await dialog.boundingBox();
    expect(mobileBox).not.toBeNull();

    expect(mobileBox!.x).toBeCloseTo(0, 1);
    expect(mobileBox!.y).toBeCloseTo(0, 1);
    expect(mobileBox!.width).toBeCloseTo(390, 1);
    expect(mobileBox!.height).toBeCloseTo(844, 1);
    await expect(closeButton).toBeVisible();

    const mobileScrollTop = await scrollArea.evaluate((element) => {
      element.scrollTop = 0;
      return element.scrollTop;
    });
    await scrollArea.evaluate((element) => {
      element.scrollTop = 600;
    });
    await expect
      .poll(() => scrollArea.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(mobileScrollTop);
  });
});
