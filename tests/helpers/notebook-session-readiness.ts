import { expect, type Page } from '@playwright/test';

/** A loaded session clears its URL intent through a router transition. Editing
 * a transient surface before that transition finishes can target its old mount. */
export async function waitForNotebookSession(page: Page, sessionId: string): Promise<void> {
  await page.waitForURL((url) => !url.searchParams.has('session'), { timeout: 30_000 });
  await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', sessionId, { timeout: 30_000 });
}
