import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import messagesDe from '../messages/de.json';
import messagesEn from '../messages/en.json';

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
  await expect(setup.locator('svg:not([data-slot="alert-actions"] svg)')).toHaveCount(1);
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

for (const locale of ['de', 'en'] as const) {
  for (const layout of ['compact', 'normal'] as const) {
    test(`hosted notice ${locale} ${layout} fits a narrow desktop container`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      const copy = (locale === 'de' ? messagesDe : messagesEn).teamModeHostedOnly;
      const container = page.getByTestId(`hosted-${locale}-${layout}`);
      const notice = container.locator('[data-slot="alert"]');
      await expect(container).toHaveCSS('width', '288px');
      await expect(notice).toHaveAttribute('role', 'status');
      await expect(notice.locator('[data-slot="alert-title"]')).toHaveText(copy.title);
      await expect(notice.locator('[data-slot="alert-description"]')).toHaveText(copy.description);
      await expect(notice.locator('svg:not([data-slot="alert-actions"] svg)')).toHaveCount(1);
      const link = notice.getByRole('link', { name: copy.button });
      await expect(link).toHaveAttribute('href', 'https://canvasnotebook.app');
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noreferrer');

      for (const mode of ['light', 'dark'] as const) {
        await page.evaluate((mode) => window.applyNoticeTheme(mode, true, 12), mode);
        const geometry = await container.evaluate((element) => {
          const notice = element.querySelector('[data-slot="alert"]')!;
          const description = notice.querySelector('[data-slot="alert-description"]')!.getBoundingClientRect();
          const action = notice.querySelector('[data-slot="alert-actions"]')!.getBoundingClientRect();
          const actionLink = notice.querySelector('a')!;
          const link = actionLink.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          return {
            containerOverflow: element.scrollWidth > element.clientWidth,
            noticeOverflow: notice.scrollWidth > notice.clientWidth,
            linkOverflow: actionLink.scrollHeight > actionLink.clientHeight,
            pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
            descriptionWidth: description.width,
            descriptionBottom: description.bottom,
            actionTop: action.top,
            actionRight: action.right,
            linkRight: link.right,
            containerRight: bounds.right,
          };
        });
        expect(geometry.containerOverflow).toBe(false);
        expect(geometry.noticeOverflow).toBe(false);
        expect(geometry.linkOverflow).toBe(false);
        expect(geometry.pageOverflow).toBe(false);
        expect(geometry.descriptionWidth).toBeGreaterThanOrEqual(160);
        expect(geometry.actionRight).toBeLessThanOrEqual(geometry.containerRight);
        expect(geometry.linkRight).toBeLessThanOrEqual(geometry.containerRight);
        if (layout === 'compact') expect(geometry.actionTop).toBeGreaterThanOrEqual(geometry.descriptionBottom);
      }
      await container.screenshot({ path: info.outputPath(`hosted-${locale}-${layout}-desktop.png`), animations: 'disabled' });
    });
  }
}

test('notice text keeps accessible contrast on a tinted workspace background', async ({ page }) => {
  for (const mode of ['light', 'dark'] as const) {
    await page.evaluate((mode) => window.applyNoticeTheme(mode, true, 12, '#558899'), mode);
    for (const name of ['setup', 'success']) {
      const ratios = await page.getByTestId(`${name}-notice`).evaluate((element) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        const pixel = () => Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        context.fillStyle = getComputedStyle(document.body).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(element).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const background = pixel();
        if (context.getImageData(0, 0, 1, 1).data[3] !== 255) throw new Error('Contrast needs an opaque workspace background');
        const luminance = (color: number[]) => color.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
        const backgroundLuminance = luminance(background);
        return ['alert-title', 'alert-description'].map((slot) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = getComputedStyle(element.querySelector(`[data-slot="${slot}"]`)!).color;
          context.fillRect(0, 0, 1, 1);
          const foregroundLuminance = luminance(pixel());
          return (Math.max(backgroundLuminance, foregroundLuminance) + 0.05)
            / (Math.min(backgroundLuminance, foregroundLuminance) + 0.05);
        });
      });
      for (const [index, ratio] of ratios.entries()) {
        expect(ratio, `${mode} ${name} ${index === 0 ? 'title' : 'description'} contrast on #558899`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});
