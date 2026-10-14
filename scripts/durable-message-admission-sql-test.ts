import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Module from 'node:module';
import type { SqlConnection } from '../app/lib/db';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { ChatMessageAdmissionInput, OwnedAcceptedChatMessage } from '../app/lib/pi/durable-message-admission';
import type { ChatExtensionSelectionInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import { exerciseDurableAdmissionSharedSources } from './helpers/durable-message-admission-shared-checks';

async function within<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Actual SQL, published sources, actor/session checks and service/registrations.
 * Only model-catalogue metadata is controlled; source services always delegate
 * to their actual implementation. Replay traps fail closed, never issue proofs.
 */
async function main(): Promise<void> {
  const native = process.argv.includes('--native');
  const writerConcurrency = process.argv.includes('--native-writer-concurrency');
  assert(!writerConcurrency || native, 'The separate writer-contention mode requires --native.');
  const originalFetch = globalThis.fetch, originalDateNow = Date.now;
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native, ...(native ? { nativePoolMax: writerConcurrency ? 10 : 2 } : {}) });
  let composio: Awaited<ReturnType<typeof createComposioProviderFixture>> | undefined;
  const composioEnvironment = ['COMPOSIO_API_KEY', 'COMPOSIO_BASE_URL', 'COMPOSIO_LOGGING_LEVEL'] as const;
  const previousEnvironment = new Map(composioEnvironment.map(key => [key, process.env[key]]));
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const previousLoad = loader._load;
  let forbidSourcePreparation = false, sourcePreparations = 0;
  const sourceWrappers = new Map<string, unknown>();
  loader._load = (name, parent, isMain) => {
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') {
      return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => {}, isContextOverflow: () => false };
    }
    const accepted = /(?:extensions\/accepted-turn-selection|^\.\/accepted-turn-selection)(?:\.ts)?$/u.test(name);
    const packages = /packages\/runtime-bindings(?:\.ts)?$/u.test(name);
    if (accepted || packages) {
      if (!sourceWrappers.has(name)) {
        const actual = previousLoad(name, parent, isMain) as Record<string, unknown>;
        const method = accepted ? 'prepareAcceptedTurnExtensionSelection' : 'getAuthorizedAgentWorkflowPackageSelections';
        sourceWrappers.set(name, new Proxy(actual, { get(target, property, receiver) {
          if (property !== method) return Reflect.get(target, property, receiver);
          return (...args: unknown[]) => {
            sourcePreparations++;
            if (forbidSourcePreparation) throw new Error('Replay must not prepare sources or renew account receipts.');
            return (target[method] as (...values: unknown[]) => unknown)(...args);
          };
        } }));
      }
      return sourceWrappers.get(name);
    }
    return previousLoad(name, parent, isMain);
  };
  let stage = 'fixture services';
  const sql = async <T>(callback: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await fixture.database.openDb();
    try { return await callback(database); } finally { await database.close(); }
  };
  const code = (expected: string) => (error: unknown) => {
    assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, expected);
    return true;
  };
  try {
    const service = await import('../app/lib/pi/durable-message-admission');
    const { parseStoredAcceptedChatMessage } = await import('../app/lib/chat/durable-message-contracts');
    const management = await import('../app/lib/agents/management-actions');
    const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const personalActivation = await import('../app/lib/capabilities/activation-actions');
    const mcp = await import('../app/lib/mcp/config');
    const { owner, organizationId } = fixture;
    await management.inspectManagedAgent({ ...owner, source: 'api' }, MAIN_AGENT_ID);
    const sessionId = `durable-admission-${randomUUID()}`;
    await fixture.sql.run(`INSERT INTO pi_sessions
      (session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,created_at,updated_at)
      VALUES ($1,$2,$3,'fixture','fixture',$4,$5,'personal',1,1)`,
    [sessionId, owner.userId, MAIN_AGENT_ID, organizationId, owner.workspaceId]);
    const sessionDbId = (await fixture.sql.get('SELECT id FROM pi_sessions WHERE session_id=$1', [sessionId]) as { id: number }).id;
    const identity = { userId: owner.userId, sessionId, expectedAgentId: MAIN_AGENT_ID, expectedWorkspaceId: owner.workspaceId! };
    // Pool2 is the entire application budget, including genuine Store/activation
    // operations. A retained fixture lease must not consume half of that budget.
    await fixture.releaseSetupConnection();
    const name = `durable-source-${randomUUID().slice(0, 8)}`;
    const files = {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', skills: './skills', description: 'Actual admission package' }),
      'skills/exact-step/SKILL.md': '---\nname: exact-step\ndescription: Read the exact admitted source\n---\n\nUse the held package version.\n',
    };
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', files, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, {
      source: { kind: 'plugin', registryId: 'store-application', entryKey: name, version: '1.0.0', checksum: archive.checksum },
      ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }],
    });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef,
      checksum: installed.published.checksum };
    const descriptor = await packages.inspectCapabilityPackage(owner, pin.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(owner, pin.resourceRef, {
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state!.packageRevision, expectedPublishedRevisionRef: pin.publishedRevisionRef,
      expectedDefaultEnabled: false, enabled: true,
    });
    await personalActivation.setPersonalCapabilityActivation({ context: { userId: owner.userId, organizationId,
      workspaceId: owner.workspaceId, role: 'owner' }, actorUserId: owner.userId,
    resourceId: descriptor.sourceStamp.resourceId, enabled: true });
    const mcpName = 'Exact durable personal MCP';
    await mcp.writeMcpConfigRaw(JSON.stringify({ mcpServers: { [mcpName]: {
      url: 'https://durable-admission.fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true,
    } } }), { userId: owner.userId });
    const connectionId = (await mcp.readMcpConfig({ userId: owner.userId })).mcpServers[mcpName]?.connectionId;
    assert(connectionId);
    const selection: ChatExtensionSelectionInput = { version: 1, origin: 'turn_reference', selections: [
      { selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null },
      { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${connectionId}` } },
        requirement: 'optional', toolCap: null },
    ] };
    const actualContext = await sessions.resolveAgentExecutionContextForStoredSession({ userId: owner.userId, sessionId, agentId: MAIN_AGENT_ID });
    assert(actualContext);
    const input = (clientMessageId: string, extras: Partial<ChatMessageAdmissionInput> = {}): ChatMessageAdmissionInput => ({
      ...identity, clientMessageId, message: { role: 'user', content: 'Keep this exact message.', timestamp: 100 },
      context: { workspace: { workspaceId: owner.workspaceId!, workspaceType: actualContext.workspaceType,
        workspaceName: actualContext.workspaceName ?? 'Owner', organizationId,
        canWrite: actualContext.canWrite, canDelete: actualContext.canDelete, canShare: actualContext.canShare } },
      mode: 'message', ...extras,
    });
    const row = (clientMessageId: string) => sql(database => database.get(`SELECT * FROM pi_message_delivery_receipts
      WHERE pi_session_db_id=$1 AND client_message_id=$2`, [sessionDbId, clientMessageId])) as Promise<Record<string, unknown> | undefined>;
    const data = async (handle: OwnedAcceptedChatMessage, clientMessageId: string) => {
      const stored = await row(clientMessageId); assert(stored && typeof stored.private_payload === 'string');
      const payload = parseStoredAcceptedChatMessage(JSON.parse(stored.private_payload));
      // The existing genuine session frame is sufficient for private metadata.
      // Resolving a new runtime here would itself prepare sources and obscure
      // whether the replay reader stayed entirely outside that operational path.
      const context: AgentExecutionContext = { ...actualContext, agentTurnId: payload.serverMessageId };
      return { result: service.readOwnedAcceptedChatMessageData(handle, context), context, stored };
    };
    const prepare = async (value: ChatMessageAdmissionInput) => {
      const result = await service.prepareChatMessageAdmission(value);
      assert.equal(result.kind, 'prepared');
      if (result.kind !== 'prepared') throw new Error('Expected a new real preparation.');
      return result.admission;
    };

    stage = 'actual empty admission and SQL replay';
    assert.equal(await service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'not-admitted' }), null);
    const simpleInput = input('simple');
    const simplePreparation = await prepare(simpleInput);
    assert.equal(await row('simple'), undefined, 'Preparation is not durable acceptance.');
    const owned = await service.commitPreparedChatMessageAdmission(simplePreparation);
    const accepted = await data(owned, 'simple');
    assert.deepEqual(accepted.result.payload.message, simpleInput.message);
    assert.equal(accepted.result.phase, 'queued'); assert.equal(accepted.result.executionRevision, 1);
    assert.equal(accepted.result.payload.extensionSelection, null);
    assert.equal(accepted.result.payload.identity.agentId, MAIN_AGENT_ID);
    assert(Object.isFrozen(accepted.result.payload));
    assert.equal((await sql(database => database.all('SELECT id FROM pi_messages WHERE pi_session_db_id=$1', [sessionDbId]))).length, 0,
      'Admission stores the receipt/payload, without pretending a runtime transcript or business execution.');
    const read = await service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'simple' }); assert(read);
    assert.equal((await data(read, 'simple')).result.payload.serverMessageId, accepted.result.payload.serverMessageId);
    for (const forged of [{ kind: 'owned_accepted_chat_message' }, { ...owned }, structuredClone(owned)]) {
      assert.throws(() => service.readOwnedAcceptedChatMessageData(forged as OwnedAcceptedChatMessage, accepted.context), code('AGENT_EXTENSION_CONTEXT_DENIED'));
    }
    assert.throws(() => service.readOwnedAcceptedChatMessageData(owned, { ...accepted.context, agentTurnId: randomUUID() }), code('AGENT_EXTENSION_CONTEXT_DENIED'));
    assert.throws(() => service.readOwnedAcceptedChatMessageData(owned, { ...accepted.context, userId: 'alice' }), code('AGENT_EXTENSION_CONTEXT_DENIED'));
    await assert.rejects(service.commitPreparedChatMessageAdmission({ ...simplePreparation }), code('AGENT_EXTENSION_CONTEXT_DENIED'));

    stage = 'actual published plugin and personal MCP roundtrip';
    const selectedInput = input('actual-sources', { selection });
    const selected = await service.commitPreparedChatMessageAdmission(await prepare(selectedInput));
    const selectedData = (await data(selected, 'actual-sources')).result;
    assert.deepEqual(selectedData.payload.extensionSelection?.publicSelection, selection);
    assert.equal(selectedData.payload.extensionSelection?.privateFixedBindings.length, 1);
    const fixed = selectedData.payload.extensionSelection!.privateFixedBindings[0];
    assert.equal(fixed.entry.target.kind, 'personal');
    if (fixed.entry.target.kind !== 'personal' || fixed.entry.target.personalBinding.source !== 'mcp') throw new Error('Missing actual personal MCP binding.');
    assert.equal(fixed.entry.target.personalBinding.connectionId, connectionId);
    assert.equal(fixed.entry.target.ownerUserId, owner.userId);
    assert.doesNotMatch(JSON.stringify(selectedData.payload), /accountSelectionRef/u);

    stage = 'same intent replays before source preparation';
    const beforeReplay = sourcePreparations;
    forbidSourcePreparation = true;
    try {
      const replay = await service.prepareChatMessageAdmission({ ...selectedInput, message: { ...selectedInput.message, timestamp: 999 } });
      assert.equal(replay.kind, 'replay');
      if (replay.kind !== 'replay') throw new Error('Accepted intent must replay.');
      assert.equal((await data(replay.message, 'actual-sources')).result.payload.serverMessageId, selectedData.payload.serverMessageId);
      assert.equal(sourcePreparations, beforeReplay);
      for (const changed of [
        { message: { ...selectedInput.message, content: 'Changed text' } }, { mode: 'steer' as const },
        { selection: { ...selection, selections: [{ ...selection.selections[0], selection: { kind: 'plugin' as const,
          package: { ...pin, checksum: 'f'.repeat(64) }, skillSelection: { kind: 'all' as const } } }] } },
        { selection: { ...selection, selections: [{ selection: { kind: 'mcp' as const, source: 'mcp' as const,
          target: { kind: 'personal' as const, connectionRef: `mcp-personal:${randomUUID()}` } }, requirement: 'optional' as const, toolCap: null }] } },
      ]) await assert.rejects(service.prepareChatMessageAdmission({ ...selectedInput, ...changed }), code('MESSAGE_ID_CONFLICT'));
      assert.equal(sourcePreparations, beforeReplay);
    } finally { forbidSourcePreparation = false; }

    stage = 'actual Composio account receipt, expiry and replay';
    composio = await createComposioProviderFixture();
    const fixtureFetch = globalThis.fetch, composioOrigin = composio.baseUrl;
    // Real SDK metadata is permitted only at this fixture's exact loopback
    // origin. Background SDK version checks and every other origin fail closed.
    globalThis.fetch = async (request, options) => {
      const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
      if (url.origin === composioOrigin) {
        const method = (options?.method ?? (request instanceof Request ? request.method : 'GET')).toUpperCase();
        assert.equal(method, 'GET');
        assert(['/api/v3.1/toolkits', '/api/v3.1/connected_accounts'].includes(url.pathname), 'Only actual toolkit/account metadata is allowed.');
        return originalFetch(request, { ...options, redirect: 'error' });
      }
      if (url.origin === fixture.registry.baseUrl) return fixtureFetch(request, options);
      throw new Error('No external network or provider business request is allowed.');
    };
    process.env.COMPOSIO_API_KEY = ''; process.env.COMPOSIO_BASE_URL = composioOrigin; process.env.COMPOSIO_LOGGING_LEVEL = 'silent';
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: `fixture-${randomBytes(24).toString('hex')}` }],
      { secretScope: 'user', userId: owner.userId });
    const profiles = await import('../app/lib/composio/composio-profiles');
    const { createIntegrationProviderRef } = await import('../app/lib/integration-tools/references');
    const { listPersonalWorkflowProviderAccountChoices } = await import('../app/lib/integration-tools/workflow-personal-bindings');
    const { readPersonalComposioAccountReference } = await import('../app/lib/composio/composio-shared-account-reference');
    await profiles.ensureDefaultComposioProfile(owner.userId);
    const profile = await profiles.createComposioProfile({ ownerUserId: owner.userId, name: 'Durable explicit account' });
    composio.accounts.set(profile.composioUserId, [
      { id: 'durable-account-a', toolkit: 'canva', status: 'ACTIVE' }, { id: 'durable-account-b', toolkit: 'canva', status: 'ACTIVE' },
    ]);
    const providerRef = createIntegrationProviderRef({ source: 'composio', profileId: profile.id, toolkit: 'canva',
      scope: { type: 'user', ownerUserId: owner.userId, resourceId: `profile:${profile.id}:canva` } });
    const choices = await listPersonalWorkflowProviderAccountChoices({ actor: owner, providerRef, exactToolkit: { profileId: profile.id, toolkit: 'canva' } });
    assert.equal(choices.accounts.length, 2);
    const choice = choices.accounts[1];
    const account = readPersonalComposioAccountReference(choice.accountSelectionRef);
    const accountInput = input('actual-account', { selection: { version: 1, origin: 'turn_reference', selections: [{
      selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: profile.id,
        accountBinding: 'account', accountId: account.accountId, connectionRef: `composio-personal:${profile.id}:${account.accountId}` } },
      requirement: 'optional', toolCap: null, accountSelectionRef: choice.accountSelectionRef,
    }] } });
    const admittedAccount = await service.commitPreparedChatMessageAdmission(await prepare(accountInput));
    const accountData = (await data(admittedAccount, 'actual-account')).result.payload;
    const accountTarget = accountData.extensionSelection!.privateFixedBindings[0].entry.target;
    assert(accountTarget.kind === 'personal' && accountTarget.personalBinding.source === 'composio');
    assert.equal(accountTarget.personalBinding.connectedAccountId, account.accountId);
    assert.doesNotMatch(JSON.stringify(accountData), /accountSelectionRef|cmp_personal_account_/u);
    const callsBeforeReplay = composio.calls.length, preparationsBeforeExpiry = sourcePreparations;
    Date.now = () => originalDateNow() + 6 * 60_000;
    forbidSourcePreparation = true;
    try {
      assert.throws(() => readPersonalComposioAccountReference(choice.accountSelectionRef), code('binding_changed'));
      const replay = await service.prepareChatMessageAdmission(accountInput);
      assert.equal(replay.kind, 'replay');
      if (replay.kind !== 'replay') throw new Error('Expired intake receipts must not prevent an already accepted replay.');
      assert.equal((await data(replay.message, 'actual-account')).result.payload.serverMessageId, accountData.serverMessageId);
      assert.equal(sourcePreparations, preparationsBeforeExpiry);
      assert.equal(composio.calls.length, callsBeforeReplay, 'Replay must not renew receipt or query a provider.');
      const changedAccount = structuredClone(accountInput);
      const changedSelection = (changedAccount.selection as ChatExtensionSelectionInput).selections[0].selection;
      assert(changedSelection.kind === 'composio' && changedSelection.target.kind === 'personal'
        && changedSelection.target.accountBinding === 'account');
      changedSelection.target.accountId = 'durable-account-a';
      changedSelection.target.connectionRef = `composio-personal:${profile.id}:durable-account-a`;
      await assert.rejects(service.prepareChatMessageAdmission(changedAccount), code('MESSAGE_ID_CONFLICT'));
      assert.equal(sourcePreparations, preparationsBeforeExpiry);
    } finally { Date.now = originalDateNow; forbidSourcePreparation = false; }
    assert(composio.calls.every(call => ['/api/v3.1/toolkits', '/api/v3.1/connected_accounts'].includes(call.path)), 'Actual SDK never executes tools.');

    stage = 'actual insert failure rolls back acceptance';
    const rollback = await prepare(input('rollback'));
    await sql(database => database.run(`CREATE FUNCTION fail_durable_admission() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.client_message_id='rollback' THEN RAISE EXCEPTION 'forced durable insert rollback'; END IF; RETURN NEW; END $$`));
    await sql(database => database.run(`CREATE TRIGGER fail_durable_admission AFTER INSERT ON pi_message_delivery_receipts
      FOR EACH ROW EXECUTE FUNCTION fail_durable_admission()`));
    try { await assert.rejects(service.commitPreparedChatMessageAdmission(rollback), /forced durable insert rollback/u); }
    finally {
      await sql(database => database.run('DROP TRIGGER fail_durable_admission ON pi_message_delivery_receipts'));
      await sql(database => database.run('DROP FUNCTION fail_durable_admission()'));
    }
    assert.equal(await row('rollback'), undefined);
    assert.equal((await data(await service.commitPreparedChatMessageAdmission(rollback), 'rollback')).result.phase, 'queued');

    stage = 'prepared request remains exact and late source/actor changes reject commit';
    const mutable = input('captured-before-await');
    let captureReached!: () => void, resumeCapture!: () => void;
    const captureHeld = new Promise<void>(resolve => { captureReached = resolve; });
    const captureResume = new Promise<void>(resolve => { resumeCapture = resolve; });
    let held = false;
    fixture.setBeforeRead(async query => {
      if (!held && query.includes('FROM pi_sessions') && query.includes('archived_at IS NULL')) {
        held = true; captureReached(); await captureResume;
      }
    });
    const capturing = prepare(mutable);
    // Observe a premature preparation failure immediately; the awaited original
    // still reports it after the barrier has been safely released.
    void capturing.catch(() => {});
    try {
      await within(captureHeld, 'the actual initial session SQL read');
      mutable.message.content = 'A later edit must not replace the captured content.';
    } finally { fixture.setBeforeRead(undefined); resumeCapture(); }
    const captured = await service.commitPreparedChatMessageAdmission(await capturing);
    assert.equal((await data(captured, 'captured-before-await')).result.payload.message.content, simpleInput.message.content);
    const revokedSource = await prepare(input('late-source', { selection }));
    const originalMcp = await mcp.readMcpConfig({ userId: owner.userId });
    try {
      const changedMcp = structuredClone(originalMcp);
      changedMcp.mcpServers[mcpName].url = 'https://changed-durable.fixture.invalid/mcp';
      await mcp.writeMcpConfigRaw(JSON.stringify(changedMcp), { userId: owner.userId });
      await assert.rejects(service.commitPreparedChatMessageAdmission(revokedSource));
      assert.equal(await row('late-source'), undefined);
    } finally { await mcp.writeMcpConfigRaw(JSON.stringify(originalMcp), { userId: owner.userId }); }
    const revokedActor = await prepare(input('late-actor'));
    await sql(database => database.run("UPDATE organization_user_permissions SET status='removed' WHERE user_id=$1 AND organization_id=$2", [owner.userId, organizationId]));
    try {
      await assert.rejects(service.commitPreparedChatMessageAdmission(revokedActor));
      assert.equal(await row('late-actor'), undefined);
    } finally { await sql(database => database.run("UPDATE organization_user_permissions SET status='active' WHERE user_id=$1 AND organization_id=$2", [owner.userId, organizationId])); }

    stage = 'actual actor, session, workspace and archive fences';
    for (const foreign of [{ userId: 'alice' }, { sessionId: 'not-this-session' }, { expectedAgentId: 'not-this-agent' },
      { expectedWorkspaceId: 'personal-alice' }]) {
      await assert.rejects(service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'simple', ...foreign }), code('AGENT_EXTENSION_CONTEXT_DENIED'));
    }
    await assert.rejects(prepare(input('foreign-context', { context: { workspace: { workspaceId: 'personal-alice', workspaceType: 'personal', workspaceName: 'Alice',
      canWrite: false, canDelete: false, canShare: false } } })),
      code('AGENT_EXTENSION_CONTEXT_DENIED'));
    await sql(database => database.run('UPDATE pi_sessions SET archived_at=1 WHERE id=$1', [sessionDbId]));
    try { await assert.rejects(service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'simple' }), code('AGENT_EXTENSION_CONTEXT_DENIED')); }
    finally { await sql(database => database.run('UPDATE pi_sessions SET archived_at=NULL WHERE id=$1', [sessionDbId])); }
    await sql(database => database.run("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [owner.workspaceId]));
    try { await assert.rejects(service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'simple' })); }
    finally { await sql(database => database.run("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [owner.workspaceId])); }
    await sql(database => database.run("UPDATE organization_user_permissions SET status='removed' WHERE user_id=$1 AND organization_id=$2", [owner.userId, organizationId]));
    try { await assert.rejects(service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'simple' })); }
    finally { await sql(database => database.run("UPDATE organization_user_permissions SET status='active' WHERE user_id=$1 AND organization_id=$2", [owner.userId, organizationId])); }

    stage = 'private hash and identity corruption reject';
    const original = await row('simple'); assert(original);
    await sql(database => database.run("UPDATE pi_message_delivery_receipts SET payload_hash='corrupt' WHERE pi_session_db_id=$1 AND client_message_id='simple'", [sessionDbId]));
    await assert.rejects(service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'simple' }), code('AGENT_MESSAGE_ADMISSION_CORRUPT'));
    await sql(database => database.run(`UPDATE pi_message_delivery_receipts SET payload_hash=$1,
      private_payload=jsonb_set(private_payload::jsonb,'{identity,userId}','"alice"')::text
      WHERE pi_session_db_id=$2 AND client_message_id='simple'`, [original.payload_hash, sessionDbId]));
    await assert.rejects(service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'simple' }), code('AGENT_EXTENSION_CONTEXT_DENIED'));
    await sql(database => database.run("UPDATE pi_message_delivery_receipts SET private_payload=$1 WHERE pi_session_db_id=$2 AND client_message_id='simple'", [original.private_payload, sessionDbId]));
    await sql(database => database.run(`INSERT INTO pi_message_delivery_receipts
      (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,created_at,updated_at)
      VALUES ($1,'legacy','legacy-hash','legacy-runtime','accepted',1,1)`, [sessionDbId]));
    await assert.rejects(service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'legacy' }), code('MESSAGE_DELIVERY_UNCERTAIN'));
    await assert.rejects(service.prepareChatMessageAdmission(input('legacy')), code('MESSAGE_DELIVERY_UNCERTAIN'));

    stage = 'actual mixed shared sources and fixed-source drift';
    await exerciseDurableAdmissionSharedSources(fixture, { service, input, packagePin: pin,
      packageResourceId: descriptor.sourceStamp.resourceId, personalAccountInput: accountInput, writerConcurrency });

    if (native && !writerConcurrency) {
      stage = 'failed rollback discards the actual native lease';
      const rollbackDiscard = await prepare(input('rollback-discard'));
      const originalOpen = fixture.database.openDb;
      const insertFault = new Error('forced response loss after actual admission INSERT');
      const rollbackFault = new Error('forced ROLLBACK transport failure');
      let faultLeaseIssued = false, insertedBeforeFault = false, rollbackFailed = false;
      let discardedPid = 0, queriesAfterRollbackFailure = 0, releaseError: Error | undefined;
      fixture.database.openDb = async () => {
        const actual = await originalOpen();
        if (faultLeaseIssued) return actual;
        faultLeaseIssued = true;
        discardedPid = Number((await actual.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
        return { ...actual,
          get: async (query, params = []) => {
            if (rollbackFailed) queriesAfterRollbackFailure++;
            const result = await actual.get(query, params);
            if (query.includes('INSERT INTO pi_message_delivery_receipts') && params.includes('rollback-discard')) {
              insertedBeforeFault = true; throw insertFault;
            }
            return result;
          },
          all: async (query, params = []) => {
            if (rollbackFailed) queriesAfterRollbackFailure++;
            return actual.all(query, params);
          },
          run: async (query, params = []) => {
            if (query.trim() === 'ROLLBACK' && insertedBeforeFault) { rollbackFailed = true; throw rollbackFault; }
            if (rollbackFailed) queriesAfterRollbackFailure++;
            return actual.run(query, params);
          },
          close: error => { releaseError = error; return actual.close(error); },
        };
      };
      const preparationsBeforeDiscard = sourcePreparations;
      try { await assert.rejects(service.commitPreparedChatMessageAdmission(rollbackDiscard), error => error === insertFault); }
      finally { fixture.database.openDb = originalOpen; }
      assert(insertedBeforeFault && rollbackFailed, 'The INSERT really ran, but no ROLLBACK reached PostgreSQL.');
      assert.equal(releaseError, rollbackFault, 'The actual native adapter must receive release(error), not pool reuse.');
      assert.equal(queriesAfterRollbackFailure, 0, 'An uncertain rollback must never attempt SQL replay on that lease.');
      assert.equal(sourcePreparations, preparationsBeforeDiscard, 'The failure path does not prepare or dispatch again.');
      assert(discardedPid > 0);
      await sql(async database => {
        const fresh = await database.get('SELECT pg_backend_pid() AS pid,txid_current_if_assigned()::text AS tx') as { pid: number; tx: string | null };
        assert.notEqual(fresh.pid, discardedPid);
        assert.equal(fresh.tx, null, 'The next real checkout has no leftover transaction.');
      });
      await within((async () => {
        for (;;) {
          const alive = await sql(database => database.get('SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE pid=$1', [discardedPid])) as { count: number };
          if (alive.count === 0) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })(), 'the failed native backend to close and roll back');
      assert.equal(await row('rollback-discard'), undefined, 'Server rollback on connection discard removed the uncommitted row.');

      stage = 'actual two-connection concurrent identical writers';
      const raceInput = input('race');
      const first = await prepare(raceInput), second = await prepare(raceInput);
      const committed = await Promise.all([service.commitPreparedChatMessageAdmission(first), service.commitPreparedChatMessageAdmission(second)]);
      const ids = await Promise.all(committed.map(value => data(value, 'race').then(value => value.result.payload.serverMessageId)));
      assert.equal(ids[0], ids[1]);
      assert.equal((await sql(database => database.all("SELECT client_message_id FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1 AND client_message_id='race'", [sessionDbId]))).length, 1);
    }
    stage = 'repeated startup and actual session cascade';
    await runPostgresMigrations(fixture.database.getPostgresRuntimeQueryable() as unknown as Parameters<typeof runPostgresMigrations>[0]);
    assert.equal((await data((await service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'simple' }))!, 'simple')).result.payload.serverMessageId,
      accepted.result.payload.serverMessageId);
    await sql(database => database.run('DELETE FROM pi_sessions WHERE id=$1', [sessionDbId]));
    assert.equal((await sql(database => database.all('SELECT client_message_id FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1', [sessionDbId]))).length, 0);
    assert.equal(fixture.providerRequests(), 0, 'No HTTP beyond the explicitly owned registry and account-metadata transports is admitted.');
    console.log(`PASS durable message admission SQL (${native ? `native PostgreSQL pool${writerConcurrency ? 10 : 2}` : 'PGlite'}): actual published plugin+personal MCP+Composio account receipt, prepare/commit/read, expired-receipt replay/conflicts, rollback, captured intent, late source/actor revoke, provenance/corruption, legacy uncertainty, startup/cascade${native && !writerConcurrency ? ', discarded failed rollback, concurrent writers' : ''}; no runtime/business execution.`);
  } catch (error) { console.error(`Durable admission SQL stage: ${stage}`); throw error; }
  finally {
    Date.now = originalDateNow; fixture.setBeforeRead(undefined); loader._load = previousLoad;
    try { await composio?.close(); }
    finally {
      try { await fixture.close(); }
      finally { for (const [key, value] of previousEnvironment) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
