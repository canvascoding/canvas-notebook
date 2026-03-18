import { test, expect, type Browser, type Page } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = 'test-results/skills-modal-auth.json';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/', { timeout: 15_000 });
}

test.describe('Skill modal layout', () => {
  test.setTimeout(60_000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test('keeps the docs dialog inside the viewport and scrollable on desktop and mobile', async ({ page }) => {
    await page.goto('/skills');

    await page.getByRole('button', { name: 'Docs' }).first().click();

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
