import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'dotenv';
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

const envPath = process.env.CANVAS_SECRETS_UI_ENV_FILE;
const fixturePath = process.env.CANVAS_SECRETS_UI_FIXTURES_FILE;
if (!envPath || !fixturePath) throw new Error('Provide private isolated host ENV and managed login fixture files.');

type Scope = 'user' | 'organization' | 'system';
type EnvState = { entries: Array<{ key: string; value: string; categories: string[]; reserved: boolean }>; rawContent: string; revision: string };

async function state(context: BrowserContext, scope: Scope): Promise<EnvState> {
  const response = await context.request.get(`/api/integrations/env?scope=all&secretScope=${scope}`);
  assert.equal(response.status(), 200, `Cannot read ${scope} secrets`);
  const payload = await response.json();
  assert.equal(payload.success, true);
  return payload.data;
}
async function patch(context: BrowserContext, scope: Scope, entries: Array<{ key: string; value: string | null }>): Promise<void> {
  const response = await context.request.patch('/api/integrations/env', { data: { scope: 'all', secretScope: scope, patches: entries } });
  assert.equal(response.status(), 200, `Cannot patch ${scope} secrets`);
}
function value(snapshot: EnvState, key: string): string | undefined { return snapshot.entries.find(entry => entry.key === key)?.value; }
function row(page: Page, editor: Locator, key: string): Locator {
  return editor.getByTestId('secret-entry').filter({ has: page.locator(`[data-testid="secret-entry-key"][value="${key}"]`) });
}
async function ready(editor: Locator): Promise<void> {
  await expect(editor.getByTestId('secret-scope')).toBeEnabled({ timeout: 120_000 });
  await expect(editor.getByTestId('secret-save')).toBeVisible();
}
async function save(page: Page, editor: Locator, method: 'PATCH' | 'PUT', status = 200): Promise<void> {
  const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/integrations/env' && res.request().method() === method);
  await editor.getByTestId('secret-save').click();
  assert.equal((await response).status(), status);
  await expect(editor.getByTestId('secret-scope')).toBeEnabled({ timeout: 120_000 });
}
async function main() {
  const deployment = parse(await fs.readFile(envPath!, 'utf8'));
  const fixture = parse(await fs.readFile(fixturePath!, 'utf8'));
  const baseURL = deployment.BASE_URL;
  const url = new URL(baseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'This writes only to a local test server.');
  assert.ok(deployment.CANVAS_DATA_ROOT.startsWith(os.tmpdir()) || deployment.CANVAS_DATA_ROOT.startsWith('/tmp/'), 'Use an isolated temporary DATA clone.');
  assert.ok(new URL(deployment.DATABASE_URL).pathname.startsWith('/canvas_secrets_'), 'Use an isolated secrets test database.');
  const reportDir = path.dirname(envPath!);
  const browser = await chromium.launch({ headless: true });
  const admin = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  const member = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  try {
    const login = async (context: BrowserContext, email: string, password: string): Promise<string> => {
      const response = await context.request.post('/api/auth/sign-in/email', { data: { email, password }, headers: { origin: baseURL } });
      assert.equal(response.status(), 200, 'Fixture sign-in must succeed.');
      return (await response.json()).user.id;
    };
    const adminId = await login(admin, deployment.BOOTSTRAP_ADMIN_EMAIL, deployment.BOOTSTRAP_ADMIN_PASSWORD);
    await login(member, fixture.LOCAL_TEAM_SEAT_SECONDARY_EMAIL, fixture.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD);
    for (const scope of ['user', 'organization', 'system'] as const) await patch(admin, scope, [
      { key: 'GEMINI_API_KEY', value: `fixture-${scope}-gemini` },
      { key: 'BRAVE_API_KEY', value: `fixture-${scope}-brave` },
      { key: 'UI_BROWSER_OTHER', value: `fixture-${scope}-other` },
      { key: 'UI_BROWSER_LITERAL', value: null },
      { key: 'UI_BROWSER_CONCURRENT', value: null },
    ]);
    await patch(member, 'user', [{ key: 'GEMINI_API_KEY', value: 'fixture-member-gemini' }]);

    const page = await admin.newPage();
    await page.goto('/en/settings?tab=secrets', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const editor = page.getByTestId('unified-secrets-editor');
    await ready(editor);
    assert.deepEqual(await editor.getByTestId('secret-scope').locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ['user', 'organization', 'system']);
    for (const input of await editor.getByTestId('secret-entry-value').all()) assert.equal(await input.getAttribute('type'), 'password');
    await editor.getByTestId('secret-category').selectOption('media');
    await expect(row(page, editor, 'GEMINI_API_KEY')).toHaveCount(1);
    await expect(row(page, editor, 'BRAVE_API_KEY')).toHaveCount(0);
    await row(page, editor, 'GEMINI_API_KEY').getByTestId('secret-entry-value').fill('fixture-user-updated');
    await save(page, editor, 'PATCH');
    let current = await state(admin, 'user');
    assert.equal(value(current, 'GEMINI_API_KEY'), 'fixture-user-updated');
    assert.equal(value(current, 'BRAVE_API_KEY'), 'fixture-user-brave', 'filtered edits preserve unrelated categories');
    assert.equal(value(await state(admin, 'organization'), 'GEMINI_API_KEY'), 'fixture-organization-gemini');
    assert.equal(value(await state(admin, 'system'), 'GEMINI_API_KEY'), 'fixture-system-gemini');
    await editor.getByTestId('secret-category').selectOption('agent-runtime');
    await expect(row(page, editor, 'GEMINI_API_KEY').getByTestId('secret-entry-value')).toHaveValue('fixture-user-updated');
    await editor.getByTestId('secret-category').selectOption('integrations');
    await expect(row(page, editor, 'BRAVE_API_KEY')).toHaveCount(1);
    await expect(row(page, editor, 'GEMINI_API_KEY')).toHaveCount(0);
    await editor.getByTestId('secret-category').selectOption('other');
    await expect(row(page, editor, 'UI_BROWSER_OTHER')).toHaveCount(1);

    await editor.getByTestId('secret-editor-mode').selectOption('raw');
    await expect(editor.getByTestId('secret-category')).toBeDisabled();
    const raw = editor.getByTestId('secret-raw-content');
    const literal = 'line 1 # ${UNCHANGED} $TOKEN\nline 2 "quoted" \\ path';
    const literalLine = 'UI_BROWSER_LITERAL="line 1 # ${UNCHANGED} $TOKEN\\nline 2 \\"quoted\\" \\\\ path"';
    const initialRaw = await raw.inputValue();
    assert.equal(initialRaw.includes('CANVAS_CREDENTIAL_'), false, 'raw editor does not expose connection tokens');
    await raw.fill(initialRaw + '\n# browser comment retained\n' + literalLine + '\n');
    await save(page, editor, 'PUT');
    current = await state(admin, 'user');
    assert.equal(value(current, 'UI_BROWSER_LITERAL'), literal, 'raw ENV remains literal and round-trips escaped characters');
    assert.ok(current.rawContent.includes('# browser comment retained'));
    await editor.getByTestId('secret-editor-mode').selectOption('keys');
    await editor.getByTestId('secret-category').selectOption('other');
    const literalRow = row(page, editor, 'UI_BROWSER_LITERAL');
    await expect(literalRow.getByTestId('secret-entry-value')).toHaveAttribute('type', 'password');
    await literalRow.getByRole('button', { name: 'Show value' }).click();
    await expect(literalRow.getByTestId('secret-entry-value')).toHaveValue(literal);
    assert.equal(await literalRow.getByTestId('secret-entry-value').evaluate(element => element.tagName), 'TEXTAREA');
    await literalRow.getByTestId('secret-entry-value').fill(literal + '\nline 3');
    await save(page, editor, 'PATCH');
    assert.equal(value(await state(admin, 'user'), 'UI_BROWSER_LITERAL'), literal + '\nline 3');

    // A second browser/API save must produce a visible conflict, preserving the draft.
    await editor.getByTestId('secret-editor-mode').selectOption('raw');
    const revisionRaw = await raw.inputValue();
    await patch(admin, 'user', [{ key: 'UI_BROWSER_CONCURRENT', value: 'fixture-concurrent' }]);
    await raw.fill(revisionRaw + '\nUI_BROWSER_DRAFT="fixture-not-written"\n');
    await save(page, editor, 'PUT', 409);
    await expect(editor.getByRole('alert')).toContainText('changed');
    await expect(raw).toHaveValue(revisionRaw + '\nUI_BROWSER_DRAFT="fixture-not-written"\n');
    assert.equal(value(await state(admin, 'user'), 'UI_BROWSER_DRAFT'), undefined);
    page.once('dialog', dialog => dialog.accept());
    await editor.getByRole('button', { name: 'Reload latest version' }).click();
    await ready(editor);
    assert.ok((await raw.inputValue()).includes('UI_BROWSER_CONCURRENT'));
    await editor.getByTestId('secret-editor-mode').selectOption('keys');
    await editor.getByTestId('secret-category').selectOption('media');

    // Canceling a scope change keeps the personal draft and source scope intact.
    await row(page, editor, 'GEMINI_API_KEY').getByTestId('secret-entry-value').fill('fixture-unsaved');
    page.once('dialog', dialog => dialog.dismiss());
    await editor.getByTestId('secret-scope').selectOption('system');
    await expect(editor.getByTestId('secret-scope')).toHaveValue('user');
    await expect(row(page, editor, 'GEMINI_API_KEY').getByTestId('secret-entry-value')).toHaveValue('fixture-unsaved');
    page.once('dialog', dialog => dialog.accept());
    await editor.getByTestId('secret-scope').selectOption('system');
    await ready(editor);
    await expect(row(page, editor, 'GEMINI_API_KEY').getByTestId('secret-entry-value')).toHaveValue('fixture-system-gemini');
    await row(page, editor, 'GEMINI_API_KEY').getByTestId('secret-entry-value').fill('fixture-system-updated');
    await save(page, editor, 'PATCH');
    await editor.getByTestId('secret-scope').selectOption('organization');
    await ready(editor);
    await expect(row(page, editor, 'GEMINI_API_KEY').getByTestId('secret-entry-value')).toHaveValue('fixture-organization-gemini');
    await row(page, editor, 'GEMINI_API_KEY').getByTestId('secret-entry-value').fill('fixture-organization-updated');
    await save(page, editor, 'PATCH');
    assert.equal(value(await state(admin, 'user'), 'GEMINI_API_KEY'), 'fixture-user-updated');
    assert.equal(value(await state(admin, 'system'), 'GEMINI_API_KEY'), 'fixture-system-updated');
    assert.equal(value(await state(admin, 'organization'), 'GEMINI_API_KEY'), 'fixture-organization-updated');

    const memberPage = await member.newPage();
    await memberPage.goto('/de/settings?tab=secrets', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const memberEditor = memberPage.getByTestId('unified-secrets-editor');
    await ready(memberEditor);
    assert.deepEqual(await memberEditor.getByTestId('secret-scope').locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ['user']);
    await expect(memberEditor).toContainText('Secrets und Variablen');
    await memberEditor.getByTestId('secret-category').selectOption('media');
    await row(memberPage, memberEditor, 'GEMINI_API_KEY').getByTestId('secret-entry-value').fill('fixture-member-updated');
    await save(memberPage, memberEditor, 'PATCH');
    assert.equal(value(await state(member, 'user'), 'GEMINI_API_KEY'), 'fixture-member-updated');
    assert.equal(value(await state(admin, 'user'), 'GEMINI_API_KEY'), 'fixture-user-updated');
    for (const scope of ['system', 'organization'] as const) assert.equal((await member.request.get(`/api/integrations/env?scope=all&secretScope=${scope}`)).status(), 403);
    const spoof = await member.request.get(`/api/integrations/env?scope=all&secretScope=user&userId=${encodeURIComponent(adminId)}`);
    assert.equal(value((await spoof.json()).data, 'GEMINI_API_KEY'), 'fixture-member-updated', 'session owner wins over supplied user ID');
    await memberPage.setViewportSize({ width: 390, height: 844 });
    await memberEditor.scrollIntoViewIfNeeded();
    assert.ok(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile page must not overflow');
    await memberEditor.screenshot({ path: path.join(reportDir, 'secrets-mobile.png') });
    await page.goto('/de/settings?tab=secrets', { waitUntil: 'domcontentloaded' });
    await ready(page.getByTestId('unified-secrets-editor'));
    await page.getByTestId('unified-secrets-editor').screenshot({ path: path.join(reportDir, 'secrets-desktop.png') });
    await fs.writeFile(path.join(reportDir, 'browser-result.json'), JSON.stringify({ passed: true, browser: 'Chromium', currentWorktree: true, checks: ['bootstrap-login', 'masked-fields', 'category-filters', 'targeted-edit', 'raw-literal-comments', 'revision-conflict', 'dirty-scope-cancel', 'user-org-system-isolation', 'member-permissions', 'foreign-owner-rejection', 'de-en', 'mobile'] }, null, 2));
    console.log('unified-secrets-browser-test: PASS (current worktree, actual auth/API/files, admin + member, all scopes, filters, raw/form, conflict, DE/EN, mobile)');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exit(1); });
