import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import type { AuthorizedEmailClassificationMailbox, EmailMailboxSourceOption } from '../app/lib/email/classification/mailbox-types';
import type { UserPreferences } from '../app/lib/user-preferences';

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-email-experience-'));
  process.env.DATA = directory;
  process.env.CANVAS_DATA_ROOT = directory;
  const loader = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
  const originalLoad = loader._load;
  let limited = false;
  let catalogUnavailable = false;
  let aliceCanRead = true;
  const catalogActors: string[] = [];
  const rateIdentities: Array<{ verifiedUserId?: string }> = [];
  const source = (owner: string, sourceKind: 'local' | 'managed', workspaceId: string | null): AuthorizedEmailClassificationMailbox => ({
    mailboxRef: 'emb:' + (owner === 'alice' ? 'a' : 'b').repeat(64), ownerUserId: owner, accountSource: sourceKind,
    accountId: 'same-account-id', provider: 'google', workspaceId, mailboxId: workspaceId ? 'workspace-binding' : null,
    bindingRevision: 'binding', connectionRevision: 'connection', policyRevision: 'policy', active: true, readFrom: [],
    emailAddress: owner + '@example.test', displayName: owner, workspaceName: workspaceId ? 'Test workspace' : null,
    capabilities: { canRead: true, canWrite: !workspaceId, canDelete: !workspaceId, canRunAgent: false, canManage: !workspaceId },
  });
  const aliceSource = { ...source('alice', 'local', 'workspace'), endpoint: 'https://private.example.test', credentialKey: 'PRIVATE_CREDENTIAL',
    capabilities: { ...source('alice', 'local', 'workspace').capabilities, internalSecret: 'PRIVATE_CAPABILITY' } };
  const bobSource = source('bob', 'managed', null);
  const matches = (request: string, name: string) => request === '@/app/lib/' + name || request.endsWith('/app/lib/' + name) || request.endsWith('/app/lib/' + name + '.ts');
  loader._load = (request, parent, isMain) => {
    if (matches(request, 'auth')) return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const actor = headers.get('x-test-user');
      return actor && ['alice', 'bob'].includes(actor) ? { user: { id: actor, email: actor + '@example.test', role: 'user' } } : null;
    } } } };
    if (matches(request, 'agents/registry') || matches(request, 'agents/access') || matches(request, 'db') || matches(request, 'email/account-store')) return {};
    if (matches(request, 'utils/rate-limit')) return { rateLimit: (_request: NextRequest, options: { verifiedUserId?: string }) => {
      rateIdentities.push(options);
      return limited ? { ok: false, response: NextResponse.json({ success: false }, { status: 429 }) } : { ok: true };
    } };
    if (matches(request, 'email/classification/mailbox-registry')) return { resolveAuthorizedEmailClassificationMailboxes: async (actor: string) => {
      catalogActors.push(actor);
      if (catalogUnavailable) throw new Error('Credentials PRIVATE_CREDENTIAL at https://private.example.test');
      return actor === 'alice' ? aliceCanRead ? [aliceSource] : [] : [bobSource];
    } };
    return originalLoad(request, parent, isMain);
  };
  try {
    const preferences = await import('../app/lib/user-preferences');
    const storage = await import('../app/lib/settings-storage');
    const preferenceRoute = await import('../app/api/user-preferences/route');
    const mailboxRoute = await import('../app/api/email/classification/mailboxes/route');
    const preferencePath = storage.resolveSettingsStoragePath('user-preferences.json');
    const request = (actor?: string, payload?: unknown, route = '/api/user-preferences?userId=bob') => new NextRequest('https://canvas.test' + route, {
      method: payload === undefined ? 'GET' : 'PATCH', headers: { 'Content-Type': 'application/json', ...(actor ? { 'x-test-user': actor } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const privateStatus = (response: Response, status: number) => {
      assert.equal(response.status, status); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    };
    privateStatus(await preferenceRoute.GET(request()), 401);
    privateStatus(await preferenceRoute.PATCH(request(undefined, { emailExperienceMode: 'focus' })), 401);
    privateStatus(await mailboxRoute.GET(request(undefined, undefined, '/api/email/classification/mailboxes')), 401);
    assert.equal(catalogActors.length, 0, 'No catalog resolution without a verified session');
    assert.equal((await preferences.getUserPreferences('alice')).emailExperienceMode, undefined, 'Missing personal preference preserves the server default');
    await fs.mkdir(path.dirname(preferencePath), { recursive: true });
    await fs.writeFile(preferencePath, JSON.stringify({ version: 1, users: {
      alice: { emailExperienceMode: 'automatic', locale: 'en', developerMode: true, emailAllowRemoteImages: false, emailRemoteImageAllowedSenders: ['alice@example.test'], inboxExcludedWorkspaceIds: ['outside-workspace'], teamLicenseNotificationsEnabled: false },
      bob: { emailExperienceMode: 'classic', locale: 'de', developerMode: false, teamLicenseEmailNotificationsEnabled: false },
    } }));
    assert.equal((await preferences.getUserPreferences('alice')).emailExperienceMode, undefined, 'Persisted invalid values cannot choose a mode');
    const bobBefore = await preferences.getUserPreferences('bob');
    const focused = await preferenceRoute.PATCH(request('alice', { emailExperienceMode: 'focus', userId: 'bob', role: 'admin' }));
    privateStatus(focused, 200);
    const focusedData = (await focused.json()).data;
    assert.equal(focusedData.emailExperienceMode, 'focus'); assert.equal(focusedData.locale, 'en'); assert.equal(focusedData.developerMode, true);
    assert.equal(focusedData.emailAllowRemoteImages, false); assert.deepEqual(focusedData.emailRemoteImageAllowedSenders, ['alice@example.test']);
    assert.deepEqual(focusedData.inboxExcludedWorkspaceIds, ['outside-workspace']); assert.equal(focusedData.teamLicenseNotificationsEnabled, false);
    assert.equal('role' in focusedData, false);
    assert.deepEqual(await preferences.getUserPreferences('bob'), bobBefore, 'Body/query user hints cannot change another user');
    const fileBeforeInvalid = await fs.readFile(preferencePath);
    for (const emailExperienceMode of ['automatic', 'FOCUS', ' focus ', true, false, 0, 1, [], {}, undefined]) {
      privateStatus(await preferenceRoute.PATCH(request('alice', { emailExperienceMode })), 400);
      assert.deepEqual(await fs.readFile(preferencePath), fileBeforeInvalid, 'Invalid mode requests never modify persisted preferences');
    }
    for (const emailExperienceMode of ['automatic', true, null]) {
      await assert.rejects(preferences.updateUserPreferences('alice', { emailExperienceMode } as unknown as UserPreferences), /Unsupported email experience mode/u);
      assert.deepEqual(await fs.readFile(preferencePath), fileBeforeInvalid);
    }
    await Promise.all([
      preferences.updateUserPreferences('alice', { emailExperienceMode: 'classic' }),
      preferences.updateUserPreferences('alice', { emailAllowRemoteImages: true }),
    ]);
    const concurrent = await preferences.getUserPreferences('alice');
    assert.equal(concurrent.emailExperienceMode, 'classic'); assert.equal(concurrent.emailAllowRemoteImages, true); assert.equal(concurrent.locale, 'en');
    const persisted = JSON.parse(await fs.readFile(preferencePath, 'utf8'));
    assert.equal(persisted.users.alice.emailExperienceMode, 'classic'); assert.deepEqual(persisted.users.bob, bobBefore);
    const reset = await preferenceRoute.PATCH(request('alice', { emailExperienceMode: null })); privateStatus(reset, 200);
    assert.equal('emailExperienceMode' in (await reset.json()).data, false, 'JSON null resets the optional choice');
    assert.equal((await preferences.getUserPreferences('alice')).emailExperienceMode, undefined);
    await preferences.updateUserPreferences('alice', { emailExperienceMode: 'focus' });
    await preferences.updateUserPreferences('alice', { emailExperienceMode: undefined });
    assert.equal((await preferences.getUserPreferences('alice')).emailExperienceMode, undefined, 'Internal undefined resets the optional choice');
    await preferenceRoute.PATCH(request('alice', { emailExperienceMode: 'classic' }));
    await preferenceRoute.PATCH(request('alice', { locale: 'de' }));
    const unrelated = (await (await preferenceRoute.GET(request('alice'))).json()).data;
    assert.equal(unrelated.emailExperienceMode, 'classic'); assert.equal(unrelated.locale, 'de');
    assert.deepEqual(await preferences.getUserPreferences('bob'), bobBefore);

    const catalog = await mailboxRoute.GET(request('alice', undefined, '/api/email/classification/mailboxes?userId=bob'));
    privateStatus(catalog, 200);
    const catalogData = (await catalog.json()).data.mailboxes as EmailMailboxSourceOption[];
    assert.deepEqual(Object.keys(catalogData[0]).sort(), ['mailboxRef','accountId','accountSource','workspaceId','mailboxId','emailAddress','displayName','workspaceName','capabilities'].sort());
    assert.deepEqual(Object.keys(catalogData[0].capabilities).sort(), ['canRead','canWrite','canDelete','canRunAgent','canManage'].sort());
    assert.equal(catalogData[0].accountSource, 'local'); assert.equal(catalogData[0].capabilities.canWrite, false);
    assert.equal(JSON.stringify(catalogData).includes('PRIVATE_'), false); assert.equal(JSON.stringify(catalogData).includes('private.example'), false);
    assert.equal('ownerUserId' in catalogData[0], false); assert.deepEqual(catalogActors, ['alice']);
    const bobCatalog = (await (await mailboxRoute.GET(request('bob', undefined, '/api/email/classification/mailboxes'))).json()).data.mailboxes;
    assert.equal(bobCatalog[0].accountSource, 'managed'); assert.notEqual(bobCatalog[0].mailboxRef, catalogData[0].mailboxRef, 'Same account IDs remain source-qualified');
    aliceCanRead = false;
    assert.deepEqual((await (await mailboxRoute.GET(request('alice', undefined, '/api/email/classification/mailboxes'))).json()).data.mailboxes, [], 'Every catalog request resolves current rights');
    limited = true; const callsBeforeLimit = catalogActors.length;
    privateStatus(await mailboxRoute.GET(request('alice', undefined, '/api/email/classification/mailboxes')), 429);
    assert.equal(catalogActors.length, callsBeforeLimit); limited = false;
    assert.ok(rateIdentities.every(identity => identity.verifiedUserId === 'alice' || identity.verifiedUserId === 'bob'));
    catalogUnavailable = true;
    const unavailable = await mailboxRoute.GET(request('bob', undefined, '/api/email/classification/mailboxes')); privateStatus(unavailable, 503);
    assert.equal((await unavailable.text()).includes('PRIVATE_CREDENTIAL'), false);
    console.log('Email experience preferences and authorized mailbox catalog passed: persistence, strict mode/reset, concurrent merge, actor separation, safe DTO, current rights and rate identity.');
  } finally {
    loader._load = originalLoad;
    await fs.rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
