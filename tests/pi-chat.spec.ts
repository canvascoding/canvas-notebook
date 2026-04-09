import { test, expect, type Browser, type Page } from '@playwright/test';
import type { PiRuntimeStatus } from '@/app/lib/pi/live-runtime';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = 'test-results/pi-chat-auth.json';
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

async function login(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: {
      Origin: process.env.BASE_URL || 'http://localhost:3000',
    },
    data: {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    },
  });

  expect(response.ok()).toBeTruthy();
  await page.goto('/chat', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/chat$/, { timeout: 15000 });
}

async function startFreshChat(page: Page) {
  await page.getByRole('button', { name: /new chat/i }).click();
  await expect(page.getByTestId('chat-session-id')).toContainText('new chat');
}

async function mockEmptyChatBootstrap(page: Page) {
  await page.route('**/api/agents/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          piConfig: {
            activeProvider: 'openai',
            providers: {
              openai: { model: 'gpt-4o' },
            },
          },
          discovery: {
            openai: {
              models: [{ id: 'gpt-4o', name: 'GPT-4o', supportsVision: true }],
            },
          },
        },
      }),
    });
  });

  await page.route('**/api/sessions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        sessions: [],
      }),
    });
  });
}

async function getChatInputMetrics(page: Page) {
  return page.getByTestId('chat-input').evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    const style = window.getComputedStyle(textarea);
    return {
      height: textarea.getBoundingClientRect().height,
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
      styleHeight: Number.parseFloat(textarea.style.height || '0'),
      overflowY: style.overflowY,
    };
  });
}

