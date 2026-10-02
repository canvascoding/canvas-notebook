import { expect, test, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { createAuthenticatedContext } from './helpers/managed-test-context';
import {
  readDocumentReviewEnabled,
  readStudioBulkAvailability,
  setStudioBulkEnabled,
} from './helpers/studio-bulk-experimental';

const bulkHeading = /^(?:Bulk Generate|Bulk-Generierung)$/;
const launcherLabel = /^(?:Apps öffnen|Open apps)$/;
const studioActionsLabel = /^(?:Studio-Aktionen öffnen|Open Studio actions)$/;
const studioPath = /\/studio\/?$/;
const bulkPath = /\/studio\/bulk\/?$/;

// QA inventory: admin setting off/on and persistence; unchanged Document Review;
// regular member UI/API restriction; desktop/mobile Studio navigation and launcher;
// direct deep links and live removal across open pages; web/mobile creation denied;
// cold/delayed WS availability and unavailable transport fail closed. No enabled
// job is submitted, so this suite never invokes a generation provider.
test.describe('Studio Bulk experimental feature', () => {
  test.describe.configure({ mode: 'serial' });

  test('admin toggle controls desktop, mobile, launcher, direct routes, and creation permissions', async ({ browser }, testInfo) => {
    test.setTimeout(360_000);
    const admin = await createAuthenticatedContext(browser, { viewport: { width: 1480, height: 1000 } });
    const memberEmail = process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
    const memberPassword = process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    expect(Boolean(memberEmail && memberPassword), 'Managed non-admin credentials are required').toBe(true);
    const member = await createAuthenticatedContext(browser, { viewport: { width: 1480, height: 1000 } }, {
      email: memberEmail, password: memberPassword,
    });
    const mobile = await createAuthenticatedContext(browser, {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    });
    const anonymous = await browser.newContext({ baseURL: process.env.BASE_URL });
    for (const context of [admin, member, mobile, anonymous]) {
      context.setDefaultTimeout(30_000);
      context.setDefaultNavigationTimeout(30_000);
    }
    const initial = await readStudioBulkAvailability(admin.request);
    const initialDocumentReview = await readDocumentReviewEnabled(admin.request);
    const errors: string[] = [];
    const settings = await admin.newPage();
    const desktop = await admin.newPage();
    const memberPage = await member.newPage();
    const mobilePage = await mobile.newPage();
    for (const [label, page] of [['settings', settings], ['desktop', desktop],
      ['member', memberPage], ['mobile', mobilePage]] as const) {
      page.on('pageerror', error => {
        const message = `${label} ${new URL(page.url()).pathname}: ${error.message}`;
        errors.push(message);
        console.info(`[studio-bulk-e2e] pageerror ${message}`);
      });
    }

    try {
      await test.step('Default disabled view and instance-admin-only controls', async () => {
        await setStudioBulkEnabled(admin.request, false);
        await settings.goto('/settings?tab=experimental', { waitUntil: 'domcontentloaded' });
        await expect(settings.locator('#studio-bulk-enabled')).toBeEnabled();
        await expect(settings.locator('#studio-bulk-enabled')).not.toBeChecked();
        await expect(settings.locator('#document-review-enabled')).toBeChecked({ checked: initialDocumentReview });
        await capture(settings, testInfo, 'admin-experimental-disabled');

        await desktop.goto('/studio', { waitUntil: 'domcontentloaded' });
        await expect(desktop.getByRole('navigation', { name: 'Studio', exact: true })).toBeVisible();
        await expect(desktop.locator('a[href$="/studio/bulk"]')).toHaveCount(0);
        await assertLauncherBulk(desktop, false);
        await capture(desktop, testInfo, 'desktop-disabled');

        console.info('[studio-bulk-e2e] disabled: mobile navigation to Studio');
        await mobilePage.goto('/studio', { waitUntil: 'domcontentloaded' });
        console.info('[studio-bulk-e2e] disabled: mobile Studio menu');
        await assertMobileNavigation(mobilePage, false);
        console.info('[studio-bulk-e2e] disabled: mobile launcher');
        await assertLauncherBulk(mobilePage, false);
        await expectNoHorizontalOverflow(mobilePage);

        console.info('[studio-bulk-e2e] disabled: member experimental settings');
        await memberPage.goto('/settings?tab=experimental', { waitUntil: 'domcontentloaded' });
        await expect(memberPage.getByRole('heading', { name: /^(?:Settings|Einstellungen)$/ }).first()).toBeVisible();
        await expect(memberPage.locator('#studio-bulk-enabled')).toHaveCount(0);
        expect((await readStudioBulkAvailability(member.request)).studioBulkEnabled).toBe(false);
        console.info('[studio-bulk-e2e] disabled: member toggle denied');
        const denied = await member.request.patch('/api/admin/experimental-settings', {
          headers: { Origin: process.env.BASE_URL! }, data: { studioBulkEnabled: true },
        });
        expect(denied.status()).toBe(403);
        expect((await readStudioBulkAvailability(admin.request)).studioBulkEnabled).toBe(false);
        console.info('[studio-bulk-e2e] disabled: anonymous availability denied');
        expect((await anonymous.request.get('/api/studio/bulk/availability')).status()).toBe(401);
        console.info('[studio-bulk-e2e] disabled: anonymous toggle denied');
        expect((await anonymous.request.patch('/api/admin/experimental-settings', {
          data: { studioBulkEnabled: true },
        })).status()).toBe(401);
        console.info('[studio-bulk-e2e] disabled: first phase complete');
      });

      await test.step('Disabled deep links redirect on desktop and mobile', async () => {
        for (const page of [desktop, mobilePage, memberPage]) {
          await page.goto('/studio/bulk', { waitUntil: 'domcontentloaded' });
          await expect(page).toHaveURL(studioPath);
          await expect(page.getByRole('heading', { name: bulkHeading })).toHaveCount(0);
        }
      });

      await test.step('Enable from the real admin UI, persist, and update open views', async () => {
        await toggleFromSettings(settings, true);
        expect((await readStudioBulkAvailability(admin.request)).studioBulkEnabled).toBe(true);
        await settings.reload({ waitUntil: 'domcontentloaded' });
        await expect(settings.locator('#studio-bulk-enabled')).toBeEnabled();
        await expect(settings.locator('#studio-bulk-enabled')).toBeChecked();
        await expect(settings.locator('#document-review-enabled')).toBeChecked({ checked: initialDocumentReview });
        await capture(settings, testInfo, 'admin-experimental-enabled');

        // desktop/member/mobile were loaded while off; this exercises WS delivery
        // without reloading those pages after the admin enables the feature.
        await expect(desktop.getByRole('navigation', { name: 'Studio', exact: true })
          .getByRole('link', { name: 'Bulk', exact: true })).toBeVisible();
        await assertLauncherBulk(desktop, true);
        await assertMobileNavigation(mobilePage, true);
        await assertLauncherBulk(mobilePage, true);
        await expect(memberPage.getByRole('navigation', { name: 'Studio', exact: true })
          .getByRole('link', { name: 'Bulk', exact: true })).toBeVisible();

        await desktop.getByRole('navigation', { name: 'Studio', exact: true })
          .getByRole('link', { name: 'Bulk', exact: true }).click();
        await expect(desktop).toHaveURL(bulkPath);
        await expect(desktop.getByRole('heading', { name: bulkHeading })).toBeVisible();
        await capture(desktop, testInfo, 'desktop-enabled-bulk');
        await memberPage.goto('/studio/bulk', { waitUntil: 'domcontentloaded' });
        await expect(memberPage).toHaveURL(bulkPath);
        await expect(memberPage.getByRole('heading', { name: bulkHeading })).toBeVisible();
        await mobilePage.goto('/studio/bulk', { waitUntil: 'domcontentloaded' });
        await expect(mobilePage).toHaveURL(bulkPath);
        await expect(mobilePage.getByRole('heading', { name: bulkHeading })).toBeVisible();
        await expectNoHorizontalOverflow(mobilePage);
        await capture(mobilePage, testInfo, 'mobile-enabled-bulk');
      });

      await test.step('Enabled ordinary members reach product validation through web and mobile APIs', async () => {
        const before = await member.request.get('/api/studio/bulk');
        expect(before.status(), 'Ordinary member reads their existing workspace jobs').toBe(200);
        const jobs = (await before.json()).jobs as Array<{ id: string; status: string }>;
        expect(jobs.filter(job => ['pending', 'processing'].includes(job.status)),
          'Member workspace has no active jobs that could hide product validation behind the concurrency guard').toEqual([]);
        const productId = randomUUID();
        const web = await member.request.post('/api/studio/bulk', {
          headers: { Origin: process.env.BASE_URL! },
          data: { product_ids: [productId], prompt: 'Member permission E2E; nonexistent product', aspect_ratio: '1:1' },
        });
        expect(web.status()).toBe(400);
        expect(await web.json()).toMatchObject({ success: false, error: 'Produkt nicht gefunden.' });
        const nativeMobile = await member.request.post('/api/mobile/v1/studio/bulk', {
          headers: { Origin: process.env.BASE_URL! },
          data: { productIds: [productId], prompt: 'Member permission E2E; nonexistent product', aspectRatio: '1:1' },
        });
        expect(nativeMobile.status()).toBe(404);
        expect(await nativeMobile.json()).toMatchObject({ success: false, code: 'NOT_FOUND' });
        const after = await member.request.get('/api/studio/bulk');
        expect(after.status()).toBe(200);
        expect((await after.json()).jobs.map((job: { id: string }) => job.id).sort())
          .toEqual(jobs.map(job => job.id).sort());
      });

      await test.step('Live disable removes the bulk view in all open browser contexts', async () => {
        await toggleFromSettings(settings, false);
        for (const page of [desktop, memberPage, mobilePage]) {
          await expect(page).toHaveURL(studioPath);
          await expect(page.getByRole('heading', { name: bulkHeading })).toHaveCount(0);
          await expect(page.locator('a[href$="/studio/bulk"]')).toHaveCount(0);
        }
        await assertLauncherBulk(desktop, false);
        await assertMobileNavigation(mobilePage, false);
        await assertLauncherBulk(mobilePage, false);
        await capture(mobilePage, testInfo, 'mobile-disabled-live');
        await settings.reload({ waitUntil: 'domcontentloaded' });
        await expect(settings.locator('#studio-bulk-enabled')).toBeEnabled();
        await expect(settings.locator('#studio-bulk-enabled')).not.toBeChecked();
      });

      await test.step('Denied web/mobile submissions create no jobs and leave settings unchanged', async () => {
        const before = await admin.request.get('/api/studio/bulk');
        expect(before.status()).toBe(200);
        const existingIds = (await before.json()).jobs.map((job: { id: string }) => job.id).sort();
        const productId = randomUUID();
        const web = await admin.request.post('/api/studio/bulk', {
          headers: { Origin: process.env.BASE_URL! },
          data: { product_ids: [productId], prompt: 'Disabled experimental E2E', aspect_ratio: '1:1' },
        });
        const nativeMobile = await admin.request.post('/api/mobile/v1/studio/bulk', {
          headers: { Origin: process.env.BASE_URL! },
          data: { productIds: [productId], prompt: 'Disabled experimental E2E', aspectRatio: '1:1' },
        });
        for (const response of [web, nativeMobile]) {
          expect(response.status()).toBe(403);
          expect(await response.json()).toMatchObject({ success: false, code: 'STUDIO_BULK_DISABLED' });
        }
        const after = await admin.request.get('/api/studio/bulk');
        expect(after.status()).toBe(200);
        expect((await after.json()).jobs.map((job: { id: string }) => job.id).sort()).toEqual(existingIds);
        const malformed = await admin.request.patch('/api/admin/experimental-settings', {
          headers: { Origin: process.env.BASE_URL! }, data: { studioBulkEnabled: 'true' },
        });
        expect(malformed.status()).toBe(400);
        expect((await readStudioBulkAvailability(admin.request)).studioBulkEnabled).toBe(false);
        expect(await readDocumentReviewEnabled(admin.request)).toBe(initialDocumentReview);
        expect(errors, 'No uncaught errors across settings and Studio pages').toEqual([]);
      });
    } finally {
      try {
        await setStudioBulkEnabled(admin.request, initial.studioBulkEnabled);
        expect(await readDocumentReviewEnabled(admin.request)).toBe(initialDocumentReview);
      } finally {
        await Promise.all([admin.close(), member.close(), mobile.close(), anonymous.close()]);
      }
    }
  });

  test('cold or delayed availability hides bulk until the real snapshot and hides it on socket failure', async ({ browser }, testInfo) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1480, height: 1000 } });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
    const initial = await readStudioBulkAvailability(context.request);
    const initialDocumentReview = await readDocumentReviewEnabled(context.request);
    const page = await context.newPage();
    const deepLink = await context.newPage();
    let hold = true;
    const held: Array<{ socket: WebSocketRoute; message: string | Buffer }> = [];
    const sockets: WebSocketRoute[] = [];
    for (const target of [page, deepLink]) {
      await target.routeWebSocket('**/ws/live-events', socket => {
        sockets.push(socket);
        const server = socket.connectToServer();
        const bulkIds = new Set<string>();
        socket.onMessage(message => {
          const subscription = JSON.parse(message.toString());
          if (subscription.type === 'subscribe' && subscription.channel === 'studioBulk') bulkIds.add(subscription.id);
          server.send(message);
        });
        server.onMessage(message => {
          const frame = JSON.parse(message.toString());
          if (hold && bulkIds.has(frame.id)) held.push({ socket, message });
          else socket.send(message);
        });
      });
    }
    const release = () => {
      hold = false;
      for (const frame of held.splice(0)) frame.socket.send(frame.message);
    };

    try {
      await setStudioBulkEnabled(context.request, true);
      await page.goto('/studio', { waitUntil: 'domcontentloaded' });
      await deepLink.goto('/studio/bulk', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => held.length, { message: 'The real server Bulk snapshot is held' }).toBeGreaterThanOrEqual(2);
      await expect(page.getByRole('navigation', { name: 'Studio', exact: true })).toBeVisible();
      await expect(page.locator('a[href$="/studio/bulk"]')).toHaveCount(0);
      await assertLauncherBulk(page, false);
      await expect(deepLink.getByRole('heading', { name: bulkHeading })).toHaveCount(0);
      await expect(deepLink.locator('a[href$="/studio/bulk"]')).toHaveCount(0);
      await capture(page, testInfo, 'desktop-delayed-availability');
      release();
      await expect(page.getByRole('navigation', { name: 'Studio', exact: true })
        .getByRole('link', { name: 'Bulk', exact: true })).toBeVisible();
      await expect(deepLink.getByRole('heading', { name: bulkHeading })).toBeVisible();

      // Close the real connection, then hold its reconnect snapshot. Any old
      // enabled state must disappear while the transport is unavailable.
      hold = true;
      await sockets[0].close({ code: 1011, reason: 'Experimental availability reconnect E2E' });
      await expect(page.locator('a[href$="/studio/bulk"]')).toHaveCount(0);
      await assertLauncherBulk(page, false);
      await expect.poll(() => held.length, { message: 'Reconnect gets another real server snapshot' }).toBeGreaterThan(0);
      release();
      await expect(page.getByRole('navigation', { name: 'Studio', exact: true })
        .getByRole('link', { name: 'Bulk', exact: true })).toBeVisible();
    } finally {
      try {
        release();
        await setStudioBulkEnabled(context.request, initial.studioBulkEnabled);
        expect(await readDocumentReviewEnabled(context.request)).toBe(initialDocumentReview);
      } finally {
        await context.close();
      }
    }
  });
});

