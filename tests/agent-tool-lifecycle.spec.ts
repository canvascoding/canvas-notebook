import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

test('interrupted agent tools settle and late results replace the interruption', async ({ page }, testInfo) => {
  page.on('pageerror', (error) => console.log('Browser error:', error.message));
  const bundle = await build({ entryPoints: ['tests/fixtures/agent-tool-lifecycle.tsx'], bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}'  } });
  const styles = await postcss([tailwindcss()]).process(await readFile('app/globals.css', 'utf8'), { from: 'app/globals.css' });
  await page.route('http://agent-tool-fixture.test/**', (route) => route.fulfill({ contentType: 'text/html',
    body: `<html><head><style>${styles.css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>` }));
  await page.goto('http://agent-tool-fixture.test/');
  const disclosure = page.getByTestId('chat-run-disclosure');
  await expect(disclosure.getByText('Manage agents', { exact: true })).toHaveCount(2);
  await expect(disclosure.locator('.lucide-bot')).toHaveCount(2);
  await expect(disclosure.locator('.animate-spin')).toHaveCount(2);
  await page.locator('#failure').click();
  await expect(disclosure.locator('.animate-spin')).toHaveCount(0);
  await disclosure.getByRole('button', { name: /Error/ }).last().click();
  await expect(page.getByText('The run ended before this tool returned a result. Its completion could not be confirmed.')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#start').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureHasLiveMessages: () => boolean }).fixtureHasLiveMessages())).toBe(true);
  await page.locator('#idle').click();
  await expect(disclosure.locator('.animate-spin')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureHasLiveMessages: () => boolean }).fixtureHasLiveMessages())).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('interrupted-agent-tool.png') });
  await page.locator('#result').click();
  await expect(disclosure.getByRole('button', { name: 'Create agent: Done' })).toBeVisible();
  await expect(disclosure.getByText('Completed an action', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await disclosure.getByRole('button', { name: 'Create agent: Done' }).click();
  await expect(page.getByText('Agent created successfully.', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('agent-tool-mobile.png'), animations: 'disabled' });
  await expect(disclosure.locator('.animate-spin')).toHaveCount(0);
});