test.describe('PI Chat E2E', () => {
  test.setTimeout(90000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    test.setTimeout(120000);
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test('should bootstrap a session, show the session id, and derive a history title', async ({ page }) => {
    await page.goto('/chat');
    await startFreshChat(page);

    const prompt = `Session title smoke ${Date.now()} should become the visible history title after the first streamed reply finishes.`;
    const input = page.getByTestId('chat-input');

    await input.fill(prompt);
    await input.press('Enter');

    const sessionIdBadge = page.getByTestId('chat-session-id');
    await expect(sessionIdBadge).toBeVisible({ timeout: 15000 });
    await expect(sessionIdBadge).not.toContainText('Main Agent');
    await expect.poll(async () => sessionIdBadge.getAttribute('title'), { timeout: 15000 }).toMatch(/^sess-/);

    const fullSessionId = await sessionIdBadge.getAttribute('title');
    expect(fullSessionId).toMatch(/^sess-/);

    let currentSession: { sessionId?: string; title?: string } | null = null;
    await expect.poll(async () => {
      currentSession = await page.evaluate(async (sessionId) => {
        const response = await fetch('/api/sessions');
        const payload = await response.json();
        if (!payload?.success || !Array.isArray(payload.sessions)) {
          return null;
        }

        return payload.sessions.find((session: { sessionId?: string; title?: string }) => session.sessionId === sessionId) || null;
      }, fullSessionId);

      return currentSession?.title || null;
    }, { timeout: 60000 }).not.toBe('New session');

    const resolvedSession = currentSession as { sessionId?: string; title?: string } | null;
    expect(resolvedSession).toBeTruthy();
    expect(resolvedSession?.title?.startsWith(prompt.slice(0, 20))).toBeTruthy();
    expect((resolvedSession?.title || '').length).toBeLessThanOrEqual(48);

    await page.locator('button').filter({ has: page.locator('.lucide-history') }).first().click();
    await expect(page.getByText('Sessions', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /session title smoke/i }).first()).toBeVisible();
  });

  test('should keep structured PI context for a second turn', async ({ page }) => {
    await page.goto('/chat');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    const assistantMessages = page.getByTestId('chat-message-assistant');
    const marker = 'RESUME_MARKER_ALPHA';

    await input.fill(`Merke dir exakt dieses Token: ${marker}. Antworte nur mit OK.`);
    await input.press('Enter');

    await expect(assistantMessages).toHaveCount(1, { timeout: 60000 });
    await expect.poll(async () => {
      const text = await assistantMessages.first().textContent();
      return (text || '').replace(/\s+/g, ' ').trim();
    }, { timeout: 60000 }).toContain('OK');

    await input.fill('Gib exakt das Token aus, das ich dir gerade gegeben habe, und nichts anderes.');
    await input.press('Enter');

    await expect(assistantMessages).toHaveCount(2, { timeout: 60000 });
    await expect.poll(async () => {
      const text = await assistantMessages.last().textContent();
      return (text || '').replace(/\s+/g, ' ').trim();
    }, { timeout: 60000 }).toContain(marker);
  });

  test('should send a chat prompt over WebSocket without surfacing an HTTP 401 runtime error', async ({ page }) => {
    const consoleMessages: string[] = [];
    page.on('console', (message) => {
      consoleMessages.push(message.text());
    });

    await page.goto('/chat');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    await input.fill('Antworte kurz, damit ich den WebSocket-Versand pruefen kann.');
    await input.press('Enter');

    await expect(page.getByTestId('chat-message-user')).toHaveCount(1, { timeout: 15000 });

    const websocket401 = () =>
      consoleMessages.find(
        (text) => text.includes('[WebSocket] Server error:') && text.includes('HTTP 401'),
      ) || null;

    await expect.poll(websocket401, { timeout: 15000 }).toBeNull();

    const assistantMessages = page.getByTestId('chat-message-assistant');
    await expect(assistantMessages.first()).toBeVisible({ timeout: 60000 });
    await expect.poll(async () => {
      const text = await assistantMessages.last().textContent();
      return (text || '').trim().length;
    }, { timeout: 60000 }).toBeGreaterThan(0);

    expect(websocket401()).toBeNull();
  });

  test('should render markdown and tool output separately in the chat UI', async ({ page }) => {
    await page.route('**/api/stream', async (route) => {
      const body = [
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: '   Here is **bold** output\n\n- first item\n- second item',
          },
        }),
        JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'tool-call-1',
          toolName: 'ls',
          args: {
            path: '.',
          },
        }),
        JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: 'tool-call-1',
          toolName: 'ls',
          result: {
            content: [{ type: 'text', text: 'alpha.md\\nbeta.ts' }],
          },
        }),
        JSON.stringify({
          type: 'agent_end',
          messages: [
            {
              role: 'user',
              content: 'Show markdown and tool output.',
              timestamp: Date.now(),
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Here is **bold** output\n\n- first item\n- second item' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now(),
            },
            {
              role: 'toolResult',
              content: [{ type: 'text', text: 'alpha.md\\nbeta.ts' }],
              timestamp: Date.now(),
            },
          ],
        }),
      ].join('\n') + '\n';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body,
      });
    });

    await page.goto('/chat');
    await startFreshChat(page);
    const input = page.getByTestId('chat-input');
    await input.fill('Render markdown and tools.');
    await input.press('Enter');

    const assistantMessage = page.getByTestId('chat-message-assistant').first();
    await expect(assistantMessage.locator('strong')).toHaveText('bold');
    await expect(assistantMessage.locator('li')).toHaveCount(2);
    await expect(assistantMessage.locator('p').first()).toHaveText(/Here is bold output/);

    const toolMessage = page.getByTestId('chat-message-toolResult').first();
    await expect(toolMessage).toContainText('ls');
    await expect(toolMessage).toContainText('alpha.md');
    await expect(toolMessage).not.toContainText('Assistant');
    await expect(toolMessage.getByTestId('chat-tool-body')).toHaveCount(0);

    await toolMessage.getByTestId('chat-tool-toggle').click();
    await expect(toolMessage.getByTestId('chat-tool-body')).toBeVisible();
    await expect(toolMessage.getByTestId('chat-tool-body')).toContainText('alpha.md');
    await expect(toolMessage.getByTestId('chat-tool-body')).toContainText('beta.ts');
    await expect(toolMessage.getByText('Input')).toBeVisible();

    const messageOrder = await page.locator('[data-testid^="chat-message-"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')),
    );
    expect(messageOrder.indexOf('chat-message-toolResult')).toBeLessThan(messageOrder.indexOf('chat-message-assistant'));
  });

  test('should show direct PI media tool inputs for image and video generation calls', async ({ page }) => {
    const imageReferencePath = 'public/images/examples/aura_serum_produktfoto.png';
    const videoStartFramePath = 'public/images/examples/tech_banner_future_of_innovation.png';
    const videoEndFramePath = 'public/images/examples/reise_banner_find_your_paradise.png';

    await page.route('**/api/stream', async (route) => {
      const body = [
        JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'tool-call-image-1',
          toolName: 'image_generation',
          args: {
            count: 1,
            prompt: 'Use the same composition with a colder blue palette.',
            reference_image_paths: [imageReferencePath],
          },
        }),
        JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: 'tool-call-image-1',
          toolName: 'image_generation',
          result: {
            content: [
              {
                type: 'text',
                text: `Image generation complete: 1 successful, 0 failed\n\nImage 1: image-generation/generations/generated.png\nURL: /api/media/image-generation/generations/generated.png\n`,
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'tool-call-video-1',
          toolName: 'video_generation',
          args: {
            mode: 'frames_to_video',
            prompt: 'Animate a slow camera move from the first frame into the second.',
            start_frame_path: videoStartFramePath,
            end_frame_path: videoEndFramePath,
            resolution: '720p',
            is_looping: true,
          },
        }),
        JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: 'tool-call-video-1',
          toolName: 'video_generation',
          result: {
            content: [
              {
                type: 'text',
                text: 'Video generation started! This may take 3-10 minutes.\n\nVideo will be saved to: veo-studio/video-generation/generated.mp4\nMedia URL: /api/media/veo-studio/video-generation/generated.mp4\n',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'agent_end',
          messages: [
            {
              role: 'user',
              content: 'Generate media from workspace assets.',
              timestamp: Date.now(),
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'I used the direct PI media tools with workspace-relative asset paths.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now(),
            },
          ],
        }),
      ].join('\n') + '\n';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body,
      });
    });

    await page.goto('/chat');
    await startFreshChat(page);
    const input = page.getByTestId('chat-input');
    await input.fill('Use the direct PI media tools with workspace assets.');
    const streamResponse = page.waitForResponse((response) => response.url().includes('/api/stream'));
    await page.getByTestId('chat-send').click();
    await expect((await streamResponse).ok()).toBeTruthy();

    const toolMessages = page.getByTestId('chat-message-toolResult');
    await expect(toolMessages).toHaveCount(2);

    const imageToolMessage = toolMessages.filter({ hasText: 'image_generation' }).first();
    await expect(imageToolMessage).toContainText('image_generation');
    await imageToolMessage.getByTestId('chat-tool-toggle').click();
    await expect(imageToolMessage.getByTestId('chat-tool-body')).toContainText('reference_image_paths');
    await expect(imageToolMessage.getByTestId('chat-tool-body')).toContainText(imageReferencePath);
    await expect(imageToolMessage.getByTestId('chat-tool-body')).toContainText('Use the same composition with a colder blue palette.');

    const videoToolMessage = toolMessages.filter({ hasText: 'video_generation' }).first();
    await expect(videoToolMessage).toContainText('video_generation');
    await videoToolMessage.getByTestId('chat-tool-toggle').click();
    await expect(videoToolMessage.getByTestId('chat-tool-body')).toContainText('start_frame_path');
    await expect(videoToolMessage.getByTestId('chat-tool-body')).toContainText(videoStartFramePath);
    await expect(videoToolMessage.getByTestId('chat-tool-body')).toContainText('end_frame_path');
    await expect(videoToolMessage.getByTestId('chat-tool-body')).toContainText(videoEndFramePath);
    await expect(videoToolMessage.getByTestId('chat-tool-body')).toContainText('is_looping');
  });

  test('should hide assistant text behind a streaming placeholder until the final message arrives', async ({ page }) => {
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      const emptyUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      };

      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const pathname = new URL(url, window.location.origin).pathname;

        if (pathname === '/api/stream') {
          const encoder = new TextEncoder();
          const chunks = [
            JSON.stringify({
              type: 'message_update',
              assistantMessageEvent: {
                type: 'text_delta',
                delta: 'Streaming **bold',
              },
            }) + '\n',
            JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Streaming **bold** answer' }],
                api: 'mock',
                provider: 'mock',
                model: 'mock-model',
                usage: emptyUsage,
                stopReason: 'stop',
                timestamp: Date.now(),
              },
            }) + '\n',
          ];

          let chunkIndex = 0;

          const stream = new ReadableStream({
            async pull(controller) {
              if (chunkIndex >= chunks.length) {
                controller.close();
                return;
              }

              const delay = chunkIndex === 0 ? 0 : 900;
              await new Promise((resolve) => window.setTimeout(resolve, delay));
              controller.enqueue(encoder.encode(chunks[chunkIndex]));
              chunkIndex += 1;
            },
          });

          return new Response(stream, {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          });
        }

        return originalFetch(input, init);
      };
    });

    await page.goto('/chat');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    await input.fill('Show streaming state.');
    await page.getByTestId('chat-send').click();

    await expect(page.getByTestId('chat-message-user')).toHaveCount(1, { timeout: 15000 });

    const assistantMessages = page.getByTestId('chat-message-assistant');
    await expect(assistantMessages).toHaveCount(1, { timeout: 15000 });

    const assistantMessage = assistantMessages.first();
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Streaming **bold', { exact: false })).toHaveCount(0);
    await expect(page.getByText('Streaming bold answer', { exact: false })).toHaveCount(0);
    await expect(assistantMessage.locator('strong')).toHaveCount(0);
    await expect(assistantMessage).not.toContainText('Streaming');

    await expect(assistantMessage).toContainText('Streaming bold answer');
    await expect(assistantMessage.locator('strong')).toHaveText('bold');
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toHaveCount(0);
  });

  test('should keep the current scroll position when streaming continues after the user scrolls up', async ({ page }) => {
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      let streamCallCount = 0;
      const emptyUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      };

      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const pathname = new URL(url, window.location.origin).pathname;

        if (pathname === '/api/stream') {
          const encoder = new TextEncoder();
          streamCallCount += 1;

          if (streamCallCount <= 5) {
            const seedText = Array.from(
              { length: 6 },
              (_, lineIndex) => `Seed reply ${streamCallCount}, line ${lineIndex + 1}: keep the transcript tall before the streaming placeholder appears.`,
            ).join('\n');

            return new Response(
              `${JSON.stringify({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: seedText }],
                  api: 'mock',
                  provider: 'mock',
                  model: 'mock-model',
                  usage: emptyUsage,
                  stopReason: 'stop',
                  timestamp: Date.now(),
                },
              })}\n`,
              {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                },
              },
            );
          }

          const totalChunks = 18;
          const linesPerChunk = 3;
          let chunkIndex = 0;

          const buildText = (count: number) =>
            Array.from(
              { length: count * linesPerChunk },
              (_, lineIndex) => `Stream line ${lineIndex + 1}: keep this answer growing while I inspect older history.`,
            ).join('\n');

          const stream = new ReadableStream({
            async pull(controller) {
              if (chunkIndex >= totalChunks) {
                controller.close();
                return;
              }

              const text = buildText(chunkIndex + 1);
              const payload =
                chunkIndex === totalChunks - 1
                  ? {
                      type: 'message_end',
                      message: {
                        role: 'assistant',
                        content: [{ type: 'text', text }],
                        api: 'mock',
                        provider: 'mock',
                        model: 'mock-model',
                        usage: emptyUsage,
                        stopReason: 'stop',
                        timestamp: Date.now(),
                      },
                    }
                  : {
                      type: 'message_update',
                      message: {
                        role: 'assistant',
                        content: [{ type: 'text', text }],
                        api: 'mock',
                        provider: 'mock',
                        model: 'mock-model',
                        usage: emptyUsage,
                        stopReason: 'streaming',
                        timestamp: Date.now(),
                      },
                      assistantMessageEvent: {
                        type: 'text_delta',
                        delta: text,
                      },
                    };

              await new Promise((resolve) => window.setTimeout(resolve, chunkIndex < 6 ? 35 : 70));
              controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
              chunkIndex += 1;
            },
          });

          return new Response(stream, {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          });
        }

        return originalFetch(input, init);
      };
    });

    await page.goto('/chat');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    const scrollRegion = page.getByTestId('chat-scroll-region');
    const assistantMessages = page.getByTestId('chat-message-assistant');

    for (let index = 0; index < 5; index += 1) {
      await input.fill(`Seed transcript turn ${index + 1}.`);
      await input.press('Enter');
      await expect(assistantMessages).toHaveCount(index + 1, { timeout: 10000 });
      await expect(assistantMessages.nth(index)).toContainText(`Seed reply ${index + 1}, line 1`, { timeout: 10000 });
    }

    await expect
      .poll(async () => scrollRegion.evaluate((element) => element.scrollHeight - element.clientHeight), { timeout: 10000 })
      .toBeGreaterThan(240);

    await input.fill('Stream a long answer so I can scroll away from the bottom.');
    await input.press('Enter');

    const assistantMessage = assistantMessages.last();
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Stream line 30', { exact: false })).toHaveCount(0);
    await page.waitForTimeout(350);

    const lockedScrollTop = await scrollRegion.evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 220);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });

    expect(lockedScrollTop).toBeGreaterThan(0);
    await expect(page.getByTitle('Scroll to bottom')).toBeVisible();
    await expect(assistantMessage).toContainText('Stream line 30', { timeout: 10000 });
    await expect(assistantMessage).toContainText('Stream line 48', { timeout: 10000 });
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toHaveCount(0);

    await page.waitForTimeout(250);

    const scrollTopAfterStreaming = await scrollRegion.evaluate((element) => element.scrollTop);
    expect(Math.abs(scrollTopAfterStreaming - lockedScrollTop)).toBeLessThan(24);
    await expect(page.getByTitle('Scroll to bottom')).toBeVisible();
  });

  test('should render compact usage footer for assistant responses', async ({ page }) => {
    await page.route('**/api/stream', async (route) => {
      const body = [
        JSON.stringify({
          type: 'message_update',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Usage enabled answer.' }],
            api: 'mock',
            provider: 'mock',
            model: 'mock-model',
            usage: {
              input: 123,
              output: 456,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 579,
              cost: {
                input: 0.001,
                output: 0.0113,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.0123,
              },
            },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: 'Usage enabled answer.',
          },
        }),
        JSON.stringify({
          type: 'agent_end',
          messages: [
            {
              role: 'user',
              content: 'Show usage',
              timestamp: Date.now(),
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Usage enabled answer.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: {
                input: 123,
                output: 456,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 579,
                cost: {
                  input: 0.001,
                  output: 0.0113,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0.0123,
                },
              },
              stopReason: 'stop',
              timestamp: Date.now(),
            },
          ],
        }),
      ].join('\n') + '\n';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body,
      });
    });

    await page.goto('/chat');
    await startFreshChat(page);
    const input = page.getByTestId('chat-input');
    await input.fill('Render usage footer.');
    await input.press('Enter');

    const assistantMessage = page.getByTestId('chat-message-assistant').filter({ hasText: 'Usage enabled answer.' }).last();
    await expect(assistantMessage).toBeVisible();

    const usageFooter = assistantMessage.getByTestId('chat-usage-footer');
    await expect(usageFooter).toBeVisible();
    await expect(usageFooter).toContainText('579 tok · $0.0123');
    await expect(usageFooter).toContainText('123 in / 456 out');
  });

  test('should only render cumulative usage on the final assistant message of a tool chain', async ({ page }) => {
    await page.route('**/api/stream', async (route) => {
      const now = Date.now();
      const body = [
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Ich sammle zuerst die Daten.' }],
            api: 'mock',
            provider: 'mock',
            model: 'mock-model',
            usage: {
              input: 50,
              output: 80,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 130,
              cost: {
                input: 0.001,
                output: 0.002,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.003,
              },
            },
            stopReason: 'tool_call',
            timestamp: now,
          },
        }),
        JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'tool-usage-1',
          toolName: 'search_workspace',
          args: { query: 'usage footer' },
        }),
        JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: 'tool-usage-1',
          toolName: 'search_workspace',
          result: {
            content: [{ type: 'text', text: 'Gefundene Treffer' }],
          },
        }),
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hier ist die zusammengefasste Antwort.' }],
            api: 'mock',
            provider: 'mock',
            model: 'mock-model',
            usage: {
              input: 70,
              output: 110,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 180,
              cost: {
                input: 0.004,
                output: 0.005,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.009,
              },
            },
            stopReason: 'stop',
            timestamp: now + 1,
          },
        }),
      ].join('\n') + '\n';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body,
      });
    });

    await page.goto('/chat');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    await input.fill('Nutze ein Tool und zeige nur den kumulierten Footer.');
    await input.press('Enter');

    const firstAssistantMessage = page.getByTestId('chat-message-assistant').filter({ hasText: 'Ich sammle zuerst die Daten.' }).last();
    const finalAssistantMessage = page.getByTestId('chat-message-assistant').filter({ hasText: 'Hier ist die zusammengefasste Antwort.' }).last();

    await expect(firstAssistantMessage).toBeVisible();
    await expect(finalAssistantMessage).toBeVisible();
    await expect(firstAssistantMessage.getByTestId('chat-usage-footer')).toHaveCount(0);

    const usageFooter = finalAssistantMessage.getByTestId('chat-usage-footer');
    await expect(usageFooter).toBeVisible();
    await expect(usageFooter).toContainText('310 tok · $0.0120');
    await expect(usageFooter).toContainText('120 in / 190 out');
    await expect(page.getByTestId('chat-usage-footer')).toHaveCount(1);
  });

  test('should show runtime status, queue state, and context budget in the chat UI', async ({ page }) => {
    const sessionId = 'sess-runtime-status';
    let currentStatus: PiRuntimeStatus = {
      sessionId,
      phase: 'running_tool',
      activeTool: { toolCallId: 'tool-1', name: 'read_file' },
      pendingToolCalls: 1,
      followUpQueue: [{ id: 'follow-1', text: 'Summarize afterwards', attachmentCount: 0 }],
      steeringQueue: [{ id: 'steer-1', text: 'Stop and inspect README', attachmentCount: 0 }],
      canAbort: true,
      contextWindow: 128000,
      estimatedHistoryTokens: 14600,
      availableHistoryTokens: 23500,
      contextUsagePercent: 62,
      includedSummary: true,
      omittedMessageCount: 8,
      summaryUpdatedAt: '2026-03-16T16:00:00.000Z',
      lastCompactionAt: '2026-03-16T16:00:00.000Z',
      lastCompactionKind: 'automatic',
      lastCompactionOmittedCount: 8,
    };

    await page.route('**/api/agents/config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            piConfig: {
              activeProvider: 'openai',
              providers: {
                openai: { model: 'gpt-4o' },
              },
            },
            discovery: {
              openai: {
                models: [{ id: 'gpt-4o', name: 'GPT-4o', supportsVision: true }],
              },
            },
          },
        }),
      });
    });

    await page.route('**/api/sessions', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            sessions: [
              {
                id: 1,
                sessionId,
                title: 'Busy runtime session',
                model: 'gpt-4o',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          session: {
            id: 1,
            sessionId,
            title: 'Busy runtime session',
            model: 'gpt-4o',
            createdAt: new Date().toISOString(),
          },
        }),
      });
    });

    await page.route(`**/api/sessions/messages?sessionId=${sessionId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'Check the project status.',
              timestamp: Date.now() - 1000,
            },
            {
              id: 'm2',
              role: 'assistant',
              content: [{ type: 'text', text: 'Working on it.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now() - 500,
            },
          ],
        }),
      });
    });

    await page.route(`**/api/stream/status?sessionId=${sessionId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          status: currentStatus,
        }),
      });
    });

    await page.route('**/api/stream', async (route) => {
      const body = `${JSON.stringify({ type: 'runtime_status', status: currentStatus })}\n`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body,
      });
    });

    await page.route('**/api/stream/control', async (route) => {
      const requestBody = route.request().postDataJSON() as { action: string; message?: { content?: string | Array<{ type: string; text?: string }> } };
      if (requestBody.action === 'steer') {
        currentStatus = {
          ...currentStatus,
          steeringQueue: [
            ...currentStatus.steeringQueue,
            { id: 'steer-2', text: 'Take over immediately', attachmentCount: 0 },
          ],
        };
      }

      if (requestBody.action === 'replace') {
        currentStatus = {
          ...currentStatus,
          phase: 'aborting',
          activeTool: null,
          followUpQueue: [],
          steeringQueue: [],
        };
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          status: currentStatus,
        }),
      });
    });

    await page.goto('/chat');

    await expect(page.getByTestId('chat-runtime-banner')).toBeVisible();
    await expect
      .poll(async () => (await page.getByTestId('chat-runtime-status').textContent()) || '', { timeout: 15000 })
      .toContain('Tool läuft: read_file');
    await expect(page.getByTestId('chat-runtime-status')).toContainText('2 in Queue');
    await expect(page.getByTestId('chat-runtime-status')).toContainText('Summary aktiv');
    await expect(page.getByTestId('chat-context-meter')).toContainText('~62%', { timeout: 15000 });
    await expect(page.getByTestId('chat-context-meter')).toContainText('128k');
    await expect(page.getByTestId('chat-queue-panel')).toContainText('Summarize afterwards', { timeout: 15000 });
    await expect(page.getByTestId('chat-queue-panel')).toContainText('Stop and inspect README');

    await page.getByTestId('chat-input').fill('Take over immediately');
    await page.getByTestId('chat-steer').click();

    await expect(page.getByTestId('chat-queue-panel')).toContainText('3 queued');
    await expect(page.getByTestId('chat-message-user').last()).toContainText('Take over immediately');

    await page.getByTestId('chat-input').fill('Ship this first');
    await page.getByTestId('chat-send-now').click();

    await expect(page.getByTestId('chat-runtime-status')).toContainText('Wird gestoppt');
  });

  test('should show productive starter prompts and prefill the mobile composer without overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockEmptyChatBootstrap(page);

    await page.goto('/chat');

    await expect(page.getByTestId('chat-starter-prompts')).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBeTruthy();

    await page.getByTestId('chat-starter-prompt-sm-campaign').click();
    await expect(page.getByTestId('chat-input')).toHaveValue(/visuelle Social-Media-Kampagne/);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).height, { timeout: 15000 })
      .toBeGreaterThan(56);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).styleHeight, { timeout: 15000 })
      .toBeLessThanOrEqual(192);
    await expect(page.getByTestId('chat-mobile-action-toggle')).toHaveCount(0);
    await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
    await expect(page.getByTestId('chat-model-badge')).toHaveCount(0);
  });

  test('should auto-grow the composer up to the mobile max height and collapse on reset', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockEmptyChatBootstrap(page);
    await page.goto('/chat');

    const input = page.getByTestId('chat-input');
    const longPrompt = Array.from({ length: 20 }, (_, index) => `Zeile ${index + 1} fuer den Composer-Wachstumstest.`).join('\n');

    await expect
      .poll(async () => (await getChatInputMetrics(page)).styleHeight, { timeout: 15000 })
      .toBe(56);

    await input.fill(longPrompt);

    await expect
      .poll(async () => (await getChatInputMetrics(page)).height, { timeout: 15000 })
      .toBeGreaterThan(56);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).height, { timeout: 15000 })
      .toBeLessThanOrEqual(192);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).scrollHeight > (await getChatInputMetrics(page)).clientHeight, { timeout: 15000 })
      .toBeTruthy();
    await expect
      .poll(async () => (await getChatInputMetrics(page)).overflowY, { timeout: 15000 })
      .toBe('auto');
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBeTruthy();

    await page.getByRole('button', { name: /new chat/i }).click();
    await expect(input).toHaveValue('');
    await expect
      .poll(async () => (await getChatInputMetrics(page)).styleHeight, { timeout: 15000 })
      .toBe(56);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).overflowY, { timeout: 15000 })
      .toBe('hidden');
  });

  test('should keep session and model hidden from the mobile header until details are expanded', async ({ page }) => {
    const sessionId = 'sess-mobile-details';

    await page.setViewportSize({ width: 390, height: 844 });

    await page.route('**/api/agents/config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            piConfig: {
              activeProvider: 'openai',
              providers: {
                openai: { model: 'gpt-4o' },
              },
            },
            discovery: {
              openai: {
                models: [{ id: 'gpt-4o', name: 'GPT-4o', supportsVision: true }],
              },
            },
          },
        }),
      });
    });

    await page.route('**/api/sessions', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            sessions: [
              {
                id: 1,
                sessionId,
                title: 'Mobile runtime session',
                model: 'gpt-4o',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
        }),
      });
    });

    await page.route(`**/api/sessions/messages?sessionId=${sessionId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'Check mobile status visibility.',
              timestamp: Date.now() - 1000,
            },
            {
              id: 'm2',
              role: 'assistant',
              content: [{ type: 'text', text: 'Everything is running.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now() - 500,
            },
          ],
        }),
      });
    });

    await page.route(`**/api/stream/status?sessionId=${sessionId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          status: {
            sessionId,
            phase: 'running_tool',
            activeTool: { toolCallId: 'tool-1', name: 'read_file' },
            pendingToolCalls: 1,
            followUpQueue: [{ id: 'follow-1', text: 'Summarize afterwards', attachmentCount: 0 }],
            steeringQueue: [],
            canAbort: true,
            contextWindow: 128000,
            estimatedHistoryTokens: 14600,
            availableHistoryTokens: 23500,
            contextUsagePercent: 62,
            includedSummary: true,
            omittedMessageCount: 8,
            summaryUpdatedAt: '2026-03-16T16:00:00.000Z',
            lastCompactionAt: '2026-03-16T16:00:00.000Z',
            lastCompactionKind: 'automatic',
            lastCompactionOmittedCount: 8,
          },
        }),
      });
    });

    await page.route('**/api/stream', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '',
      });
    });

    await page.goto('/chat');

    await expect(page.getByTestId('chat-runtime-banner')).toBeVisible();
    await expect(page.getByTestId('chat-mobile-details-toggle')).toBeVisible();
    await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
    await expect(page.getByTestId('chat-model-badge')).toHaveCount(0);

    await page.getByTestId('chat-mobile-details-toggle').click();

    await expect(page.getByTestId('chat-mobile-details-panel')).toBeVisible();
    await expect(page.getByTestId('chat-session-id')).toContainText('Mobile runtime session');
    await expect(page.getByTestId('chat-model-badge')).toContainText('gpt-4o');
    await expect(page.getByTestId('chat-queue-panel')).toContainText('Summarize afterwards');
  });

  test('should render a compaction break after manual canvas compact', async ({ page }) => {
    const sessionId = 'sess-compact-break';
    let currentStatus: PiRuntimeStatus = {
      sessionId,
      phase: 'idle',
      activeTool: null,
      pendingToolCalls: 0,
      followUpQueue: [],
      steeringQueue: [],
      canAbort: false,
      contextWindow: 128000,
      estimatedHistoryTokens: 8600,
      availableHistoryTokens: 23500,
      contextUsagePercent: 37,
      includedSummary: true,
      omittedMessageCount: 6,
      summaryUpdatedAt: '2026-03-16T16:00:00.000Z',
      lastCompactionAt: null,
      lastCompactionKind: null,
      lastCompactionOmittedCount: 0,
    };

    await page.route('**/api/agents/config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            piConfig: {
              activeProvider: 'openai',
              providers: {
                openai: { model: 'gpt-4o' },
              },
            },
            discovery: {
              openai: {
                models: [{ id: 'gpt-4o', name: 'GPT-4o', supportsVision: true }],
              },
            },
          },
        }),
      });
    });

    await page.route('**/api/sessions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          sessions: [
            {
              id: 1,
              sessionId,
              title: 'Compact session',
              model: 'gpt-4o',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route(`**/api/sessions/messages?sessionId=${sessionId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'Compress the old context.',
              timestamp: Date.now() - 1000,
            },
            {
              id: 'm2',
              role: 'assistant',
              content: [{ type: 'text', text: 'Ready when you are.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now() - 500,
            },
          ],
        }),
      });
    });

    await page.route(`**/api/stream/status?sessionId=${sessionId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          status: currentStatus,
        }),
      });
    });

    await page.route('**/api/stream/control', async (route) => {
      const body = route.request().postDataJSON() as { action: string };
      if (body.action === 'compact') {
        currentStatus = {
          ...currentStatus,
          lastCompactionAt: '2026-03-16T17:20:00.000Z',
          lastCompactionKind: 'manual',
          lastCompactionOmittedCount: 6,
        };
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          status: currentStatus,
        }),
      });
    });

    await page.goto('/chat');

    await expect(page.getByTestId('chat-compact')).toBeEnabled({ timeout: 15000 });
    await page.getByTestId('chat-compact').click();

    const breakMarker = page.getByTestId('chat-compaction-break');
    await expect(breakMarker).toBeVisible();
    await expect(breakMarker).toContainText('Canvas context compaction');
    await expect(breakMarker).toContainText('6');
  });

  test('should render the usage analytics page and apply provider filters', async ({ page }) => {
    await page.route('**/api/usage/summary**', async (route) => {
      const url = new URL(route.request().url());
      const provider = url.searchParams.get('provider');
      const payload = provider === 'openai'
        ? {
            success: true,
            filters: {
              from: '2026-03-01T00:00:00.000Z',
              to: '2026-03-30T23:59:59.999Z',
              provider: 'openai',
              model: null,
              sessionId: null,
              sessionQuery: null,
              stopReason: null,
              groupBy: 'provider',
              userId: null,
            },
            totals: {
              totalCost: 1.2345,
              totalTokens: 1500,
              inputTokens: 900,
              outputTokens: 600,
              cacheTokens: 0,
              sessionCount: 3,
              eventCount: 4,
            },
            rows: [
              {
                groupKey: 'openai',
                label: 'openai',
                totalCost: 1.2345,
                totalTokens: 1500,
                inputTokens: 900,
                outputTokens: 600,
                cacheTokens: 0,
                sessionCount: 3,
                eventCount: 4,
              },
            ],
          }
        : {
            success: true,
            filters: {
              from: '2026-03-01T00:00:00.000Z',
              to: '2026-03-30T23:59:59.999Z',
              provider: null,
              model: null,
              sessionId: null,
              sessionQuery: null,
              stopReason: null,
              groupBy: 'day',
              userId: null,
            },
            totals: {
              totalCost: 2.468,
              totalTokens: 2200,
              inputTokens: 1300,
              outputTokens: 900,
              cacheTokens: 0,
              sessionCount: 5,
              eventCount: 6,
            },
            rows: [
              {
                groupKey: '2026-03-16',
                label: '2026-03-16',
                totalCost: 2.468,
                totalTokens: 2200,
                inputTokens: 1300,
                outputTokens: 900,
                cacheTokens: 0,
                sessionCount: 5,
                eventCount: 6,
              },
            ],
          };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    await page.route('**/api/usage/events**', async (route) => {
      const url = new URL(route.request().url());
      const provider = url.searchParams.get('provider');
      const payload = provider === 'openai'
        ? {
            success: true,
            filters: {
              from: '2026-03-01T00:00:00.000Z',
              to: '2026-03-30T23:59:59.999Z',
              provider: 'openai',
              model: null,
              sessionId: null,
              sessionQuery: null,
              stopReason: null,
              groupBy: 'provider',
              userId: null,
            },
            page: 1,
            pageSize: 50,
            totalRows: 1,
            rows: [
              {
                id: 1,
                userId: 'user-main',
                userLabel: 'Main User',
                sessionId: 'sess-openai',
                sessionTitleSnapshot: 'OpenAI Session',
                provider: 'openai',
                model: 'gpt-4o',
                stopReason: 'stop',
                assistantTimestamp: '2026-03-16T10:00:00.000Z',
                totalTokens: 1500,
                inputTokens: 900,
                outputTokens: 600,
                cacheTokens: 0,
                totalCost: 1.2345,
              },
            ],
          }
        : {
            success: true,
            filters: {
              from: '2026-03-01T00:00:00.000Z',
              to: '2026-03-30T23:59:59.999Z',
              provider: null,
              model: null,
              sessionId: null,
              sessionQuery: null,
              stopReason: null,
              groupBy: 'day',
              userId: null,
            },
            page: 1,
            pageSize: 50,
            totalRows: 1,
            rows: [
              {
                id: 1,
                userId: 'user-main',
                userLabel: 'Main User',
                sessionId: 'sess-1',
                sessionTitleSnapshot: 'Daily Session',
                provider: 'anthropic',
                model: 'claude-sonnet-4',
                stopReason: 'toolUse',
                assistantTimestamp: '2026-03-16T10:00:00.000Z',
                totalTokens: 2200,
                inputTokens: 1300,
                outputTokens: 900,
                cacheTokens: 0,
                totalCost: 2.468,
              },
            ],
          };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    await page.goto('/usage');
    await expect(page.getByTestId('usage-page')).toBeVisible();
    await expect(page.getByText('Usage Analytics')).toBeVisible();
    await expect(page.getByTestId('usage-summary-table')).toContainText('2026-03-16');

    await page.getByPlaceholder('openai, anthropic, ollama').fill('openai');
    await page.getByRole('button', { name: /apply filters/i }).click();

    await expect(page.getByTestId('usage-summary-table')).toContainText('openai');
    await expect(page.getByTestId('usage-event-row')).toContainText('OpenAI Session');
    await expect(page.getByText('$1.2345').first()).toBeVisible();
  });

  test('should save managed prompt files in settings and keep chat working', async ({ page }) => {
    await page.goto('/settings?tab=agent-settings');

    const editor = page.getByTestId('agent-managed-file-editor');
    const saveButton = page.getByTestId('agent-managed-file-save');
    const marker = `PLAYWRIGHT_PROMPT_MARKER_${Date.now()}`;
    const existingValue = await editor.inputValue();

    await editor.fill(`${existingValue.trim()}\n\n- UI marker: ${marker}\n`);
    await saveButton.click();

    await expect(page.getByText('AGENTS.md gespeichert.')).toBeVisible({ timeout: 15000 });

    await page.reload();
    await expect(page.getByTestId('agent-managed-file-editor')).toHaveValue(new RegExp(marker));

    await page.getByRole('button', { name: /doctor ausführen/i }).click();
    await expect(page.getByText('Prompt files included:')).toContainText('AGENTS.md', { timeout: 15000 });
    await expect(page.getByText('Prompt fallback:')).toContainText('Inactive', { timeout: 15000 });

    await page.goto('/chat');

    const input = page.getByTestId('chat-input');
    await input.fill('Antworte nur mit READY.');
    await input.press('Enter');

    const assistantMessages = page.getByTestId('chat-message-assistant');
    await expect(assistantMessages).toHaveCount(1, { timeout: 60000 });
    await expect
      .poll(async () => ((await assistantMessages.first().textContent()) || '').replace(/\s+/g, ' ').trim(), {
        timeout: 60000,
      })
      .toContain('READY');
  });
});
