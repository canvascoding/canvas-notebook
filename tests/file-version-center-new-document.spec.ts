import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { FileVersionTimelineResponseV1 } from '../app/lib/file-version-center/contracts/v1';
import { createAuthenticatedContext } from './helpers/managed-test-context';

type Workspace = {
  id: string;
  type: string;
  legacy?: boolean;
  permissions: { canWrite: boolean; canDelete: boolean };
};

const scenarios = [
  { workspaceKind: 'personal', viewport: 'desktop', width: 1440, height: 900 },
  { workspaceKind: 'team', viewport: 'desktop', width: 1440, height: 900 },
  { workspaceKind: 'personal', viewport: 'mobile', width: 390, height: 844 },
] as const;

for (const scenario of scenarios) {
  test(`new ${scenario.workspaceKind} Markdown history works before its first editor session (${scenario.viewport})`, async ({ browser }, info) => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack.');
    test.setTimeout(120_000);
    const context = await createAuthenticatedContext(browser, {
      viewport: { width: scenario.width, height: scenario.height },
      isMobile: scenario.viewport === 'mobile', hasTouch: scenario.viewport === 'mobile',
    });
    const page = await context.newPage();
    const filePath = `fvrc-new-unopened-${randomUUID()}.md`;
    let workspaceId: string | undefined;
    let created = false;
    try {
      const workspacesResponse = await context.request.get('/api/workspaces');
      expect(workspacesResponse.ok()).toBeTruthy();
      const workspaces = (await workspacesResponse.json() as { workspaces: Workspace[] }).workspaces;
      const workspace = workspaces.find((item) =>
        (scenario.workspaceKind === 'personal' ? item.type === 'personal' : ['team', 'organization'].includes(item.type))
        && !item.legacy && item.permissions.canWrite && item.permissions.canDelete);
      expect(workspace, `A writable ${scenario.workspaceKind} workspace with cleanup rights is required.`).toBeTruthy();
      workspaceId = workspace!.id;
      const headers = { 'x-canvas-workspace-id': workspaceId };
      await context.addInitScript((id) => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);

      const create = await context.request.post('/api/files/create', {
        headers,
        data: { path: filePath, type: 'file' },
      });
      expect(create.ok(), `File creation failed with ${create.status()}.`).toBeTruthy();
      created = true;

      const target = { kind: 'path' as const, workspaceId, pathHint: filePath };
      const timelineResponse = await context.request.post('/api/files/version-center/v1/resolve', {
        headers,
        data: { contractVersion: 1, target, initialView: 'history', source: 'deep_link' },
      });
      expect(timelineResponse.ok(), `The unopened document timeline returned ${timelineResponse.status()}.`).toBeTruthy();
      const timeline = await timelineResponse.json() as FileVersionTimelineResponseV1;
      const current = timeline.entries.find((entry) => entry.kind === 'current');
      const initial = timeline.entries.find((entry) => entry.kind === 'revision');
      expect(current?.kind).toBe('current');
      expect(initial?.kind).toBe('revision');
      if (current?.kind !== 'current' || initial?.kind !== 'revision') throw new Error('Initial timeline is incomplete.');
      expect(initial.content.availability).toBe('available');
      expect(current.revisionId).toBe(initial.revisionId);
      expect(current.sizeBytes).toBe(0);

      const comparison = await context.request.post('/api/files/version-center/v1/compare', {
        headers,
        data: {
          contractVersion: 1, target,
          candidate: { kind: 'revision', id: initial.revisionId },
          expectedCurrent: { revisionId: current.revisionId, sha256: current.sha256 },
        },
      });
      expect(comparison.ok(), `The unopened document comparison returned ${comparison.status()}.`).toBeTruthy();
      const compared = await comparison.json() as {
        response: { candidate: { contentAvailable: boolean }; summary: { additions: number; deletions: number } };
      };
      expect(compared.response.candidate.contentAvailable).toBe(true);
      expect(compared.response.summary).toMatchObject({ additions: 0, deletions: 0 });

      let fixtureEditorSessions = 0;
      page.on('request', (request) => {
        if (request.method() !== 'POST' || !request.url().includes('/api/files/collaboration/session')) return;
        try {
          if ((request.postDataJSON() as { path?: string }).path === filePath) fixtureEditorSessions += 1;
        } catch { /* Ignore non-JSON session requests. */ }
      });
      await page.goto(buildFileVersionCenterDeepLinkV1('/en/notebook', {
        contractVersion: 1, target, initialView: 'history', source: 'deep_link',
      }));
      const dialog = page.getByRole('dialog', { name: 'Versions & changes' });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      if (scenario.viewport === 'desktop') {
        await expect(dialog.getByRole('heading', { name: /^Current version · Version 1$/u })).toBeVisible();
      } else {
        await expect(dialog.getByRole('region', { name: 'Current' })
          .getByRole('button', { name: /^Current version Version 1/u })).toHaveAttribute('aria-pressed', 'true');
      }
      await expect(dialog.getByRole('region', { name: 'Version history' })).toContainText('No older saved versions.');
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      expect(fixtureEditorSessions, 'Opening history must not first initialize the document editor.').toBe(0);
      const screenshot = await page.screenshot({ fullPage: true });
      await info.attach(`${scenario.workspaceKind}-${scenario.viewport}-unopened-version-center.png`, {
        contentType: 'image/png', body: screenshot,
      });
      if (process.env.FVRC_E2E_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.FVRC_E2E_SCREENSHOT_DIR, { recursive: true });
        await fs.writeFile(path.join(process.env.FVRC_E2E_SCREENSHOT_DIR,
          `${scenario.workspaceKind}-${scenario.viewport}-unopened-version-center.png`), screenshot);
      }

      await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`);
      const editorSession = await context.request.post('/api/files/collaboration/session', {
        headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      expect(editorSession.ok(), `The first editor session returned ${editorSession.status()}.`).toBeTruthy();
      const afterOpen = await context.request.post('/api/files/version-center/v1/resolve', {
        headers, data: { contractVersion: 1, target, initialView: 'history', source: 'deep_link' },
      });
      expect(afterOpen.ok(), 'History must remain available after the first editor session.').toBeTruthy();
    } finally {
      await page.goto('about:blank').catch(() => undefined);
      if (created && workspaceId) {
        const cleanup = await context.request.delete('/api/files/delete', {
          headers: { 'x-canvas-workspace-id': workspaceId }, data: { path: filePath },
        });
        expect(cleanup.ok(), `Could not remove the scoped E2E document (${cleanup.status()}).`).toBeTruthy();
      }
      await context.close();
    }
  });
}
