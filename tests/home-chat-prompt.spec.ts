import { test, expect, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { MAIN_AGENT_DISPLAY_NAME, MAIN_AGENT_ID } from '../app/lib/agents/main-agent';
import { authenticateManagedTestPage } from './helpers/managed-test-context';
import { chatComposerInput, homePromptInput } from './helpers/chat-composer';

dotenv.config({ path: process.env.CANVAS_ENV_FILE || path.join(process.cwd(), '.env.local'), quiet: true });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page) {
  await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });
}

async function submitHomePrompt(page: Page) {
  await homePromptInput(page).locator('xpath=ancestor::form[1]').locator('button[type="submit"]').click();
}

async function preventHomeModelCalls(page: Page): Promise<string[]> {
  const prompts: string[] = [];
  await page.routeWebSocket('**/ws/chat', socket => {
    // Keep real authentication/status traffic. This navigation test consumes
    // the initial prompt through the UI but never forwards a provider turn.
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const packet = JSON.parse(raw.toString()) as { type: string; requestId?: string;
        message?: { content?: string | Array<{ type: string; text?: string }> } };
      if (packet.type !== 'send_message') { server.send(raw); return; }
      const content = packet.message?.content;
      prompts.push(typeof content === 'string' ? content : (content ?? [])
        .filter(part => part.type === 'text').map(part => part.text ?? '').join('\n'));
      socket.send(JSON.stringify({ type: 'send_message_result', requestId: packet.requestId, success: true }));
    });
  });
  return prompts;
}

async function createFileDataTransfer(page: Page, files: Array<{ name: string; mimeType: string; content: string }>) {
  return page.evaluateHandle((dropFiles) => {
    const dataTransfer = new DataTransfer();
    for (const dropFile of dropFiles) {
      dataTransfer.items.add(new File([dropFile.content], dropFile.name, { type: dropFile.mimeType }));
    }
    return dataTransfer;
  }, files);
}

test.describe('Home chat prompt', () => {
  test('stores the selected home agent for the initial notebook prompt', async ({ page }) => {
    await login(page);

    let savedLastActiveAgentId: string | null = null;
    await page.route(/\/api\/agents(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            agents: [
              { agentId: MAIN_AGENT_ID, name: MAIN_AGENT_DISPLAY_NAME, iconId: 'bot', type: 'main', removable: false },
              { agentId: 'linkedin-agent', name: 'LinkedIn Agent', iconId: 'briefcase', type: 'special', removable: true },
            ],
          },
        }),
      });
    });
    await page.route('**/api/user-preferences', async (route) => {
      if (route.request().method() === 'PATCH') {
        const payload = route.request().postDataJSON() as { lastActiveAgentId?: string };
        savedLastActiveAgentId = payload.lastActiveAgentId || null;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            lastActiveAgentId: savedLastActiveAgentId || MAIN_AGENT_ID,
          },
        }),
      });
    });
    await page.route('**/notebook**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Notebook route held</title>',
      });
    });

    const agentsLoaded = page.waitForResponse(response => response.url().includes('/api/agents?') && response.ok());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await agentsLoaded;

    await expect(page.getByTestId('home-agent-id')).toBeHidden();
    await homePromptInput(page).focus();
    await expect(page.getByTestId('home-agent-id')).toContainText(MAIN_AGENT_DISPLAY_NAME);
    await page.getByTestId('home-agent-id').click();
    await page.getByRole('button', { name: /LinkedIn Agent\s+linkedin-agent/i }).click();

    await expect(page.getByTestId('home-agent-id')).toContainText('LinkedIn Agent');
    expect(savedLastActiveAgentId).toBe('linkedin-agent');

    await homePromptInput(page).fill('Bitte mit LinkedIn Agent starten');
    await submitHomePrompt(page);

    await expect(page).toHaveURL(/\/(?:en\/)?notebook(?:\?.*)?$/, { timeout: 15_000 });
    const storedPrompt = await page.evaluate(() => window.sessionStorage.getItem('canvas.chat.initialPrompt'));
    expect(storedPrompt).not.toBeNull();
    expect(JSON.parse(storedPrompt!)).toMatchObject({
      prompt: 'Bitte mit LinkedIn Agent starten',
      agentId: 'linkedin-agent',
    });
  });

  test('redirects into notebook after submitting a prompt on the home page', async ({ page }) => {
    await login(page);
    const prompts = await preventHomeModelCalls(page);
    const agentsLoaded = page.waitForResponse(response => response.url().includes('/api/agents?') && response.ok());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await agentsLoaded;
    await page.evaluate(() => window.localStorage.setItem('canvas.chatVisible', 'false'));

    await homePromptInput(page).fill('Bitte leite mich ins Notebook weiter');
    await submitHomePrompt(page);

    await expect(page).toHaveURL(/\/(?:en\/)?notebook(?:\?.*)?$/, { timeout: 15_000 });
    await expect(chatComposerInput(page)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.url()).not.toContain('session=');

    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('canvas.chat.initialPrompt')), { timeout: 15000 }).toBeNull();
    await expect.poll(() => prompts).toEqual(['Bitte leite mich ins Notebook weiter']);
  });

  test('keeps dropped prompt attachments when opening the notebook from home', async ({ page }) => {
    await login(page);
    await page.route('**/notebook**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Notebook route held</title>',
      });
    });

    const agentsLoaded = page.waitForResponse(response => response.url().includes('/api/agents?') && response.ok());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await agentsLoaded;

    const input = homePromptInput(page);
    const dataTransfer = await createFileDataTransfer(page, [
      {
        name: 'home-dropped.txt',
        mimeType: 'text/plain',
        content: 'Home dropped attachment',
      },
    ]);

    await input.dispatchEvent('dragenter', { dataTransfer });
    await input.dispatchEvent('dragover', { dataTransfer });
    await input.dispatchEvent('drop', { dataTransfer });

    await expect(page.getByTestId('chat-composer-attachment')).toContainText('home-dropped.txt');

    await input.fill('Bitte diese Datei auswerten');
    await submitHomePrompt(page);

    await expect(page).toHaveURL(/\/(?:en\/)?notebook(?:\?.*)?$/, { timeout: 15_000 });
    const storedPrompt = await page.evaluate(() => window.sessionStorage.getItem('canvas.chat.initialPrompt'));
    expect(storedPrompt).not.toBeNull();

    const parsedPrompt = JSON.parse(storedPrompt!) as {
      prompt?: string;
      attachments?: Array<{ name?: string; contentKind?: string }>;
    };
    expect(parsedPrompt.prompt).toBe('Bitte diese Datei auswerten');
    expect(parsedPrompt.attachments).toHaveLength(1);
    expect(parsedPrompt.attachments?.[0]).toMatchObject({
      name: 'home-dropped.txt',
      contentKind: 'document',
    });
  });

  test('removes session query after loading a deep-linked notebook session', async ({ page }) => {
    await login(page);

    const createResponse = await page.request.post('/api/sessions', {
      headers: {
        Origin: process.env.BASE_URL || 'http://localhost:3000',
      },
      data: {
        title: 'Playwright deep link cleanup',
      },
    });

    expect(createResponse.ok()).toBeTruthy();
    const createPayload = await createResponse.json();
    const sessionId = createPayload.session?.sessionId as string | undefined;
    expect(sessionId).toBeTruthy();

    await page.goto(`/notebook?session=${encodeURIComponent(sessionId!)}`, { waitUntil: 'domcontentloaded' });

    await expect(chatComposerInput(page)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain('session=');
  });
});
