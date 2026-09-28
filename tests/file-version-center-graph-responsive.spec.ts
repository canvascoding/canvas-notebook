import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const BASE_TEXT = '# Proposal review fixture\n\nPlan: 100 USD.\n';
const DEEP_BASE_TEXT = '# Deep proposal fixture\n\nA0|B0|C0|D0|E0|F0\n';
const execFileAsync = promisify(execFile);

type Fixture = { scope: { lineageId: string; documentId: string };
  proposals: Array<{ label: string; operationId: string }> };
type DeepFixture = { scope: Fixture['scope']; proposals: Array<{ label: string; proposalId: string; operationId: string;
  parentProposalId: string | null }> };

async function createGraphFixture(input: {
  userId: string; role: string; workspaceId: string; documentId: string; filePath: string;
}): Promise<Fixture> {
  const encoded = Buffer.from(JSON.stringify({ scenario: 'conflict', ...input })).toString('base64url');
  const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
    '--conditions', 'react-server', 'scripts/fvrc-1006-browser-fixture.ts', encoded,
  ], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024, timeout: 60_000 });
  for (const line of result.stdout.trim().split('\n').reverse()) {
    try { return JSON.parse(line) as Fixture; } catch { /* Ignore non-receipt output. */ }
  }
  throw new Error('The graph fixture returned no receipt.');
}

async function createDeepGraphFixture(input: {
  userId: string; role: string; workspaceId: string; documentId: string; filePath: string;
}): Promise<DeepFixture> {
  const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
  const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
    '--conditions', 'react-server', 'scripts/fvrc-1006-responsive-deep-fixture.ts', encoded,
  ], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024, timeout: 120_000 });
  for (const line of result.stdout.trim().split('\n').reverse()) {
    try { return JSON.parse(line) as DeepFixture; } catch { /* Ignore non-receipt output. */ }
  }
  throw new Error('The deep graph fixture returned no receipt.');
}

async function openGraph(page: Page, input: {
  locale: 'en' | 'de'; workspaceId: string; lineageId: string; operationId: string;
}) {
  const request: FileVersionCenterRequestV1 = { contractVersion: 1,
    target: { kind: 'lineage', workspaceId: input.workspaceId, lineageId: input.lineageId },
    selectedEntry: { kind: 'agent_operation', id: input.operationId }, initialView: 'reviews', source: 'deep_link' };
  await page.goto(buildFileVersionCenterDeepLinkV1(`/${input.locale}`, request));
  const center = page.getByTestId('file-version-center');
  const graph = center.getByTestId('graph-review-comparison');
  await expect(graph).toBeVisible({ timeout: 30_000 });
  return { center, graph, layout: center.getByTestId('file-version-center-responsive-layout'),
    timeline: center.getByRole('navigation', { includeHidden: true }) };
}

async function expectNoOuterHorizontalOverflow(page: Page) {
  const fit = await page.evaluate(() => {
    const center = document.querySelector('[data-testid="file-version-center"]') as HTMLElement;
    const layout = document.querySelector('[data-testid="file-version-center-responsive-layout"]') as HTMLElement;
    const graph = document.querySelector('[data-testid="graph-review-comparison"]') as HTMLElement;
    const centerBounds = center.getBoundingClientRect();
    const layoutBounds = layout.getBoundingClientRect();
    const graphBounds = graph.getBoundingClientRect();
    return { viewport: window.innerWidth, document: document.documentElement.scrollWidth,
      center: center.scrollWidth - center.clientWidth, layout: layout.scrollWidth - layout.clientWidth,
      graph: graph.scrollWidth - graph.clientWidth,
      bounds: [centerBounds, layoutBounds, graphBounds].map((rect) => ({ left: rect.left, right: rect.right })) };
  });
  expect(fit.document).toBeLessThanOrEqual(fit.viewport + 1);
  expect(fit.center).toBeLessThanOrEqual(1);
  expect(fit.layout).toBeLessThanOrEqual(1);
  expect(fit.graph).toBeLessThanOrEqual(1);
  for (const bounds of fit.bounds) {
    expect(bounds.left, 'each pane starts inside the viewport').toBeGreaterThanOrEqual(-1);
    expect(bounds.right, 'each pane ends inside the viewport').toBeLessThanOrEqual(fit.viewport + 1);
  }
}

