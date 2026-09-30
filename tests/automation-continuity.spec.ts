import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

type CreatedJob = { id: string; workspaceId: string | null };
type JobDetail = { continuityMode: string; sourceJobIds: string[] };

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3100';
const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

test.use({ screenshot: 'only-on-failure' });
test.skip(process.env.E2E_EXTERNAL_SERVER !== '1', 'Requires the managed external Notebook server.');
test.setTimeout(90_000);

async function signIn(page: Page): Promise<void> {
  expect(adminEmail, 'BOOTSTRAP_ADMIN_EMAIL must be configured.').toBeTruthy();
  expect(adminPassword, 'BOOTSTRAP_ADMIN_PASSWORD must be configured.').toBeTruthy();
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: baseURL },
    data: { email: adminEmail, password: adminPassword },
  });
  expect(response.ok(), 'Bootstrap admin login must succeed.').toBe(true);
}

async function createJob(page: Page, name: string, status: 'active' | 'paused',
  workspaceId?: string | null): Promise<CreatedJob> {
  const futureHour = String((new Date().getUTCHours() + 3) % 24).padStart(2, '0');
  const response = await page.request.post('/api/automations/jobs', {
    headers: { Origin: baseURL },
    data: {
      name, prompt: `Playwright fixture for ${name}. No manual run is requested.`,
      ...(workspaceId ? { workspaceId } : {}),
      status, schedule: { kind: 'daily', times: [`${futureHour}:37`], timeZone: 'UTC' },
    },
  });
  expect(response.status(), 'Test automation must be created.').toBe(201);
  const payload = await response.json() as { success: boolean; data: CreatedJob };
  expect(payload.success).toBe(true);
  expect(payload.data.id).toBeTruthy();
  return payload.data;
}

async function deleteJobs(page: Page, ids: string[]): Promise<void> {
  for (const id of ids.reverse()) {
    const response = await page.request.delete(`/api/automations/jobs/${encodeURIComponent(id)}`, {
      headers: { Origin: baseURL },
    });
    expect(response.ok(), `Cleanup must delete automation ${id}.`).toBe(true);
  }
}

test('persists last relevant result and one authorized source in the same workspace', async ({ page }) => {
  expect(new URL(baseURL).origin).toBe('http://127.0.0.1:3100');
  await signIn(page);
  const created: string[] = [];
  try {
    const suffix = randomUUID().slice(0, 8);
    const sourceName = `PW continuity source ${suffix}`;
    const source = await createJob(page, sourceName, 'active');
    created.push(source.id);
    expect(source.workspaceId).toBeTruthy();
    const target = await createJob(page, `PW continuity target ${suffix}`, 'paused', source.workspaceId);
    created.push(target.id);
    expect(target.workspaceId).toBe(source.workspaceId);

    await page.goto(`/en/automations/${encodeURIComponent(target.id)}`);
    await expect(page.getByTestId('automation-detail-summary')).toBeVisible();
    await page.getByTestId('automation-edit').click();
    await page.locator('summary').filter({ hasText: 'Continuity & sources' }).click();
    const continuity = page.getByTestId('automation-scheduled-continuity');
    await continuity.getByTestId('automation-scheduled-continuity-mode').selectOption('last_relevant');
    await continuity.getByRole('checkbox', { name: sourceName }).check();
    await expect(continuity.getByRole('checkbox', { name: sourceName })).toBeChecked();
    await page.getByTestId('automation-save').click();
    await expect(page.getByTestId('automation-edit')).toBeVisible();

    const response = await page.request.get(`/api/automations/jobs/${encodeURIComponent(target.id)}`);
    expect(response.ok()).toBe(true);
    const payload = await response.json() as { success: boolean; data: JobDetail };
    expect(payload.success).toBe(true);
    expect(payload.data.continuityMode).toBe('last_relevant');
    expect(payload.data.sourceJobIds).toEqual([source.id]);

    await page.reload();
    await page.getByTestId('automation-edit').click();
    await page.locator('summary').filter({ hasText: 'Continuity & sources' }).click();
    const saved = page.getByTestId('automation-scheduled-continuity');
    await expect(saved.getByTestId('automation-scheduled-continuity-mode')).toHaveValue('last_relevant');
    await expect(saved.getByRole('checkbox', { name: sourceName })).toBeChecked();
    await expect(saved.locator('input[type="checkbox"]:checked')).toHaveCount(1);
  } finally {
    await deleteJobs(page, created);
  }
});

