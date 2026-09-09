import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

let bundle: string;
let css: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/fixtures/context-status-browser.tsx'],
    bundle: true, write: false, format: 'iife', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'unrelated-header-services',
      setup(build) {
        build.onResolve({ filter: /(@\/i18n\/navigation|AppBackButton|ChatAgentSelector|ChatLiveBrowserLink|WorkspaceSwitcher)$/ }, (args) => ({
          path: args.path, namespace: 'header-stubs',
        }));
        build.onLoad({ filter: /.*/, namespace: 'header-stubs' }, () => ({
          contents: `import React from 'react';
            export const Link=({children,...props})=>React.createElement('a',props,children);
            export const AppBackButton=()=>null;
            export const ChatAgentSelector=()=>null;
            export const ChatLiveBrowserLink=()=>null;
            export const WorkspaceSwitcher=()=>null;
            export const useShouldShowWorkspaceSwitcher=()=>false;`,
          loader: 'jsx', resolveDir: process.cwd(),
        }));
      },
    }],
  });
  bundle = result.outputFiles[0].text;
  const from = path.resolve('app/globals.css');
  css = (await postcss([tailwindcss()]).process(await readFile(from, 'utf8'), { from })).css;
});
test.beforeEach(async ({ page }) => {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
});

test('streaming, finished and aborting use the same percentage; 98% is yellow', async ({ page }, info) => {
  const notice = page.getByTestId('chat-runtime-notice');
  await expect(notice).toHaveAttribute('data-context-percent', '98');
  await expect(notice).toHaveAttribute('role', 'status');
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(notice).toHaveAttribute('data-context-percent', '98');
  await page.getByRole('button', { name: 'Abort', exact: true }).click();
  await expect(notice).toHaveAttribute('data-context-percent', '98');
  await page.getByTestId('chat-header-menu-trigger').click();
  const bar = page.getByTestId('chat-context-progress');
  await expect(bar).toHaveAttribute('data-context-percent', '98');
  await expect(bar).toHaveClass(/bg-amber-500/);
  await expect(page.getByTestId('context-measurement-details')).toContainText('provider-reported, not current context');
  await expect(page.getByTestId('chat-context-details')).toContainText('post-compaction target');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('context-98-consistent.png'), fullPage: true, animations: 'disabled' });
});

test('stale values are labelled and never treated as current overflow', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Overflow', exact: true }).click();
  await expect(page.getByTestId('chat-runtime-notice')).toHaveAttribute('role', 'alert');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('chat-runtime-notice')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('chat-runtime-notice')).toContainText('previous measurement');
  await page.getByTestId('chat-header-menu-trigger').click();
  await expect(page.getByTestId('context-measurement-details')).toContainText('Updating context estimate');
  await expect(page.getByTestId('chat-context-progress')).toHaveClass(/bg-cyan-500/);
  await page.screenshot({ path: info.outputPath('context-updating.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Unavailable', exact: true }).click();
  await expect(page.getByTestId('chat-runtime-notice')).toContainText('unavailable');
  await page.getByRole('button', { name: 'New 63%', exact: true }).click();
  await expect(page.getByTestId('chat-runtime-notice')).toHaveCount(0);
  await page.getByTestId('chat-header-menu-trigger').click();
  await expect(page.getByTestId('chat-context-progress')).toHaveAttribute('data-context-percent', '63');
});

test('trigger overflow is yellow and unclamped in text; compact and legacy fallback stay coherent', async ({ page }) => {
  await page.getByRole('button', { name: 'Trigger reached', exact: true }).click();
  await expect(page.getByTestId('chat-runtime-notice')).toContainText('110% of trigger');
  await expect(page.getByTestId('chat-runtime-notice')).toHaveAttribute('role', 'status');
  await page.getByTestId('chat-header-menu-trigger').click();
  await expect(page.getByTestId('chat-context-progress')).toHaveAttribute('style', 'width: 100%;');
  await expect(page.getByTestId('chat-context-details')).toContainText('110% of trigger');
  await page.getByTestId('chat-compact').click();
  await expect(page.getByTestId('chat-runtime-notice')).toHaveCount(0);
  await page.getByRole('button', { name: 'Legacy', exact: true }).click();
  await expect(page.getByTestId('chat-runtime-notice')).toHaveAttribute('data-context-percent', '90');
  await expect(page.getByTestId('chat-runtime-notice')).toContainText('budget');
  await page.getByTestId('chat-header-menu-trigger').click();
  await expect(page.getByTestId('chat-context-progress')).toHaveAttribute('data-context-percent', '90');
  await expect(page.getByTestId('chat-context-progress')).toHaveAttribute('data-context-basis', 'budget');
});

test('retained context failure is consistent and does not blame the latest user message', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Retained overflow', exact: true }).click();
  await expect(page.getByTestId('chat-runtime-notice')).toContainText('recent messages and tool results');
  await expect(page.getByTestId('chat-runtime-notice')).not.toContainText('Current message or attachments');
  await page.getByTestId('chat-header-menu-trigger').click();
  await expect(page.getByTestId('chat-context-details')).toContainText('recent messages and tool results');
  await expect(page.getByTestId('chat-context-progress')).toHaveAttribute('data-context-percent', '174');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('retained-context-overflow.png'), fullPage: true, animations: 'disabled' });
});
