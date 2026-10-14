import { expect, type Locator, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';

export async function nativeRichParagraph(page: Page, editorSelector: string, text: string): Promise<Locator> {
  const paragraphs = (await page.locator(editorSelector).evaluate(element =>
    (element as HTMLElement & { editor: { getJSON(): JSONContent } }).editor.getJSON())).content?.filter(node => node.type === 'paragraph'
    && node.content?.every(child => child.type === 'text')
    && node.content.map(child => child.text ?? '').join('') === text) ?? [];
  expect(paragraphs).toHaveLength(1);
  const id = paragraphs[0].attrs?.id;
  expect(typeof id).toBe('string');
  expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
  // A remote-caret label adds DOM text to the paragraph without changing its
  // native content. Select its stable node ID, then actually click and type.
  const paragraph = page.locator(editorSelector).locator(`p[data-id="${id}"]`);
  await expect(paragraph).toBeVisible();
  await expect(paragraph).toContainText(text);
  return paragraph;
}
