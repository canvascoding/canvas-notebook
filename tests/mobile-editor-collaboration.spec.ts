import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Editor } from '@tiptap/core';

type MobileFixtureWindow = Window & {
  mobileMessages: unknown[];
  mobileBridgeMessage: (raw: string) => Promise<void>;
  ReactNativeWebView: { injectedObjectJson: () => string; postMessage: (raw: string) => void };
  __canvasNotebookResolveCollaborationTicket: (id: string, session: unknown) => void;
};

// Exercises the exact generated Expo WebView asset against the versioned
// ticket endpoint and the real browser editor. Native bridge/disk acceptance
// belongs to the companion mobile repository's development-build tests.
test('Expo asset and web editor share block identities, deletion and undo', async ({ browser }) => {
  test.skip(!process.env.MOBILE_EDITOR_HTML || process.env.COLLABORATION_E2E !== '1', 'Requires the managed local stack and the companion Expo asset.');
  test.setTimeout(90_000);
  const baseURL = process.env.BASE_URL!;
  const context = await browser.newContext({ baseURL });
  const mobileContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true });
  await mobileContext.grantPermissions(['local-network-access'], { origin: baseURL });
  const web = await context.newPage();
  const mobile = await mobileContext.newPage();
  const errors: string[] = [];
  for (const page of [web, mobile]) page.on('pageerror', error => errors.push(error.message));
  let headers: Record<string, string> = {};
  const filePath = `expo-parity-${randomUUID()}.md`;
  try {
    for (const [page, email, password] of [
      [web, process.env.TEST_LOGIN_EMAIL, process.env.TEST_LOGIN_PASSWORD],
      [mobile, process.env.TEST_SECONDARY_EMAIL, process.env.TEST_SECONDARY_PASSWORD],
    ] as const) {
      const login = await page.request.post('/api/auth/sign-in/email', { headers: { Origin: baseURL }, data: { email, password } });
      expect(login.ok()).toBe(true);
    }
    const workspaces = await (await web.request.get('/api/workspaces')).json();
    const workspaceId = workspaces.workspaces.find((workspace: { name: string }) => workspace.name === 'Shared Test Workspace').id;
    headers = { 'x-canvas-workspace-id': workspaceId };
    const created = await web.request.post('/api/files/create', { headers, data: { path: filePath, type: 'file' } });
    expect(created.ok()).toBe(true);
    await context.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId);
    await web.goto(`/notebook?path=${encodeURIComponent(filePath)}`);
    await web.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
    const webEditor = web.locator('.tiptap-editor-shell .ProseMirror');
    await expect(webEditor).toHaveAttribute('contenteditable', 'true');
    await webEditor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.commands.insertContent('First paragraph\n\nSecond paragraph\n\nThird paragraph', { contentType: 'markdown' }));

    const freshSession = async () => {
      const response = await mobile.request.post('/api/mobile/v1/notebook/collaboration/session', {
        headers, data: { path: filePath, richTextSchemaVersion: 3, blockTreeFormatVersion: 1 },
      });
      const session = await response.json();
      expect(response.ok(), session.error).toBe(true);
      expect(session.representation).toBe('tiptap_blocks');
      expect(session.blockTreeFormatVersion).toBe(1);
      return { ...session, websocketUrl: new URL(session.websocketUrl, baseURL).href.replace(/^http/, 'ws') };
    };
    const session = await freshSession();
    const legacy = await mobile.request.post('/api/mobile/v1/notebook/collaboration/session', { headers, data: { path: filePath } });
    expect(legacy.status()).toBe(409);
    expect((await legacy.json()).code).toBe('representation_mismatch');
    await mobile.exposeFunction('mobileBridgeMessage', async (raw: string) => {
      const message = JSON.parse(raw);
      if (message.type === 'collaboration-ticket-request') {
        const renewed = await freshSession();
        await mobile.evaluate(({ id, renewed }) => (window as unknown as MobileFixtureWindow).__canvasNotebookResolveCollaborationTicket(id, renewed), { id: message.requestId, renewed });
      }
    });
    await mobile.addInitScript(input => {
      const fixture = window as unknown as MobileFixtureWindow;
      fixture.mobileMessages = [];
      fixture.ReactNativeWebView = {
        injectedObjectJson: () => sessionStorage.getItem('fixture-native-recovery') || JSON.stringify(input),
        postMessage: (raw: string) => { fixture.mobileMessages.push(JSON.parse(raw)); void fixture.mobileBridgeMessage(raw); },
      };
    }, { locale: 'en', variant: 'markdown', content: '', editable: true, collaboration: { session, active: true, offlineUpdate: null } });
    await mobile.route('**/__expo-editor-test', route => route.fulfill({ contentType: 'text/html', body: readFileSync(process.env.MOBILE_EDITOR_HTML!, 'utf8') }));
    await mobile.goto('/__expo-editor-test');
    const mobileEditor = mobile.locator('.ProseMirror');
    await mobileEditor.tap();
    await expect(mobileEditor).toHaveAttribute('contenteditable', 'true', { timeout: 15_000 }).catch(async error => {
      const diagnostics = await mobile.evaluate(() => (window as unknown as MobileFixtureWindow).mobileMessages.filter(message => {
        const type = (message as { type?: string }).type;
        return type === 'collaboration-status' || type === 'error';
      }));
      console.error(JSON.stringify({ diagnostics, errors }));
      throw error;
    });
    const json = (locator: typeof webEditor) => locator.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    await expect.poll(() => json(mobileEditor)).toEqual(await json(webEditor));
    await mobileEditor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.commands.insertContentAt(2, ' mobile'));
    await expect.poll(() => json(webEditor)).toEqual(await json(mobileEditor));
    // The web peer moves the same stable block, then the mobile peer deletes.
    await webEditor.evaluate(element => {
      const editor = (element as HTMLElement & { editor: Editor }).editor;
      const first = editor.state.doc.firstChild!;
      const tr = editor.state.tr.delete(0, first.nodeSize);
      editor.view.dispatch(tr.insert(tr.doc.content.size, first));
    });
    await expect.poll(() => json(mobileEditor)).toEqual(await json(webEditor));
    const beforeDelete = await json(mobileEditor);
    await mobileEditor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.commands.deleteRange({ from: 1, to: 3 }));
    await expect.poll(() => json(webEditor)).toEqual(await json(mobileEditor));
    await mobileEditor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.commands.undo());
    await expect.poll(() => json(mobileEditor)).toEqual(beforeDelete);
    await expect.poll(() => json(webEditor)).toEqual(beforeDelete);
    // The native file/barrier contract is tested in the companion repository.
    // Here the exact WebView bundle cold-opens its binary with no server.
    const latestSnapshot = () => mobile.evaluate(() => {
      const messages = (window as unknown as MobileFixtureWindow).mobileMessages as { type: string; update?: string }[];
      return messages.filter(message => message.type === 'collaboration-snapshot').at(-1)!.update!;
    });
    const update = await latestSnapshot();
    expect(update).toBeTruthy();
    await mobile.evaluate(({ session, update }) => sessionStorage.setItem('fixture-native-recovery', JSON.stringify({
      locale: 'en', variant: 'markdown', content: '', editable: true,
      collaboration: { session: { ...session, token: '', expiresAt: new Date(0).toISOString() }, active: false, offlineUpdate: update },
    })), { session, update });
    await mobileContext.setOffline(true);
    await mobile.reload();
    await mobileEditor.tap();
    await expect(mobileEditor).toHaveAttribute('contenteditable', 'true');
    await expect.poll(() => json(mobileEditor)).toEqual(beforeDelete);
    await mobileEditor.evaluate(element => {
      const instance = (element as HTMLElement & { editor: Editor }).editor;
      instance.commands.insertContentAt(1, { type: 'text', text: '# literal offline ' });
    });
    const offlineJson = await json(mobileEditor);
    const offlineUpdate = await latestSnapshot();
    expect(offlineUpdate).not.toBe(update);
    await mobile.evaluate(update => {
      const input = JSON.parse(sessionStorage.getItem('fixture-native-recovery')!);
      input.collaboration.offlineUpdate = update;
      sessionStorage.setItem('fixture-native-recovery', JSON.stringify(input));
    }, offlineUpdate);
    await mobile.reload();
    await mobileEditor.tap();
    await expect.poll(() => json(mobileEditor)).toEqual(offlineJson);
    await mobileContext.setOffline(false);
    await mobile.evaluate(() => {
      (window as unknown as { __canvasNotebookCommand: (input: object) => void })
        .__canvasNotebookCommand({ name: 'collaborationActive', payload: { active: true } });
    });
    await expect.poll(() => json(webEditor)).toEqual(offlineJson);
    expect(errors).toEqual([]);
    await mobile.screenshot({ path: test.info().outputPath('expo-live-editor.png') });
  } finally {
    await mobileContext.close();
    if (headers['x-canvas-workspace-id']) await web.request.delete('/api/files/delete', { headers, data: { path: filePath } });
    await context.close();
  }
});