test('renders state on demand and a skipped occurrence separately when there are no runs', async ({ page }) => {
  expect(new URL(baseURL).origin).toBe('http://127.0.0.1:3100');
  await signIn(page);
  const created: string[] = [];
  try {
    const job = await createJob(page, `PW continuity diagnostics ${randomUUID().slice(0, 8)}`, 'paused');
    created.push(job.id);
    const statePath = `/api/automations/jobs/${encodeURIComponent(job.id)}/state`;
    const runsPath = `/api/automations/jobs/${encodeURIComponent(job.id)}/runs`;
    const stateKey = `cursor-${randomUUID().slice(0, 8)}`;
    const stateValue = `private-value-${randomUUID().slice(0, 8)}`;
    let statePresent = true;
    let valueReads = 0;
    let resetBody: { key?: string; expectedRevision?: number; mutationId?: string } | null = null;
    const updatedAt = new Date().toISOString();
    await page.route(`**${statePath}*`, async (route) => {
      const request = route.request();
      const key = new URL(request.url()).searchParams.get('key');
      if (request.method() === 'DELETE') {
        resetBody = request.postDataJSON() as typeof resetBody;
        statePresent = false;
        await route.fulfill({ json: { success: true, data: { action: 'delete', key: stateKey, previousRevision: 3 } } });
      } else if (key !== null) {
        valueReads += 1;
        await route.fulfill({ json: { success: true, data: {
          key: stateKey, value: stateValue, revision: 3, updatedAt,
        } } });
      } else {
        await route.fulfill({ json: { success: true, data: statePresent
          ? [{ key: stateKey, revision: 3, updatedAt }] : [] } });
      }
    });
    await page.route(`**${runsPath}`, async (route) => {
      await route.fulfill({ json: { success: true, data: [], diagnostics: [{
        kind: 'schedule_misfire', scheduledFor: '2026-09-28T09:00:00.000Z',
        observedAt: '2026-09-28T09:02:01.000Z', nextRunAt: null,
        reason: 'scheduler_downtime',
      }] } });
    });

    await page.goto(`/en/automations/${encodeURIComponent(job.id)}`);
    await expect(page.getByTestId('automation-schedule-misfire')).toBeVisible();
    await expect(page.getByTestId('automation-schedule-misfire')).toContainText('No further occurrence');
    await expect(page.getByTestId('automation-run-list').locator('button[data-testid^="automation-run-"]'))
      .toHaveCount(0);
    await page.locator('summary').filter({ hasText: 'Automation knowledge' }).click();
    const state = page.getByTestId('automation-job-state');
    await expect(state).toContainText(stateKey);
    await expect(state).not.toContainText(stateValue);
    expect(valueReads).toBe(0);
    await state.getByRole('button', { name: 'Show value' }).click();
    await expect(state).toContainText(stateValue);
    expect(valueReads).toBe(1);
    await state.getByRole('button', { name: 'Reset key' }).click();
    await expect(state).toContainText('No saved state yet.');
    expect(resetBody).toMatchObject({ key: stateKey, expectedRevision: 3 });
    expect((resetBody as { mutationId?: string } | null)?.mutationId).toBeTruthy();
    await expect(page.getByTestId('automation-schedule-misfire')).toBeVisible();
  } finally {
    await deleteJobs(page, created);
  }
});
