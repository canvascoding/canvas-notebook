import type { Locator, Page } from '@playwright/test';

export function chatComposerInput(page: Page): Locator {
  return page.getByTestId('chat-inline-editor').getByRole('textbox');
}

export function homePromptInput(page: Page): Locator {
  return page.locator('[data-home-prompt-editor]').getByRole('textbox');
}

export function chatComposerFileInput(page: Page): Locator {
  return page.getByTestId('chat-send').locator('..').locator('input[type="file"]');
}

/** Use the real browser selection, without reading or changing editor internals. */
export async function placeComposerCaret(input: Locator, boundary: 'start' | 'end'): Promise<void> {
  await input.evaluate((element, position) => {
    (element as HTMLElement).focus();
    const selection = window.getSelection();
    if (!selection) throw new Error('The browser selection is unavailable.');
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(position === 'start');
    // The editor observes browser selections asynchronously. Deliver that
    // notification before the caller sends its next keyboard event.
    return new Promise<void>(resolve => {
      element.ownerDocument.addEventListener('selectionchange', () => resolve(), { once: true });
      selection.removeAllRanges();
      selection.addRange(range);
    });
  }, boundary);
}

export async function composerCaretAtEnd(input: Locator): Promise<boolean> {
  return input.evaluate(element => {
    const selection = window.getSelection();
    if (!selection?.focusNode || !element.contains(selection.focusNode) || !selection.isCollapsed) {
      throw new Error('The editor must contain an actual collapsed browser selection.');
    }
    const remaining = document.createRange();
    remaining.selectNodeContents(element);
    remaining.setStart(selection.focusNode, selection.focusOffset);
    return remaining.toString().length === 0;
  });
}
