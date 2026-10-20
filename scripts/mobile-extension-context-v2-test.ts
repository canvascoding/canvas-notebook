import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Actual Better Auth, scoped V2 routes, SQL/Store/Agent authority and CAS. No model or provider business call. */
async function main() {
  const maintenanceUrl = process.env.DATABASE_URL;
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const identity = await fixture.sql.get('SELECT current_database() AS name') as { name: string };
  try {
    const { NextRequest } = await import('next/server');
    const chat = await import('../app/api/mobile/v1/chat/extension-options/route');
    const options = await import('../app/api/mobile/v1/agents/extension-options/route');
    const images = await import('../app/api/mobile/v1/extensions/icon/route');
    const { projectMobileExtensionIcons } = await import('../app/lib/mobile/extension-icons-v2');
    const configuration = await import('../app/api/mobile/v1/agents/configuration/route');
    const history = await import('../app/api/mobile/v1/sessions/[sessionId]/messages/route');
    const management = await import('../app/lib/agents/management-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const fixed = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] };
    const legacy = { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' };
    const request = (user: string | null, route: string, body?: Record<string, unknown>, method = body ? 'POST' : 'GET') => {
      const headers = user ? fixture.headers(user) : new Headers({ 'content-type': 'application/json', 'x-canvas-workspace-id': 'personal-owner' });
      return new NextRequest(`http://localhost:3001/api/mobile/v1/${route}`, { method, headers,
        ...(body ? { body: JSON.stringify(body) } : {}) });
    };
    async function success<T>(response: Response, workspaceId = 'personal-owner'): Promise<T> {
      assert.equal(response.status, 200);
      const envelope = await response.json() as { success: boolean; contractVersion: number; workspaceId: string; checkedAt: number; data: T };
      assert.equal(envelope.success, true); assert.equal(envelope.contractVersion, 2); assert.equal(envelope.workspaceId, workspaceId);
      assert.equal(typeof envelope.checkedAt, 'number');
      assert.match(response.headers.get('cache-control') ?? '', /no-store/u); assert.match(response.headers.get('vary') ?? '', /Authorization/u);
      assert.doesNotMatch(JSON.stringify(envelope), /authSessionId|rootPath|runtimePath|accountSelectionRef|privateBinding|PRIVATE_CONTENT/u);
      return envelope.data;
    }
    async function denied(response: Response, statuses: number | number[]) {
      assert((Array.isArray(statuses) ? statuses : [statuses]).includes(response.status), `Unexpected denial ${response.status}`);
      const envelope = await response.json(); assert.equal(envelope.success, false); assert.equal(envelope.contractVersion, 2);
      assert.doesNotMatch(JSON.stringify(envelope), /PRIVATE_CONTENT|authSessionId|rootPath/u);
    }
    const created = await success<Awaited<ReturnType<typeof management.createManagedAgent>>>(await configuration.POST(request('owner', 'agents/configuration', {
      contractVersion: 2, name: `Mobile V2 ${randomUUID()}`, scopeType: 'user', enabledTools: ['read'], extensions: legacy,
      files: { 'AGENTS.md': 'A real initial agent source.' },
    })));
    assert.equal(created.extensions?.configuration?.mode, 'legacy_inherit');
    const id = created.agent.agentId;
    const read = await success<Awaited<ReturnType<typeof management.inspectManagedAgent>>>(await configuration.GET(request('owner',
      `agents/configuration?agentId=${id}&includeFiles=true&includeAccess=true`)));
    assert.equal(read.agent.agentId, id); assert.equal(read.extensions.configuration?.mode, 'legacy_inherit');
    assert(read.files && JSON.stringify(read.files).includes('A real initial agent source.'));
    const beforeAgents = (await fixture.sql.all('SELECT id FROM agents')).length;
    const beforeSessions = (await fixture.sql.all('SELECT id FROM pi_sessions')).length;
    const prospective = { kind: 'prospective', scopeType: 'user' };
    const preview = await success<{ operation: string; preview: { contextValidation: string } }>(await options.POST(request('owner', 'agents/extension-options', {
      contractVersion: 2, operation: 'preview', target: prospective, configuration: fixed, enabledTools: ['read'],
    })));
    assert.equal(preview.operation, 'preview');
    assert.equal((await fixture.sql.all('SELECT id FROM agents')).length, beforeAgents);
    assert.equal((await fixture.sql.all('SELECT id FROM pi_sessions')).length, beforeSessions);

    const name = `mobile-v2-${randomUUID().slice(0, 8)}`;
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', skills: './skills', description: 'Actual Mobile V2 metadata fixture',
        interface: { displayName: 'Mobile exact extension', logo: 'https://example.test/logo.svg?secret=discard' } }),
      'skills/native-step/SKILL.md': '---\nname: native-step\ndescription: Actual mobile metadata\n---\nRead source only when used.\n',
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(fixture.owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: 'owner', canUse: true, canEdit: false, canManage: false }] });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const target = { kind: 'draft_turn', agentId: id, workspaceId: 'personal-owner' };
    const detail = await success<{ operation: string; package: { pin: unknown; children: { name: string }[]; icon: { url: string } } }>(await chat.POST(request('owner', 'chat/extension-options', {
      contractVersion: 2, operation: 'package_version', target, ...pin,
    })));
    assert.equal(detail.operation, 'package_version'); assert.deepEqual(detail.package.pin, pin);
    assert.equal(detail.package.children[0]?.name, 'native-step'); assert.equal(detail.package.icon.url, 'https://example.test/logo.svg');
    const agentDetail = await success<{ package: { pin: unknown } }>(await options.POST(request('owner', 'agents/extension-options', {
      contractVersion: 2, operation: 'package_version', target: prospective, ...pin,
    })));
    assert.deepEqual(agentDetail.package.pin, pin);
    const localName = `${name}-local`, svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>';
    const localArchive = await fixture.registry.addPackage('application', 'plugin', localName, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: localName, version: '1.0.0', description: 'Actual declared passive image', skills: './skills',
        interface: { logo: './logo.svg' } }), 'logo.svg': svg,
      'skills/local-step/SKILL.md': '---\nname: local-step\ndescription: Actual child image\n---\nUse source when selected.\n',
      'skills/local-step/agents/canvas.yaml': 'interface:\n  icon_small: ./child.svg\n', 'skills/local-step/child.svg': svg,
    }, plugins.computeCanvasPluginChecksum);
    const local = await stores.installCapabilityPackageFromStoreAction(fixture.owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: localName, version: '1.0.0', checksum: localArchive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: 'owner', canUse: true, canEdit: false, canManage: false }] });
    const localPin = { resourceRef: local.resource.resourceRef, publishedRevisionRef: local.published.revisionRef, checksum: local.published.checksum };
    const localMetadata = await success<{ package: { icon: { url: string }; children: { icon?: { url: string } }[] } }>(await chat.POST(request('owner', 'chat/extension-options', {
      contractVersion: 2, operation: 'package_version', target, ...localPin,
    })));
    assert.match(localMetadata.package.icon.url, /^\/api\/mobile\/v1\/extensions\/icon\?kind=published|^\/api\/mobile\/v1\/extensions\/icon\?.*&kind=published/u);
    for (const icon of [localMetadata.package.icon, localMetadata.package.children[0]?.icon]) {
      assert(icon);
      const image = await images.GET(request('owner', icon.url.replace('/api/mobile/v1/', '')));
      assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/svg+xml'); assert.equal(await image.text(), svg);
      assert.equal(image.headers.get('location'), null); assert.match(image.headers.get('vary') ?? '', /Authorization/u);
    }
    const packages = await import('../app/lib/capabilities/packages/actions');
    const localInspected = await packages.inspectCapabilityPackage(fixture.owner, localPin.resourceRef);
    const installedIcon = projectMobileExtensionIcons({ url: `/api/capabilities/packages/${encodeURIComponent(localPin.resourceRef)}/icon?revision=${localInspected.sourceStamp.artifactRevision}&workspaceId=personal-owner`, sourceKey: 'actual-installed' }, 'personal-owner');
    const installedImage = await images.GET(request('owner', installedIcon.url.replace('/api/mobile/v1/', '')));
    assert.equal(installedImage.status, 200); assert.equal(await installedImage.text(), svg);
    await denied(await images.GET(request('bob', localMetadata.package.icon.url.replace('/api/mobile/v1/', ''))), [403, 404]);
    await denied(await images.GET(request('bob', 'extensions/icon?kind=mcp&selectionId=mcp-personal:11111111-1111-4111-8111-111111111111&binding=' + 'a'.repeat(64))), [403, 404]);
    const safeRemote = projectMobileExtensionIcons({ url: 'https://example.test/provider.svg?secret=discard#fragment', sourceKey: 'actual-provider' }, 'personal-owner');
    assert.deepEqual(safeRemote, { url: 'https://example.test/provider.svg', sourceKey: 'actual-provider' });
    for (const url of ['/api/unknown/image?x=1', '//example.test/image', '/api/plugins/mcp-icons/ref?binding=wrong&workspaceId=personal-alice']) {
      assert.equal(projectMobileExtensionIcons({ url, sourceKey: 'unknown' }, 'personal-owner'), undefined);
    }
    await denied(await chat.POST(request('alice', 'chat/extension-options', {
      contractVersion: 2, operation: 'package_version', target: { ...target, workspaceId: 'personal-alice' }, ...pin,
    })), [403, 404]);
    await denied(await options.POST(request('alice', 'agents/extension-options', {
      contractVersion: 2, operation: 'package_version', target: prospective, ...pin,
    })), [403, 404]);
    let revokedAfterSourceRead = false;
    fixture.setAfterRead(async query => {
      if (!/SELECT \* FROM capability_package_versions/u.test(query)) return;
      fixture.setAfterRead(undefined); revokedAfterSourceRead = true;
      await fixture.sql.run("UPDATE session SET expires_at=1 WHERE id='session-owner'");
    });
    try {
      await denied(await options.POST(request('owner', 'agents/extension-options', {
        contractVersion: 2, operation: 'package_version', target: prospective, ...pin,
      })), 401);
      assert.equal(revokedAfterSourceRead, true, 'The original auth session expired only after a real immutable source read.');
    } finally {
      fixture.setAfterRead(undefined);
      await fixture.sql.run("UPDATE session SET expires_at=$1 WHERE id='session-owner'", [Date.now() + 3_600_000]);
    }

    const changed = await success<{ agent: typeof read.agent; extensions: typeof read.extensions }>(await configuration.PATCH(request('owner', 'agents/configuration', {
      contractVersion: 2, agentId: id, expectedRevision: read.agent.revision, expectedWorkflowRevision: read.extensions.workflowRevision, extensions: fixed,
    }, 'PATCH')));
    assert.equal(changed.extensions.configuration?.mode, 'fixed');
    await denied(await configuration.PATCH(request('owner', 'agents/configuration', {
      contractVersion: 2, agentId: id, expectedRevision: read.agent.revision, expectedWorkflowRevision: read.extensions.workflowRevision, extensions: legacy,
    }, 'PATCH')), 409);
    const renamed = await success<{ agent: typeof read.agent; extensions: typeof read.extensions }>(await configuration.PATCH(request('owner', 'agents/configuration', {
      contractVersion: 2, agentId: id, expectedRevision: changed.agent.revision, name: 'Profile only keeps fixed empty',
    }, 'PATCH')));
    assert.deepEqual(renamed.extensions.configuration, changed.extensions.configuration, 'Omission preserves complete saved extension intent.');
    await denied(await configuration.PATCH(request('owner', 'agents/configuration', {
      contractVersion: 2, agentId: id, expectedRevision: renamed.agent.revision, extensions: legacy,
    }, 'PATCH')), 400);
    await denied(await configuration.PATCH(request('owner', 'agents/configuration', {
      contractVersion: 2, agentId: id, expectedRevision: renamed.agent.revision,
    }, 'PATCH')), 400);

    const shared = await management.createManagedAgent({ ...fixture.owner, source: 'api' }, { name: `Use-only ${randomUUID()}`, scopeType: 'organization',
      enabledTools: ['read'], extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' },
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
    const turnId = `mobile-turn-${randomUUID()}`;
    await fixture.sql.run(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,created_at,updated_at)
      VALUES($1,'alice',$2,'fixture','fixture',$3,'personal-alice','personal',1,1)`, [turnId, shared.agent.agentId, fixture.organizationId]);
    const turnTarget = { kind: 'turn', sessionId: turnId, expectedAgentId: shared.agent.agentId, expectedWorkspaceId: 'personal-alice' };
    const historyBody = { version: 1, parts: [{ type: 'text', text: 'Use ' }, { type: 'extension_reference', occurrenceId: 'saved-node', bundleId: 'saved-plugin' }],
      bundles: [{ id: 'saved-plugin', caption: 'Saved extension', primary: { selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } },
        requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] }] };
    const userRecord = { role: 'user', content: [{ type: 'text', text: 'Use Saved extension' }], body: historyBody,
      clientMessageId: 'saved-native-message', extensionSelection: { accountSelectionRef: 'PRIVATE_RECEIPT' }, privateBinding: 'PRIVATE_BINDING' };
    const persisted = [userRecord, { ...userRecord, role: 'assistant' }, { ...userRecord, content: 'Other text' }, { role: 'user', content: 'Legacy history' }];
    for (const [index, message] of persisted.entries()) await fixture.sql.run(`INSERT INTO pi_messages(pi_session_db_id,role,content,timestamp,sequence)
      SELECT id,$2,$3,1,$4 FROM pi_sessions WHERE session_id=$1`, [turnId, message.role, JSON.stringify(message), index + 1]);
    const historyResponse = await history.GET(request('alice', `sessions/${turnId}/messages`), { params: Promise.resolve({ sessionId: turnId }) });
    assert.equal(historyResponse.status, 200);
    const saved = await historyResponse.json() as { success: boolean; messages: { body?: unknown; text: string }[] };
    assert.equal(saved.success, true); assert.equal(saved.messages.length, 4); assert.deepEqual(saved.messages[0]?.body, historyBody);
    assert(saved.messages.slice(1).every(message => message.body === undefined)); assert.equal(saved.messages[3]?.text, 'Legacy history');
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_|accountSelectionRef|privateBinding/u);
    const foreignHistory = await history.GET(request('owner', `sessions/${turnId}/messages`), { params: Promise.resolve({ sessionId: turnId }) });
    assert.equal(foreignHistory.status, 404);
    const recents = await success<{ operation: string; finalSendValidationRequired: boolean }>(await chat.POST(request('alice', 'chat/extension-options', {
      contractVersion: 2, operation: 'recents', target: turnTarget,
    })), 'personal-alice');
    assert.equal(recents.operation, 'recents'); assert.equal(recents.finalSendValidationRequired, true);
    await denied(await chat.POST(request('alice', 'chat/extension-options', {
      contractVersion: 2, operation: 'recents', target: { ...turnTarget, expectedAgentId: id },
    })), 503); // Shared originating-Session lookup deliberately exposes no typed/private mismatch details.
    await denied(await chat.POST(request('owner', 'chat/extension-options', {
      contractVersion: 2, operation: 'recents', target: { ...turnTarget, expectedWorkspaceId: 'personal-owner' },
    })), 503);
    await denied(await configuration.GET(request('alice', `agents/configuration?agentId=${shared.agent.agentId}`)), 403);
    await denied(await options.POST(request('alice', 'agents/extension-options', { contractVersion: 2, operation: 'preview',
      target: { kind: 'existing', agentId: shared.agent.agentId, expectedRevision: shared.agent.revision, expectedWorkflowRevision: shared.agent.workflowRevision },
    })), 403);
    await fixture.sql.run("UPDATE agent_grants SET can_use=0 WHERE agent_id=$1 AND target_type='user' AND target_id='alice'", [shared.agent.agentId]);
    await denied(await chat.POST(request('alice', 'chat/extension-options', { contractVersion: 2, operation: 'recents', target: turnTarget })), 503);

    await denied(await chat.POST(request(null, 'chat/extension-options', { contractVersion: 2, operation: 'recents', target })), 401);
    const noWorkspace = request('bob', 'chat/extension-options', { contractVersion: 2, operation: 'recents', target });
    noWorkspace.headers.delete('x-canvas-workspace-id'); await denied(await chat.POST(noWorkspace), 400);
    await denied(await chat.POST(request('bob', 'chat/extension-options', { contractVersion: 1, operation: 'recents', target })), 400);
    await denied(await chat.POST(request('bob', 'chat/extension-options?workspaceId=personal-owner', { contractVersion: 2, operation: 'recents', target })), 400);
    await denied(await chat.POST(request('bob', 'chat/extension-options?actorUserId=owner', { contractVersion: 2, operation: 'recents', target })), 400);
    await denied(await chat.POST(request('bob', 'chat/extension-options', { contractVersion: 2, operation: 'recents', target, actorUserId: 'owner' })), 400);
    const browser = request('bob', 'chat/extension-options', { contractVersion: 2, operation: 'recents', target });
    browser.headers.set('Sec-Fetch-Mode', 'cors'); await denied(await chat.POST(browser), 403);
    await denied(await options.POST(request('bob', 'agents/extension-options', {
      contractVersion: 2, operation: 'search', target: prospective, q: 'x'.repeat(1_048_577),
    })), 413);
    const counts = await fixture.sql.get('SELECT COUNT(*)::int AS count FROM pi_message_delivery_receipts') as { count: number };
    assert.equal(Number(counts.count), 0); assert.equal(fixture.providerRequests(), 0);
    console.info(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} Mobile V2 extension APIs: actual scoped Chat/Agent options, immutable package/child/logo and passive icon bytes, create/read/atomic CAS, omitted preservation, Use/Edit separation, Session/Agent/workspace mismatch/revoke, original-session revocation after real source read, strict envelope/origin/size; no receipts or provider calls.`);
  } finally {
    await fixture.close();
    await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
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
