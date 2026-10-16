import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import type { CapabilityPackageDraft, CapabilityPackageOwnedDraftList, CapabilityPackageOwnedDraftStatus } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityPackageDraftPresentation } from '../app/lib/capabilities/packages/draft-presentation-contracts';

/** Real Better Auth and mobile facades over actual SQL/draft files; no service or provider mocks. */
async function main() {
  const maintenanceUrl = process.env.DATABASE_URL;
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const identity = await fixture.sql.get('SELECT current_database() AS name') as { name: string };
  try {
    const { NextRequest } = await import('next/server');
    const creator = await import('../app/api/mobile/v1/extensions/packages/creator/route');
    const drafts = await import('../app/api/mobile/v1/extensions/packages/drafts/route');
    const status = await import('../app/api/mobile/v1/extensions/packages/drafts/[draftRef]/status/route');
    const presentation = await import('../app/api/mobile/v1/extensions/packages/drafts/[draftRef]/presentation/route');
    const image = await import('../app/api/mobile/v1/extensions/packages/drafts/[draftRef]/image/route');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const { creatorPluginManifestTemplate } = await import('../app/lib/plugins/creator-plugin-manifest');
    const { capabilityPackageCreatorOptionsSchema, capabilityPackageCreatorChatSchema } = await import('../app/lib/capabilities/packages/creator-chat-contracts');
    const { deriveChatBodySelection, projectChatBodyText } = await import('../app/lib/chat/chat-body-contracts');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { writePiRuntimeConfig } = await import('../app/lib/agents/storage');
    await writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, runtimeMigrations: { skillToolsDefaultEnabled: true } });

    const base = 'extensions/packages';
    const request = (user: string | null, path: string, body?: Record<string, unknown>) => new NextRequest(`http://localhost:3001/api/mobile/v1/${base}/${path}`, {
      method: body ? 'POST' : 'GET', headers: user ? fixture.headers(user) : new Headers({ 'content-type': 'application/json', 'x-canvas-workspace-id': 'personal-owner' }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const context = (draftRef: string) => ({ params: Promise.resolve({ draftRef }) });
    function headers(response: Response) {
      assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.equal(response.headers.get('vary'), 'Authorization, Cookie, X-Canvas-Workspace-Id');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    async function success<T>(response: Response, workspaceId = 'personal-owner'): Promise<T> {
      assert.equal(response.status, 200, await response.clone().text()); headers(response);
      const value = await response.json() as { success: boolean; contractVersion: number; workspaceId: string; checkedAt: number; data: T };
      assert.equal(value.success, true); assert.equal(value.contractVersion, 2); assert.equal(value.workspaceId, workspaceId); assert.equal(typeof value.checkedAt, 'number');
      assert.doesNotMatch(JSON.stringify(value), /authSessionId|rootPath|runtimePath|privateBinding|storeOrigin/u); assert(!JSON.stringify(value).includes(fixture.root));
      return value.data;
    }
    async function denied(response: Response, expected: number) {
      assert.equal(response.status, expected, await response.clone().text()); headers(response);
      const value = await response.json(); assert.equal(value.success, false); assert.equal(value.contractVersion, 2);
      assert.doesNotMatch(JSON.stringify(value), /authSessionId|rootPath|runtimePath|privateBinding/u); assert(!JSON.stringify(value).includes(fixture.root));
    }
    const count = async (table: string) => Number((await fixture.sql.get(`SELECT COUNT(*)::integer AS count FROM ${table}`) as { count: number }).count);
    const state = async () => Promise.all(['pi_sessions', 'pi_messages', 'pi_message_delivery_receipts', 'capability_resources', 'capability_package_versions', 'capability_package_states'].map(count));
    const before = await state(), beforeDrafts = await count('capability_package_drafts');
    const options = capabilityPackageCreatorOptionsSchema.parse(await success(await creator.GET(request('owner', 'creator'))));
    assert.equal(options.workspaceId, 'personal-owner'); assert.equal(options.canCreate, true); assert(options.creators.every(item => item.available));
    assert.equal(options.ownership?.organizationId, fixture.organizationId);
    for (const kind of ['plugin', 'skill'] as const) {
      const body = capabilityPackageCreatorChatSchema.parse(await success(await creator.POST(request('owner', 'creator', { contractVersion: 2, operation: 'create', kind, locale: 'de' }))));
      assert.equal(body.kind, kind); assert.equal(body.workspaceId, 'personal-owner'); assert.equal(body.mode, 'compose'); assert.equal(body.draftRef, undefined);
      assert.equal(body.prompt, projectChatBodyText(body.body));
      const selection = deriveChatBodySelection(body.body)?.selections[0]?.selection;
      assert.equal(selection?.kind, kind === 'plugin' ? 'core_plugin' : 'core_skill'); assert(selection && 'coreSource' in selection); assert.equal('package' in selection, false);
    }
    assert.equal(await count('capability_package_drafts'), beforeDrafts, 'Preparing a Creator body does not create a draft.');
    assert.deepEqual(await state(), before, 'Preparing a Creator body does not create a Session, message, receipt or publication.');
    const memberOptions = capabilityPackageCreatorOptionsSchema.parse(await success(await creator.GET(request('alice', 'creator')), 'personal-alice'));
    assert.equal(memberOptions.canCreate, false);
    await denied(await creator.POST(request('alice', 'creator', { contractVersion: 2, operation: 'create', kind: 'plugin' })), 403);
    await denied(await creator.POST(request('owner', 'creator', { contractVersion: 1, operation: 'create', kind: 'plugin' })), 400);
    await denied(await creator.POST(request('owner', 'creator', { contractVersion: 2, operation: 'create', kind: 'plugin', actorUserId: 'owner' })), 400);
    await denied(await creator.GET(request(null, 'creator')), 401);
    const missingWorkspace = request('owner', 'creator'); missingWorkspace.headers.delete('x-canvas-workspace-id');
    await denied(await creator.GET(missingWorkspace), 400);
    const foreignWorkspace = request('owner', 'creator'); foreignWorkspace.headers.set('x-canvas-workspace-id', 'personal-alice');
    await denied(await creator.GET(foreignWorkspace), 404);
    await denied(await creator.GET(request('owner', 'creator?workspaceId=personal-alice')), 400);

    let draft = await packages.createCapabilityPackageDraftAction(fixture.owner, { operation: 'create', kind: 'plugin', targetName: 'mobile-creator-draft', requestId: randomUUID() });
    const write = async (path: string, content: string) => { draft = (await packages.writeCapabilityPackageDraftFileAction(fixture.owner, draft.draftRef,
      { expectedDraftRevision: draft.draftRevision, path, encoding: 'base64', content: Buffer.from(content).toString('base64') })).draft; };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Mobile Creator</title><desc>Draft review</desc><rect width="32" height="32" fill="#17614b"/></svg>';
    await write('.canvas-plugin/plugin.json', JSON.stringify({ ...structuredClone(creatorPluginManifestTemplate), name: draft.name,
      interface: { displayName: 'Native Draft Review', logo: './assets/logo.svg' } }));
    await write('skills/native-review/SKILL.md', '---\nname: native-review\ndescription: Review a native private draft\nmetadata:\n  version: "1.0.0"\n---\nKeep the review explicit.\n');
    await write('assets/logo.svg', svg);
    const path = (value: CapabilityPackageDraft, suffix: string, revision = value.draftRevision) => `drafts/${encodeURIComponent(value.draftRef)}/${suffix}?expectedDraftRevision=${revision}`;
    const listing = await success<CapabilityPackageOwnedDraftList>(await drafts.GET(request('owner', 'drafts?limit=1')));
    assert.equal(listing.drafts.length, 1); assert.equal(listing.drafts[0]?.draftRef, draft.draftRef); assert.equal(listing.nextCursor, null);
    const recovery = await success<{status: CapabilityPackageOwnedDraftStatus}>(await status.GET(request('owner', `drafts/${encodeURIComponent(draft.draftRef)}/status`), context(draft.draftRef)));
    assert.equal(recovery.status.draftRevision, draft.draftRevision); assert.equal(recovery.status.operation, 'create');
    const preview = await success<CapabilityPackageDraftPresentation>(await presentation.GET(request('owner', path(draft, 'presentation')), context(draft.draftRef)));
    assert.equal(preview.origin, 'draft'); assert.equal(preview.draftRef, draft.draftRef); assert.equal(preview.draftRevision, draft.draftRevision);
    assert.equal(preview.title, 'Native Draft Review'); assert.equal(preview.previewIncomplete, false); assert.equal(preview.imageAvailable, true);
    assert.deepEqual(preview.skills.map(skill => skill.name), ['native-review']);
    for (const field of ['resourceRef', 'publishedRevisionRef', 'sourceStampCurrent', 'canUse', 'runtimeReadiness']) assert.equal(Object.hasOwn(preview, field), false);
    const imageResponse = await image.GET(request('owner', path(draft, 'image')), context(draft.draftRef));
    assert.equal(imageResponse.status, 200, await imageResponse.clone().text()); headers(imageResponse);
    assert.equal(imageResponse.headers.get('content-type'), 'image/svg+xml'); assert.equal(imageResponse.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(imageResponse.headers.get('location'), null); assert.equal(await imageResponse.text(), svg);
    const resumed = capabilityPackageCreatorChatSchema.parse(await success(await creator.POST(request('owner', 'creator', { contractVersion: 2, operation: 'resume', draftRef: draft.draftRef }))));
    assert.equal(resumed.draftRef, draft.draftRef); assert(resumed.prompt.includes(draft.draftRef));
    await denied(await presentation.GET(request('owner', path(draft, 'presentation', draft.draftRevision - 1)), context(draft.draftRef)), 409);
    await denied(await image.GET(request('owner', path(draft, 'image', draft.draftRevision - 1)), context(draft.draftRef)), 409);
    await denied(await image.GET(request('owner', `drafts/${encodeURIComponent(draft.draftRef)}/image`), context(draft.draftRef)), 400);
    await denied(await drafts.GET(request('owner', 'drafts?limit=0')), 400);
    await denied(await presentation.GET(request('owner', `${path(draft, 'presentation')}&expectedDraftRevision=${draft.draftRevision}`), context(draft.draftRef)), 400);
    assert.deepEqual((await success<CapabilityPackageOwnedDraftList>(await drafts.GET(request('alice', 'drafts')), 'personal-alice')).drafts, []);
    await denied(await status.GET(request('alice', `drafts/${encodeURIComponent(draft.draftRef)}/status`), context(draft.draftRef)), 404);
    await denied(await presentation.GET(request('alice', path(draft, 'presentation')), context(draft.draftRef)), 404);
    await denied(await image.GET(request('alice', path(draft, 'image')), context(draft.draftRef)), 404);
    const wrongImageWorkspace = request('owner', path(draft, 'image')); wrongImageWorkspace.headers.set('x-canvas-workspace-id', 'personal-alice');
    await denied(await image.GET(wrongImageWorkspace, context(draft.draftRef)), 404);
    for (const read of [() => presentation.GET(request('owner', path(draft, 'presentation')), context(draft.draftRef)),
      () => image.GET(request('owner', path(draft, 'image')), context(draft.draftRef))]) {
      let expiredAfterRealDraftRead = false;
      fixture.setAfterRead(async query => {
        if (!/FROM capability_package_drafts WHERE draft_ref=\$1 AND actor_user_id=\$2 FOR SHARE/u.test(query)) return;
        fixture.setAfterRead(undefined); expiredAfterRealDraftRead = true;
        await fixture.sql.run("UPDATE session SET expires_at=1 WHERE id='session-owner'");
      });
      try { await denied(await read(), 401); assert.equal(expiredAfterRealDraftRead, true, 'The original session expired after the actual held draft generation was read.'); }
      finally { fixture.setAfterRead(undefined); await fixture.sql.run("UPDATE session SET expires_at=$1 WHERE id='session-owner'", [Date.now() + 3_600_000]); }
    }
    assert.deepEqual(await state(), before); assert.equal(await count('capability_package_drafts'), beforeDrafts + 1);
    assert.equal(fixture.providerRequests(), 0);
    console.info(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} Mobile Creator/Draft facades: actual Better Auth/current workspace, fresh Core plugin/skill bodies, private list/status/resume/presentation/passive image, revision/header/context denials and original-session expiry after real source read; no providers, Sessions, messages or publication.`);
  } finally {
    await fixture.close(); await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
    if (fixture.native) {
      assert.match(identity.name, /^canvas_connection_test_[a-f0-9]{32}$/u);
      const maintenance = new URL(maintenanceUrl ?? ''); assert.equal(maintenance.hostname, '127.0.0.1'); assert.equal(maintenance.port, '55433');
      const observer = new Pool({ connectionString: maintenance.toString(), max: 1 });
      try { assert.equal((await observer.query('SELECT datname FROM pg_database WHERE datname=$1', [identity.name])).rowCount, 0); }
      finally { await observer.end(); }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