async function expectGraphFooterControlsFit(graph: Locator) {
  const fit = await graph.getByTestId('graph-review-footer').evaluate((footer) => {
    const frame = footer.getBoundingClientRect();
    return {
      footerOverflow: footer.scrollWidth - footer.clientWidth,
      buttons: [...footer.querySelectorAll('button')].map((button) => {
        const rect = button.getBoundingClientRect();
        return { label: button.textContent?.trim() ?? '', left: rect.left, right: rect.right,
          textOverflow: button.scrollWidth - button.clientWidth,
          verticalOverflow: button.scrollHeight - button.clientHeight,
          paneLeft: frame.left, paneRight: frame.right, viewportWidth: window.innerWidth };
      }),
    };
  });
  expect(fit.buttons.length).toBeGreaterThan(0);
  expect(fit.footerOverflow).toBeLessThanOrEqual(2);
  for (const button of fit.buttons) {
    expect(button.left, `${button.label} starts inside the graph footer`).toBeGreaterThanOrEqual(button.paneLeft - 1);
    expect(button.right, `${button.label} ends inside the graph footer`).toBeLessThanOrEqual(button.paneRight + 1);
    expect(button.left, `${button.label} stays in the viewport`).toBeGreaterThanOrEqual(-1);
    expect(button.right, `${button.label} stays in the viewport`).toBeLessThanOrEqual(button.viewportWidth + 1);
    expect(button.textOverflow, `${button.label} is not horizontally clipped`).toBeLessThanOrEqual(2);
    expect(button.verticalOverflow, `${button.label} is not vertically clipped`).toBeLessThanOrEqual(2);
  }
}

async function expectMobileGraphReadingArea(layout: Locator, graph: Locator, minimumHeight = 192) {
  const timelinePane = layout.getByTestId('file-version-center-mobile-timeline-pane');
  const comparisonPane = layout.getByTestId('file-version-center-mobile-comparison-pane');
  const body = graph.getByTestId('graph-review-body');
  const footer = graph.getByTestId('graph-review-footer');
  await expect(layout).toHaveAttribute('data-mobile-pane', 'comparison');
  await expect(timelinePane).toBeHidden();
  await expect(comparisonPane).toBeVisible();
  await expect(body).toBeVisible();
  await expect(footer).toBeVisible();
  // The comparison owns the mobile viewport. Its content scrolls inside the
  // body while the header and action footer remain available.
  const readingArea = await body.evaluate((element) => {
    const bodyRect = element.getBoundingClientRect();
    const outer = element.closest<HTMLElement>('[data-testid="file-version-center-responsive-layout"]');
    if (!outer) throw new Error('The graph body has no outer mobile scroll layout.');
    let top = Math.max(0, bodyRect.top);
    let bottom = Math.min(window.innerHeight, bodyRect.bottom);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
        const rect = ancestor.getBoundingClientRect();
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
    }
    element.scrollTop = 0;
    const available = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.min(120, available);
    return { height: bodyRect.height, visible: Math.max(0, bottom - top),
      available, moved: element.scrollTop,
      outerAvailable: outer.scrollHeight - outer.clientHeight, outerScrollTop: outer.scrollTop };
  });
  expect(readingArea.height, 'mobile comparison body keeps the required reading space').toBeGreaterThanOrEqual(minimumHeight);
  expect(readingArea.visible, 'the required comparison area is actually visible').toBeGreaterThanOrEqual(minimumHeight);
  expect(readingArea.available, 'the comparison body owns its long-content scroll').toBeGreaterThan(20);
  expect(readingArea.moved, 'the comparison body scrolls independently').toBeGreaterThan(20);
  expect(readingArea.outerAvailable, 'the mobile shell does not stack both panes vertically').toBeLessThanOrEqual(2);
  expect(readingArea.outerScrollTop, 'the mobile shell stays fixed while the detail body scrolls').toBe(0);
}

