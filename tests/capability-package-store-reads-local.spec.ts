import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { CapabilityPackageStoreSelection, CapabilityPackageStoreListResponse } from '../app/lib/capabilities/packages/store-contracts';
import type { CapabilityPackagePresentation } from '../app/lib/capabilities/packages/presentation-contracts';
import type { CapabilityPackageStoreInstallOptions } from '../app/lib/capabilities/packages/store-install-options-contracts';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

test.use({ trace: 'off', video: 'off' });

async function result<T>(response: APIResponse, operation: string): Promise<T> {
  expect(response.status(), operation).toBe(200);
  const body = await response.json() as { success: boolean; data: T };
  expect(body.success, operation).toBe(true);
  return body.data;
}

/** Actual authenticated host routes and verified HTTPS archive; no installation or shared fixture writes. */
test('scoped Store metadata, verified preview and permitted installation targets share the current actor contract', async ({ browser }) => {
  test.setTimeout(120_000);
  const fixtureFile = process.env.CAPABILITY_STORE_E2E_FIXTURE;
  if (!fixtureFile || !path.isAbsolute(fixtureFile)) throw new Error('An owned private Store fixture is required.');
  const fixture = JSON.parse(await fs.readFile(fixtureFile, 'utf8')) as { nonce: string; name: string; sources: CapabilityPackageStoreSelection[] };
  expect(fixture.name).toBe(`package-editor-qa-${fixture.nonce}`);
  const memberEmail = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
  const memberPassword = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
  if (!memberEmail || !memberPassword) throw new Error('Existing managed member credentials are required.');
  const admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } });
  const member = await createAuthenticatedContext(browser, {}, { email: memberEmail, password: memberPassword });
  try {
    await runManagedTestPreflight(admin); await runManagedTestPreflight(member);
    const actorId = (await (await requestManagedTestSession(admin.request)).json()).user.id as string;
    const memberId = (await (await requestManagedTestSession(member.request)).json()).user.id as string;
    const workspaces = async (context: typeof admin, userId: string) => {
      const body = await (await context.request.get('/api/workspaces')).json() as { workspaces: ClientWorkspaceSummary[] };
      const own = body.workspaces.find(item => item.type === 'personal' && item.status === 'active' && item.ownerUserId === userId);
      expect(own).toBeDefined(); return own!.id;
    };
    const workspaceId = await workspaces(admin, actorId), memberWorkspaceId = await workspaces(member, memberId);
    const scoped = (route: string) => `${route}?workspaceId=${encodeURIComponent(workspaceId)}`;
    const listing = await result<CapabilityPackageStoreListResponse>(await admin.request.get(
      `${scoped('/api/capabilities/packages/store')}&kind=plugin&scope=user&audience=own&q=${encodeURIComponent(fixture.name)}`), 'Scoped Store metadata');
    expect(listing.selection.scope).toBe('user'); expect(listing.selection.audience).toBe('own');
    expect(listing.stores[0].offerings.find(item => item.entryKey === fixture.name)?.versions).toHaveLength(3);
    expect(listing.installed.resources.every(item => item.metadata.ownership.type === 'user' && item.metadata.ownership.ownerUserId === actorId)).toBe(true);
    const safe = JSON.stringify(listing);
    for (const field of ['storeOrigin', 'registryIdentity', 'downloadUrl', 'installDir', 'sourcePath']) expect(safe).not.toContain(`"${field}"`);
    expect((await admin.request.get(`${scoped('/api/capabilities/packages/store')}&scope=user&audience=shared&actorUserId=${memberId}`)).status()).toBe(400);
    expect((await admin.request.get(`${scoped('/api/capabilities/packages/store')}&scope=team&teamId=unavailable-store-fixture`)).status()).toBe(404);
    const preview = (await result<{ presentation: CapabilityPackagePresentation }>(await admin.request.post(scoped('/api/capabilities/packages/store/preview'),
      { data: { source: fixture.sources[0] } }), 'Verified complete Store preview')).presentation;
    expect(preview.name).toBe(fixture.name); expect(preview.version).toBe('1.0.0'); expect(preview.origin).toBe('store');
    expect(preview.source).toEqual(fixture.sources[0]); expect(preview.sourceStampCurrent).toBe(true);
    expect(preview.children.map(item => item.name)).toContain(`${fixture.name}-context`);
    const targets = await result<CapabilityPackageStoreInstallOptions>(await admin.request.post(scoped('/api/capabilities/packages/store/install-options'),
      { data: { source: fixture.sources[0], ownership: { type: 'organization' } } }), 'Fresh organization installation targets');
    expect(targets.ownership.type).toBe('organization'); expect(targets.targets.users.some(item => item.userId === memberId)).toBe(true);
    expect((await member.request.post(`/api/capabilities/packages/store/install-options?workspaceId=${encodeURIComponent(memberWorkspaceId)}`,
      { data: { source: fixture.sources[0], ownership: { type: 'organization' } } })).status()).toBe(403);
    expect((await admin.request.post(scoped('/api/capabilities/packages/store/install-options'),
      { data: { source: fixture.sources[0], ownership: { type: 'user', ownerUserId: memberId } } })).status()).toBe(400);
    const mobile = await result<CapabilityPackageStoreInstallOptions>(await admin.request.post(scoped('/api/mobile/v1/extensions/packages/store/install-options'),
      { data: { source: fixture.sources[0], ownership: { type: 'organization' } } }), 'Mobile installation target parity');
    expect(mobile).toEqual(targets);
  } finally { await Promise.all([admin.close(), member.close()]); }
});