async function toggleFromSettings(page: Page, enabled: boolean): Promise<void> {
  const switchControl = page.locator('#studio-bulk-enabled');
  await expect(switchControl).toBeEnabled();
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/admin/experimental-settings')
    && response.request().method() === 'PATCH');
  await switchControl.click();
  const response = await responsePromise;
  expect(response.status(), 'Real admin toggle saves through the server').toBe(200);
  expect((await response.json()).data.studioBulkEnabled).toBe(enabled);
  await expect(switchControl).toBeChecked({ checked: enabled });
}

async function assertLauncherBulk(page: Page, enabled: boolean): Promise<void> {
  console.info(`[studio-bulk-e2e] launcher ${enabled ? 'enabled' : 'disabled'}: open apps at ${new URL(page.url()).pathname}`);
  await page.getByRole('button', { name: launcherLabel }).click();
  console.info('[studio-bulk-e2e] launcher: open Studio actions');
  await page.getByLabel(studioActionsLabel).click();
  const panel = page.viewportSize()!.width < 768
    ? page.getByRole('dialog')
    : page.getByRole('menu', { name: launcherLabel });
  await expect(panel).toBeVisible();
  const bulk = panel.locator('a[href$="/studio/bulk"]');
  if (enabled) await expect(bulk).toBeVisible();
  else await expect(bulk).toHaveCount(0);
  console.info('[studio-bulk-e2e] launcher: close actions');
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
}

async function assertMobileNavigation(page: Page, enabled: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /^(?:Models|Modelle)$/ })).toBeVisible();
  const bulk = menu.locator('a[href$="/studio/bulk"]');
  if (enabled) await expect(bulk).toBeVisible();
  else await expect(bulk).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'Studio stays within the mobile viewport').toBe(true);
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}
