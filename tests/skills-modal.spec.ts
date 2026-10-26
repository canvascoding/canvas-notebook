import { test, expect } from '@playwright/test';
import type { CanvasSkill } from '../app/lib/skills/canvas-skill-manifest';
import { createAuthenticatedContext } from './helpers/managed-test-context';

test('built-in skill documentation stays readable and scrollable on desktop and mobile', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } });
  try {
    const response = await context.request.get('/api/skills?scope=user');
    expect(response.status()).toBe(200);
    const payload = await response.json();
    expect(payload.success).toBe(true);
    const skills = (payload.skills as CanvasSkill[])
      .filter(skill => (skill.core || skill.sourceType === 'core') && typeof skill.content === 'string')
      .sort((left, right) => right.content.length - left.content.length);
    expect(skills.length, 'A real built-in skill is required for this read-only layout check.').toBeGreaterThan(0);
    const skill = skills[0];
    const page = await context.newPage();
    await page.goto('/en/plugins?view=browse&kind=skill&stock=installed');
    await page.getByRole('button', { name: `Open ${skill.name}`, exact: true }).click();
    await page.getByTestId('package-detail-tab-content').click();
    const technical = page.getByTestId('package-technical-details');
    await technical.locator('summary').click();
    const filePicker = page.getByTestId('package-file-picker');
    await expect(filePicker.locator('option[value="SKILL.md"]')).toHaveCount(1);
    const read = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.startsWith('/api/capabilities/packages/') && url.pathname.endsWith('/file')
        && url.searchParams.get('path') === 'SKILL.md' && response.request().method() === 'GET';
    });
    await filePicker.selectOption('SKILL.md');
    const receipt = await read;
    expect(receipt.status()).toBe(200);
    const body = await receipt.json();
    expect(body.success).toBe(true);
    const content = Buffer.from(body.data.file.content, 'base64').toString('utf8');
    expect(content.length).toBeGreaterThan(1_000);
    const reader = page.getByTestId('package-file-content');
    await expect(reader).toHaveValue(content);
    await expect(reader).toHaveAttribute('readonly', '');
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await reader.scrollIntoViewIfNeeded();
      await expect.poll(async () => {
        const box = await reader.boundingBox();
        return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1
          && box.y + box.height <= viewport.height + 1);
      }, { message: 'The current skill documentation reader must fit the viewport.' }).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const metrics = await reader.evaluate(element => {
        element.scrollTop = 0;
        return { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
      });
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      await reader.hover();
      await page.mouse.wheel(0, 600);
      await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await expect(reader).toHaveValue(content);
    }
  } finally { await context.close(); }
});
