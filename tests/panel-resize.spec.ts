import { expect, test, type Locator, type Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL },
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });

  expect(response.ok()).toBeTruthy();
}

async function expectStableHover(handle: Locator, controlledPanel: Locator) {
  const handleBefore = await handle.boundingBox();
  const panelBefore = await controlledPanel.boundingBox();
  expect(handleBefore).not.toBeNull();
  expect(panelBefore).not.toBeNull();

  await handle.hover();

  const handleAfter = await handle.boundingBox();
  const panelAfter = await controlledPanel.boundingBox();
  expect(handleAfter).not.toBeNull();
  expect(panelAfter).not.toBeNull();
  expect(handleAfter!.width).toBe(1);
  expect(Math.abs(handleAfter!.x - handleBefore!.x)).toBeLessThan(0.5);
  expect(Math.abs(panelAfter!.x - panelBefore!.x)).toBeLessThan(0.5);
  expect(Math.abs(panelAfter!.width - panelBefore!.width)).toBeLessThan(0.5);
}

async function dragVerticalHandle(page: Page, handle: Locator, deltaX: number) {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();

  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await expect(handle).toHaveAttribute('data-resizing', 'true');
  await page.mouse.move(startX + deltaX, startY, { steps: 8 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('data-resizing', 'false');
}

test.describe('panel resizing', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Notebook handles remain layout-stable and support pointer, keyboard, and persistence', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      if (window.localStorage.getItem('canvas.notebookDesktopSidebarVisible') === null) {
        window.localStorage.setItem('canvas.notebookDesktopSidebarVisible', 'true');
      }
      if (window.localStorage.getItem('canvas.leftSidebarWidth') === null) {
        window.localStorage.setItem('canvas.leftSidebarWidth', '410');
      }
      if (window.localStorage.getItem('canvas.notebookChatWidth') === null) {
        window.localStorage.setItem('canvas.notebookChatWidth', '420');
      }
    });
    await page.goto('/en/notebook');

    const explorerHandle = page.getByTestId('notebook-explorer-resize-handle');
    const explorer = page.locator('#onboarding-notebook-fileBrowser');
    await expect(explorerHandle).toBeVisible();
    await expectStableHover(explorerHandle, explorer);

    const explorerWidthBefore = (await explorer.boundingBox())!.width;
    await dragVerticalHandle(page, explorerHandle, 70);
    await expect.poll(async () => (await explorer.boundingBox())!.width).toBeCloseTo(explorerWidthBefore + 70, 0);
    await expect(explorerHandle).toHaveAttribute('aria-valuenow', String(Math.round(explorerWidthBefore + 70)));

    const chatModeMenu = page.getByRole('button', { name: /open chat mode menu/i });
    await chatModeMenu.click();
    await page.getByRole('menuitemradio', { name: /side panel/i }).click();

    const chatHandle = page.getByTestId('notebook-chat-resize-handle');
    const chat = page.locator('#onboarding-notebook-chat');
    await expect(chatHandle).toBeVisible();
    await expectStableHover(chatHandle, chat);

    const chatWidthBefore = (await chat.boundingBox())!.width;
    await dragVerticalHandle(page, chatHandle, -60);
    await expect.poll(async () => (await chat.boundingBox())!.width).toBeCloseTo(chatWidthBefore + 60, 0);

    await chatHandle.focus();
    await chatHandle.press('ArrowLeft');
    await expect.poll(async () => (await chat.boundingBox())!.width).toBeCloseTo(chatWidthBefore + 70, 0);

    await page.reload();
    await expect(explorerHandle).toHaveAttribute('aria-valuenow', String(Math.round(explorerWidthBefore + 70)));
    await chatModeMenu.click();
    await page.getByRole('menuitemradio', { name: /side panel/i }).click();
    await expect(chatHandle).toHaveAttribute('aria-valuenow', String(Math.round(chatWidthBefore + 70)));
  });

  test('shared chat dock uses the same smooth drag behavior', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      if (window.localStorage.getItem('studio.chatVisible') === null) {
        window.localStorage.setItem('studio.chatVisible', 'true');
      }
      if (window.localStorage.getItem('studio.chatWidth') === null) {
        window.localStorage.setItem('studio.chatWidth', '420');
      }
    });
    await page.goto('/en/studio');

    const handle = page.getByTestId('chat-dock-resize-handle');
    const dock = page.getByTestId('chat-dock-desktop');
    await expect(handle).toBeVisible();
    await expectStableHover(handle, dock);

    const widthBefore = (await dock.boundingBox())!.width;
    await dragVerticalHandle(page, handle, -50);
    await expect.poll(async () => (await dock.boundingBox())!.width).toBeCloseTo(widthBefore + 50, 0);
    await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round(widthBefore + 50)));
  });

  test('responsive layouts replace squeezed side docks with overlays and sheets', async ({ page }) => {
    await page.setViewportSize({ width: 850, height: 800 });
    await page.addInitScript(() => {
      if (window.localStorage.getItem('todos.chatVisible') === null) {
        window.localStorage.setItem('todos.chatVisible', 'true');
      }
      if (window.localStorage.getItem('todos.chatWidth') === null) {
        window.localStorage.setItem('todos.chatWidth', '420');
      }
    });
    await page.goto('/en/todos');

    const desktopDock = page.getByTestId('chat-dock-desktop');
    await expect(desktopDock).toHaveAttribute('data-chat-mode', 'responsive-overlay');
    await expect(page.getByTestId('chat-dock-resize-handle')).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId('chat-dock-resize-handle')).toHaveCount(0);
    await expect(page.getByTestId('chat-dock-desktop')).toHaveCount(0);
    await page.getByTestId('chat-dock-toggle').click();
    await expect(page.getByTestId('chat-dock-mobile-sheet')).toBeVisible();
  });

  test('reduced-motion preference removes resize transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/en/studio');

    const handle = page.getByTestId('chat-dock-resize-handle');
    const dock = page.getByTestId('chat-dock-desktop');
    await expect(handle).toBeVisible();
    expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

    const handleTransition = await handle.locator('.resize-handle-line').evaluate((element) => getComputedStyle(element).transitionProperty);
    const dockTransition = await dock.evaluate((element) => getComputedStyle(element).transitionProperty);
    expect(handleTransition).toBe('none');
    expect(dockTransition).toBe('none');
  });
});
