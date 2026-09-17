import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

import {
  createAuthenticatedContext,
  enterMarkdownEditMode,
  uploadWorkspaceTextFile,
} from './helpers/managed-test-context';

const workspaceIdHeader = 'x-canvas-workspace-id';

type WorkspacePayload = {
  workspaces?: Array<{
    id: string;
    permissions: { canWrite: boolean };
  }>;
  error?: string;
};

async function writableWorkspace(request: APIRequestContext) {
  const response = await request.get('/api/workspaces');
  const payload = await response.json() as WorkspacePayload;
  expect(response.ok(), payload.error || 'Could not load workspaces').toBeTruthy();
  const workspace = payload.workspaces?.find((candidate) => candidate.permissions.canWrite);
  expect(workspace, 'A writable workspace is required').toBeTruthy();
  return workspace!.id;
}

async function useWorkspace(context: BrowserContext, workspaceId: string) {
  await context.addInitScript((id) => {
    window.localStorage.setItem('canvas.activeWorkspaceId', id);
    window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

async function clickToolbarButton(page: Page, name: string) {
  if (name === 'Edit as text') {
    await page.getByRole('group', { name: 'Document view' })
      .getByRole('button', { name: 'Source', exact: true })
      .click();
    return;
  }
  const menuTargetByAction: Record<string, { group: string; item: string }> = {
    Callout: { group: 'Blocks', item: 'Callout' },
    'Collapsible section': { group: 'Blocks', item: 'Collapsible section' },
    Footnote: { group: 'Blocks', item: 'Footnote' },
    'Insert table': { group: 'Insert', item: 'Table' },
    'Inline formula': { group: 'Formula', item: 'Inline formula' },
  };
  const menuTarget = menuTargetByAction[name];
  if (menuTarget) {
    await page.getByRole('toolbar', { name: 'Markdown editor toolbar' })
      .getByRole('button', { name: menuTarget.group, exact: true })
      .click();
    await page.getByRole('menuitem', { name: menuTarget.item, exact: true }).click();
    return;
  }
  await page.getByRole('button', { name, exact: true }).first().click();
}

test.describe('Rich Markdown blocks', () => {
  test('inserts, renders, toggles, and serializes the supported rich blocks', async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    const filePath = `rich-blocks-${Date.now()}.md`;
    let workspaceId: string | null = null;

    try {
      workspaceId = await writableWorkspace(page.request);
      await useWorkspace(context, workspaceId);

      await uploadWorkspaceTextFile({
        request: page.request,
        workspaceId,
        filePath,
        content: `# Rich blocks UI test

Callout anchor

Details anchor

Formula anchor

Footnote anchor

Table anchor`,
      });

      await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      await enterMarkdownEditMode(page);
      const editor = page.locator('.tiptap-editor-shell .ProseMirror');
      await expect(editor).toBeVisible({ timeout: 30_000 });

      await editor.getByText('Callout anchor', { exact: true }).click();
      await clickToolbarButton(page, 'Callout');
      const calloutDialog = page.getByTestId('markdown-rich-block-dialog');
      await expect(calloutDialog).toBeVisible();
      await calloutDialog.getByRole('button', { name: 'Info', exact: true }).click();
      await calloutDialog.locator('#markdown-callout-title').fill('UI callout');
      await calloutDialog.locator('#markdown-callout-content').fill('Callout body');
      await calloutDialog.getByRole('button', { name: 'Insert', exact: true }).click();
      const callout = editor.locator('[data-type="canvas-callout"]');
      await expect(callout).toHaveCount(1);
      await expect(callout).toContainText('UI callout');
      await expect(callout).toContainText('Callout body');

      await editor.getByText('Details anchor', { exact: true }).click();
      await clickToolbarButton(page, 'Collapsible section');
      const detailsDialog = page.getByTestId('markdown-rich-block-dialog');
      await expect(detailsDialog).toBeVisible();
      await detailsDialog.locator('#markdown-details-summary').fill('UI details');
      await detailsDialog.locator('#markdown-details-content').fill('Details body');
      await detailsDialog.getByRole('button', { name: 'Insert', exact: true }).click();
      const details = editor.locator('details[data-type="canvas-details"]');
      await expect(details).toHaveCount(1);
      await expect(details).toContainText('UI details');
      await expect(details).toContainText('Details body');
      await expect(details.locator('summary')).toHaveText('UI details');
      await expect(details).not.toHaveAttribute('open');
      await details.locator('summary').click();
      await expect(details).toHaveAttribute('open', /^(?:|open)$/u);
      await details.locator('summary').click();
      await expect(details).not.toHaveAttribute('open');

      await editor.getByText('Formula anchor', { exact: true }).click();
      await clickToolbarButton(page, 'Inline formula');
      const formulaDialog = page.getByTestId('markdown-rich-block-dialog');
      await expect(formulaDialog).toBeVisible();
      await formulaDialog.locator('#markdown-latex').fill('x^2');
      await expect(formulaDialog.locator('.katex')).toBeVisible();
      await formulaDialog.getByRole('button', { name: 'Insert', exact: true }).click();
      await expect(editor.locator('[data-type="inline-math"]')).toHaveCount(1);

      await editor.getByText('Footnote anchor', { exact: true }).click();
      await clickToolbarButton(page, 'Footnote');
      const footnoteDialog = page.getByTestId('markdown-rich-block-dialog');
      await expect(footnoteDialog).toBeVisible();
      await footnoteDialog.locator('#markdown-footnote-content').fill('Footnote body');
      await footnoteDialog.getByRole('button', { name: 'Insert', exact: true }).click();
      const footnoteReference = editor.locator('sup[data-type="markdown-footnote-reference"]');
      const footnoteDefinition = editor.locator('[data-type="markdown-footnote-definition"]');
      await expect(footnoteReference).toHaveCount(1);
      await expect(footnoteDefinition).toContainText('Footnote body');
      await footnoteReference.click();
      await expect.poll(() => footnoteDefinition.evaluate((definition) => {
        const selection = window.getSelection();
        return Boolean(selection?.anchorNode && definition.contains(selection.anchorNode));
      })).toBe(true);

      await editor.getByText('Table anchor', { exact: true }).click();
      await clickToolbarButton(page, 'Insert table');
      const tableDialog = page.getByRole('dialog', { name: 'Insert table' });
      await expect(tableDialog).toBeVisible();
      await tableDialog.locator('#markdown-table-rows').fill('2');
      await tableDialog.locator('#markdown-table-cols').fill('2');
      await tableDialog.getByRole('button', { name: 'Insert table', exact: true }).click();
      const table = editor.locator('table').last();
      await expect(table).toBeVisible();
      await table.locator('td, th').first().click();
      await page.keyboard.type('Editable table value');
      await expect(table).toContainText('Editable table value');
      await expect(table.locator('[data-type="canvas-callout"]')).toHaveCount(0);

      const editorBounds = await editor.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, viewportWidth: window.innerWidth };
      });
      expect(editorBounds.left).toBeGreaterThanOrEqual(0);
      expect(editorBounds.right).toBeLessThanOrEqual(editorBounds.viewportWidth);

      const richScreenshot = testInfo.outputPath('markdown-rich-blocks-desktop.png');
      await page.screenshot({ path: richScreenshot, type: 'png' });
      await testInfo.attach('rich blocks desktop', { path: richScreenshot, contentType: 'image/png' });

      await clickToolbarButton(page, 'Edit as text');
      const sourceEditor = page.locator('.cm-content');
      await expect(sourceEditor).toBeVisible();
      await expect(sourceEditor).toContainText('> [!info] UI callout');
      await expect(sourceEditor).toContainText('<details>');
      await expect(sourceEditor).toContainText('<summary>UI details</summary>');
      await expect(sourceEditor).toContainText('$x^2$');
      await expect(sourceEditor).toContainText('[^1]: Footnote body');
      await expect(sourceEditor).toContainText('Editable table value');
      await expect(sourceEditor).not.toContainText('> [!note] Note |');
    } finally {
      await page.close().catch(() => undefined);
      if (workspaceId) {
        await context.request.delete('/api/files/delete', {
          headers: { [workspaceIdHeader]: workspaceId },
          data: { path: filePath },
        }).catch(() => undefined);
      }
      await context.close();
    }
  });
});
