import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

let bundle: string;
let css: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/inline-notice-browser.tsx'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"test"' } });
  bundle = result.outputFiles[0].text;
  const from = path.resolve('app/globals.css');
  css = (await postcss([tailwindcss()]).process(await readFile(from, 'utf8'), { from })).css;
});

test.beforeEach(async ({ page }) => {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
});

test('status announcements, error announcements and expandable technical details', async ({ page }) => {
  for (const name of ['setup', 'info', 'success']) await expect(page.getByTestId(`${name}-notice`)).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('error-notice')).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('group-notice')).toHaveAttribute('role', 'group');
  const setup = page.getByTestId('setup-notice');
  await expect(setup.locator(':scope > svg')).toHaveCount(1);
  await expect(setup.getByText(/GEMINI_API_KEY/)).not.toBeVisible();
  await page.keyboard.press('Tab');
  await expect(setup.locator('summary')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(setup.getByText(/GEMINI_API_KEY/)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(setup.getByRole('link')).toBeFocused();
});

for (const width of [360, 390, 1280]) {
  for (const mode of ['light', 'dark'] as const) {
    test(`notices fit ${width}px in ${mode} with workspace appearance`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      for (const radius of [0, 12]) {
        await page.evaluate(({ mode, radius }) => window.applyNoticeTheme(mode, true, radius), { mode, radius });
        const notice = page.getByTestId('setup-notice');
        await expect(notice).toHaveCSS('border-radius', `${radius}px`);
        const geometry = await notice.evaluate((element) => {
          const notice = element.getBoundingClientRect();
          const action = element.querySelector('[data-slot="alert-actions"]')!.getBoundingClientRect();
          const link = element.querySelector('a')!.getBoundingClientRect();
          return { notice: { x: notice.x, right: notice.right }, action: { x: action.x, right: action.right }, linkHeight: link.height, pageOverflow: document.documentElement.scrollWidth > window.innerWidth, noticeOverflow: element.scrollWidth > element.clientWidth };
        });
        expect(geometry.pageOverflow).toBe(false);
        expect(geometry.noticeOverflow).toBe(false);
        expect(geometry.action.right).toBeLessThanOrEqual(geometry.notice.right);
        if (width < 640) expect(geometry.linkHeight).toBeGreaterThanOrEqual(44);
        await expect(page.getByTestId('error-notice').locator('code')).toBeVisible();
        expect(await page.getByTestId('error-notice').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`notices-${width}-${mode}.png`), fullPage: true, animations: 'disabled' });
    });
  }
}