test.describe('FVRC-1006 graph review responsive and accessible layout', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local graph-review fixture.');
  test.setTimeout(150_000);

  test('keeps branch review usable on desktop, tablet, and mobile in both locales and themes', async ({ browser }, testInfo) => {
    const desktop = await createAuthenticatedContext(browser, {
      viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce',
    });
    const assertNoDesktopServerErrors = observeProposalReviewServerErrors(desktop);
    let mobile: BrowserContext | null = null;
    let zoomed: BrowserContext | null = null;
    let assertNoMobileServerErrors: (() => void) | null = null;
    let assertNoZoomServerErrors: (() => void) | null = null;
    const filePath = `fvrc-1006-${randomUUID()}.md`;
    let workspaceId: string | null = null;
    let uploaded = false;
    try {
      const authResponse = await desktop.request.get('/api/auth/get-session');
      const auth = await authResponse.json() as { user?: { id?: string; role?: string } };
      expect(authResponse.ok()).toBeTruthy();
      expect(auth.user?.id).toBeTruthy();
      const workspaceResponse = await desktop.request.get('/api/workspaces');
      const workspaces = await workspaceResponse.json() as { workspaces?: Array<{ id: string; type: string; legacy?: boolean;
        permissions: { canRead?: boolean; canWrite?: boolean; canRunAgent?: boolean } }> };
      expect(workspaceResponse.ok()).toBeTruthy();
      const workspace = workspaces.workspaces?.find((entry) => entry.type === 'personal' && !entry.legacy
        && entry.permissions.canRead && entry.permissions.canWrite && entry.permissions.canRunAgent);
      expect(workspace, 'A permitted personal workspace is required.').toBeTruthy();
      workspaceId = workspace!.id;
      await desktop.addInitScript((id) => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
        localStorage.setItem('theme', 'light');
      }, workspaceId);
      await uploadWorkspaceTextFile({ request: desktop.request, workspaceId, filePath, content: BASE_TEXT });
      uploaded = true;
      const collaboration = await desktop.request.post('/api/files/collaboration/session', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      const session = await collaboration.json() as { documentId?: string; error?: string };
      expect(collaboration.ok(), session.error ?? 'Could not initialize the review document.').toBeTruthy();
      expect(session.documentId).toBeTruthy();
      const fixture = await createGraphFixture({ userId: auth.user!.id!, role: auth.user!.role ?? 'member',
        workspaceId, documentId: session.documentId!, filePath });
      const operationId = fixture.proposals.find((proposal) => proposal.label === 'C')?.operationId;
      expect(operationId).toBeTruthy();

      const desktopPage = await desktop.newPage();
      const english = await openGraph(desktopPage, { locale: 'en', workspaceId,
        lineageId: fixture.scope.lineageId, operationId: operationId! });
      await expect(english.graph.getByText('Ready to apply')).toBeVisible();
      await expect(english.graph.getByRole('heading', { name: 'Review proposal branches' })).toBeVisible();
      await expect(english.graph.getByTestId('graph-review-hunks')).toContainText('130');
      await expect(desktopPage.locator('html')).not.toHaveClass(/dark/);
      await expectNoOuterHorizontalOverflow(desktopPage);
      const desktopNav = await english.timeline.boundingBox();
      const desktopGraph = await english.graph.boundingBox();
      expect(desktopNav && desktopGraph).toBeTruthy();
      expect(desktopNav!.x + desktopNav!.width).toBeLessThanOrEqual(desktopGraph!.x + 2);

      const diagnostics = english.graph.getByTestId('graph-review-diagnostics');
      await expect(diagnostics).not.toHaveAttribute('open');
      await diagnostics.locator('summary').focus();
      await expect(diagnostics.locator('summary')).toBeFocused();
      await desktopPage.keyboard.press('Enter');
      await expect(diagnostics).toHaveAttribute('open', '');
      const safeDiagnostic = await diagnostics.locator('pre').innerText();
      expect(safeDiagnostic).toContain('evaluationId');
      expect(safeDiagnostic).not.toContain('Plan:');
      expect(safeDiagnostic).not.toContain(filePath);
      expect(safeDiagnostic).not.toContain('fenceToken');
      const allButton = english.graph.getByRole('button', { name: 'Review all changes' });
      await allButton.focus();
      await expect(allButton).toBeFocused();
      await desktopPage.keyboard.press('Enter');
      await expect(english.graph).toContainText('2 proposals selected');
      await expect(english.graph.getByRole('button', { name: 'This change' })).toBeFocused();
      await expect(english.graph.getByTestId('graph-review-blocked')).toBeVisible();
      await testInfo.attach('graph-review-desktop-light-en.png', {
        body: await desktopPage.screenshot({ fullPage: true }), contentType: 'image/png',
      });

      for (const width of [1280, 768, 320]) {
        await desktopPage.setViewportSize({ width, height: width === 320 ? 760 : 900 });
        await expectNoOuterHorizontalOverflow(desktopPage);
        const nav = await english.timeline.boundingBox();
        const graph = await english.graph.boundingBox();
        expect(graph).toBeTruthy();
        if (width >= 768) {
          expect(nav).toBeTruthy();
          expect(nav!.x + nav!.width).toBeLessThanOrEqual(graph!.x + 2);
        } else {
          expect(nav).toBeNull();
          await expectMobileGraphReadingArea(english.layout, english.graph);
        }
        if (width === 768 || width === 320) await expectGraphFooterControlsFit(english.graph);
        if (width === 320) {
          await testInfo.attach('graph-review-320px-reading-area-light-en.png', {
            body: await english.center.screenshot(), contentType: 'image/png',
          });
        }
        await testInfo.attach(`graph-review-${width}px-light-en.png`, {
          body: await english.center.screenshot(), contentType: 'image/png',
        });
      }

      // A 1280px physical viewport at 200% browser zoom has an approximately
      // 640px CSS viewport and 2x pixel density. Both observable layout inputs
      // are emulated; this is not a claim to control native browser zoom chrome.
      zoomed = await createAuthenticatedContext(browser, { viewport: { width: 640, height: 450 },
        deviceScaleFactor: 2, reducedMotion: 'reduce' });
      assertNoZoomServerErrors = observeProposalReviewServerErrors(zoomed);
      await zoomed.addInitScript((id) => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      const zoomPage = await zoomed.newPage();
      const zoomGraph = await openGraph(zoomPage, { locale: 'en', workspaceId,
        lineageId: fixture.scope.lineageId, operationId: operationId! });
      expect(await zoomPage.evaluate(() => ({ width: window.innerWidth, ratio: window.devicePixelRatio })))
        .toEqual({ width: 640, ratio: 2 });
      await expectNoOuterHorizontalOverflow(zoomPage);
      const zoomNav = await zoomGraph.timeline.boundingBox();
      const zoomComparison = await zoomGraph.graph.boundingBox();
      expect(zoomNav).toBeNull();
      expect(zoomComparison).toBeTruthy();
      await expectMobileGraphReadingArea(zoomGraph.layout, zoomGraph.graph, 96);
      await testInfo.attach('graph-review-200-percent-equivalent-en.png', {
        body: await zoomGraph.center.screenshot(), contentType: 'image/png',
      });

      mobile = await createAuthenticatedContext(browser, { viewport: { width: 390, height: 844 },
        isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce' });
      assertNoMobileServerErrors = observeProposalReviewServerErrors(mobile);
      await mobile.addInitScript((id) => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
        localStorage.setItem('theme', 'dark');
      }, workspaceId);
      const mobilePage = await mobile.newPage();
      const german = await openGraph(mobilePage, { locale: 'de', workspaceId,
        lineageId: fixture.scope.lineageId, operationId: operationId! });
      await expect(mobilePage.locator('html')).toHaveClass(/dark/);
      expect(await mobilePage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
      await expect(german.graph.getByText('Bereit zur Übernahme')).toBeVisible();
      await expect(german.graph.getByRole('heading', { name: 'Vorschlagszweige prüfen' })).toBeVisible();
      await expect(german.center.getByTestId('file-version-center-mobile-comparison-pane')
        .locator('h2[tabindex="-1"]')).toBeFocused();
      await expectNoOuterHorizontalOverflow(mobilePage);
      await expectGraphFooterControlsFit(german.graph);
      const mobileNav = await german.timeline.boundingBox();
      const mobileGraph = await german.graph.boundingBox();
      expect(mobileNav).toBeNull();
      expect(mobileGraph).toBeTruthy();
      await expectMobileGraphReadingArea(german.layout, german.graph);
      // Keep the 390×844 presentation assertion above, then use a constrained
      // viewport to prove that list and detail remain separately navigable.
      await mobilePage.setViewportSize({ width: 390, height: 520 });
      await expectNoOuterHorizontalOverflow(mobilePage);
      await expectGraphFooterControlsFit(german.graph);
      await german.center.getByRole('button', { name: 'Zur Übersicht' }).tap();
      await expect(german.layout).toHaveAttribute('data-mobile-pane', 'timeline');
      await expect(german.center.getByTestId('file-version-center-mobile-timeline-pane')).toBeVisible();
      await expect(german.center.getByTestId('file-version-center-mobile-comparison-pane')).toBeHidden();
      const selectedMobileEntry = german.timeline.locator(`button[data-operation-id="${operationId}"]`);
      await expect(selectedMobileEntry).toBeFocused();
      const history = german.center.getByTestId('file-version-history-section');
      await expect(history).toHaveCSS('border-top-style', 'solid');
      // The timeline owns its own Radix viewport at every width. Prove that
      // the history divider moves inside it while the outer pane stays put.
      const timelineMovement = await german.timeline.locator('[data-slot="scroll-area-viewport"]').evaluate((viewport) => {
        const divider = viewport.querySelector('[data-testid="file-version-history-section"]');
        if (!divider) throw new Error('The history divider is absent from the responsive layout.');
        viewport.scrollTop = 0;
        const before = divider.getBoundingClientRect().top;
        const pane = viewport.closest('nav');
        if (!pane) throw new Error('The timeline scroll viewport has no containing pane.');
        const paneBefore = pane.getBoundingClientRect().top;
        const available = viewport.scrollHeight - viewport.clientHeight;
        viewport.scrollTop = Math.min(160, available);
        return { available, moved: viewport.scrollTop, before, after: divider.getBoundingClientRect().top,
          paneBefore, paneAfter: pane.getBoundingClientRect().top };
      });
      expect(timelineMovement.available).toBeGreaterThan(20);
      expect(timelineMovement.moved).toBeGreaterThan(20);
      expect(timelineMovement.before - timelineMovement.after).toBeGreaterThan(20);
      expect(Math.abs(timelineMovement.before - timelineMovement.after - timelineMovement.moved)).toBeLessThan(3);
      expect(Math.abs(timelineMovement.paneBefore - timelineMovement.paneAfter)).toBeLessThan(2);
      await selectedMobileEntry.tap();
      await expectMobileGraphReadingArea(german.layout, german.graph, 144);
      await mobilePage.setViewportSize({ width: 390, height: 844 });
      await german.graph.getByRole('button', { name: 'Alle Änderungen prüfen' }).tap();
      await expect(german.graph).toContainText('2 Vorschläge ausgewählt');
      await expect(german.graph.getByRole('button', { name: 'Diese Änderung' })).toBeFocused();
      await expectNoOuterHorizontalOverflow(mobilePage);
      await testInfo.attach('graph-review-390px-reading-area-dark-de.png', {
        body: await german.center.screenshot(), contentType: 'image/png',
      });
      await testInfo.attach('graph-review-mobile-dark-de.png', {
        body: await mobilePage.screenshot({ fullPage: true }), contentType: 'image/png',
      });
    } finally {
      await zoomed?.close().catch(() => undefined);
      await mobile?.close().catch(() => undefined);
      if (uploaded && workspaceId) {
        const deleted = await desktop.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
        });
        expect(deleted.ok(), 'Could not remove the dedicated responsive fixture.').toBeTruthy();
      }
      await desktop.close();
      assertNoZoomServerErrors?.();
      assertNoMobileServerErrors?.();
      assertNoDesktopServerErrors();
    }
  });

  test('keeps a six-level proposal branch readable and independently scrollable', async ({ browser }, testInfo) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 320, height: 720 },
      colorScheme: 'dark', reducedMotion: 'reduce' });
    const assertNoServerErrors = observeProposalReviewServerErrors(context);
    const page = await context.newPage();
    const filePath = `fvrc-1006-${randomUUID()}.md`;
    let workspaceId: string | null = null;
    let uploaded = false;
    try {
      const authResponse = await context.request.get('/api/auth/get-session');
      const auth = await authResponse.json() as { user?: { id?: string; role?: string } };
      expect(authResponse.ok()).toBeTruthy();
      expect(auth.user?.id).toBeTruthy();
      const workspaceResponse = await context.request.get('/api/workspaces');
      const workspaces = await workspaceResponse.json() as { workspaces?: Array<{ id: string; type: string; legacy?: boolean;
        permissions: { canRead?: boolean; canWrite?: boolean; canRunAgent?: boolean } }> };
      expect(workspaceResponse.ok()).toBeTruthy();
      const workspace = workspaces.workspaces?.find((entry) => entry.type === 'personal' && !entry.legacy
        && entry.permissions.canRead && entry.permissions.canWrite && entry.permissions.canRunAgent);
      expect(workspace, 'A permitted personal workspace is required for the deep branch.').toBeTruthy();
      workspaceId = workspace!.id;
      await context.addInitScript((id) => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
        localStorage.setItem('theme', 'dark');
      }, workspaceId);
      await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: DEEP_BASE_TEXT });
      uploaded = true;
      const collaboration = await context.request.post('/api/files/collaboration/session', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      const session = await collaboration.json() as { documentId?: string; error?: string };
      expect(collaboration.ok(), session.error ?? 'Could not initialize the deep review document.').toBeTruthy();
      expect(session.documentId).toBeTruthy();
      const fixture = await createDeepGraphFixture({ userId: auth.user!.id!, role: auth.user!.role ?? 'member',
        workspaceId, documentId: session.documentId!, filePath });
      expect(fixture.proposals.map((proposal) => proposal.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
      expect(fixture.proposals.map((proposal) => proposal.parentProposalId)).toEqual([
        null, ...fixture.proposals.slice(0, -1).map((proposal) => proposal.proposalId),
      ]);
      const leaf = fixture.proposals.at(-1)!;
      const review = await openGraph(page, { locale: 'en', workspaceId,
        lineageId: fixture.scope.lineageId, operationId: leaf.operationId });
      await expect(review.graph.getByRole('heading', { name: 'Review proposal branches' })).toBeVisible();
      const contextRows = review.graph.getByTestId('graph-review-context').locator('ol > li');
      await expect(contextRows).toHaveCount(6);
      const indentation = await contextRows.evaluateAll((rows) => rows.map((row) =>
        Number.parseFloat(getComputedStyle(row).paddingInlineStart)));
      expect(indentation.every((value, index) => index === 0 || value > indentation[index - 1]!)).toBeTruthy();
      await expect(review.center.getByTestId('file-version-review-branch')).toHaveCount(1);
      await expectNoOuterHorizontalOverflow(page);
      await expectGraphFooterControlsFit(review.graph);
      const branchScroll = await review.graph.getByTestId('graph-review-context').locator('div.overflow-y-auto').evaluate((viewport) => {
        const first = viewport.querySelector('ol > li');
        if (!first) throw new Error('The selected branch has no visible proposal row.');
        viewport.scrollTop = 0;
        const before = first.getBoundingClientRect().top;
        const available = viewport.scrollHeight - viewport.clientHeight;
        viewport.scrollTop = Math.min(120, available);
        return { available, moved: viewport.scrollTop, before, after: first.getBoundingClientRect().top };
      });
      expect(branchScroll.available).toBeGreaterThan(20);
      expect(branchScroll.moved).toBeGreaterThan(20);
      expect(branchScroll.before - branchScroll.after).toBeGreaterThan(20);
      await expectMobileGraphReadingArea(review.layout, review.graph);
      await testInfo.attach('graph-review-deep-reading-area-320px.png', {
        body: await review.center.screenshot(), contentType: 'image/png',
      });
      // The fixed detail pane keeps the action footer visible while long
      // comparison content scrolls independently above it.
      const continueEditing = review.graph.getByRole('button', { name: 'Continue editing' });
      const continueBounds = await continueEditing.boundingBox();
      const centerBounds = await review.center.boundingBox();
      expect(continueBounds && centerBounds).toBeTruthy();
      expect(continueBounds!.x).toBeGreaterThanOrEqual(centerBounds!.x - 1);
      expect(continueBounds!.x + continueBounds!.width).toBeLessThanOrEqual(centerBounds!.x + centerBounds!.width + 1);
      expect(continueBounds!.y).toBeGreaterThanOrEqual(centerBounds!.y - 1);
      expect(continueBounds!.y + continueBounds!.height).toBeLessThanOrEqual(centerBounds!.y + centerBounds!.height + 1);
      await continueEditing.focus();
      await expect(continueEditing).toBeFocused();
      await testInfo.attach('graph-review-deep-320px-dark-en.png', {
        body: await review.center.screenshot(), contentType: 'image/png',
      });

      const accept = review.graph.getByRole('button', { name: 'Accept change', exact: true });
      await expect(accept).toBeEnabled();
      await accept.click();
      await expect(review.graph.getByTestId('graph-review-confirmation')).toBeVisible();
      await expectMobileGraphReadingArea(review.layout, review.graph, 144);
      await testInfo.attach('graph-review-deep-confirm-reading-area-320px.png', {
        body: await review.center.screenshot(), contentType: 'image/png',
      });
      await expectGraphFooterControlsFit(review.graph);
      await review.graph.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(review.graph.getByTestId('graph-review-confirmation')).toHaveCount(0);

      await page.setViewportSize({ width: 1280, height: 520 });
      await expectNoOuterHorizontalOverflow(page);
      const nav = await review.timeline.boundingBox();
      const graph = await review.graph.boundingBox();
      expect(nav && graph).toBeTruthy();
      expect(nav!.x + nav!.width).toBeLessThanOrEqual(graph!.x + 2);
      const dividerMovement = await review.timeline.locator('[data-slot="scroll-area-viewport"]').evaluate((viewport) => {
        const divider = viewport.querySelector('[data-testid="file-version-history-section"]');
        if (!divider) throw new Error('The deep branch timeline has no history divider.');
        viewport.scrollTop = 0;
        const before = divider.getBoundingClientRect().top;
        const available = viewport.scrollHeight - viewport.clientHeight;
        viewport.scrollTop = Math.min(160, available);
        return { available, moved: viewport.scrollTop, before, after: divider.getBoundingClientRect().top };
      });
      expect(dividerMovement.available).toBeGreaterThan(20);
      expect(dividerMovement.moved).toBeGreaterThan(20);
      expect(dividerMovement.before - dividerMovement.after).toBeGreaterThan(20);
      await testInfo.attach('graph-review-deep-1280px-dark-en.png', {
        body: await review.center.screenshot(), contentType: 'image/png',
      });
    } finally {
      if (uploaded && workspaceId) {
        const deleted = await context.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
        });
        expect(deleted.ok(), 'Could not remove the dedicated deep-branch fixture.').toBeTruthy();
      }
      await context.close();
      assertNoServerErrors();
    }
  });
});
