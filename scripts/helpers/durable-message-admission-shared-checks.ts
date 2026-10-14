import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../../app/lib/db';
import type { AgentExecutionContext } from '../../app/lib/pi/agent-execution-context';
import type { AgentWorkflowRuntimeProjection } from '../../app/lib/agents/workflow-runtime';
import type { AcceptedTurnExtensionSelection } from '../../app/lib/capabilities/extensions/accepted-turn-selection';
import type { AuthorizedAgentWorkflowPackageSelections } from '../../app/lib/capabilities/packages/runtime-bindings';
import type { ChatMessageAdmissionInput } from '../../app/lib/pi/durable-message-admission';
import { standaloneExtensionInputSchema, type AgentExtensionConfigurationInput, type ExtensionSelectionEntry,
  type ExtensionPackagePin, type StandaloneExtensionInput } from '../../app/lib/capabilities/extensions/contracts';
import type { IntegrationConnectionRecord } from '../../app/lib/integration-tools/connections/contracts';
import type { createCapabilityPackageStoreApplicationFixture } from './capability-package-store-application-fixture';

type Fixture = Awaited<ReturnType<typeof createCapabilityPackageStoreApplicationFixture>>;
type Admission = typeof import('../../app/lib/pi/durable-message-admission');

async function within<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** All refs/pins come from actual Store and connection services. Only SQL
 * scheduling is controlled; no source/actor verdict or writer is substituted. */
export async function exerciseDurableAdmissionSharedSources(fixture: Fixture, options: {
  service: Admission;
  input: (id: string, extras?: Partial<ChatMessageAdmissionInput>) => ChatMessageAdmissionInput;
  packagePin: ExtensionPackagePin;
  packageResourceId: string;
  personalAccountInput: ChatMessageAdmissionInput;
  writerConcurrency: boolean;
}): Promise<void> {
  const { service, input, packagePin, packageResourceId } = options;
  const { owner, organizationId } = fixture, actor = { ...owner, source: 'api' as const };
  const sourceActor = { ...owner, organizationId };
  const sql = async <T>(callback: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await fixture.database.openDb();
    try { return await callback(database); } finally { await database.close(); }
  };
  const management = await import('../../app/lib/agents/management-actions');
  const workflows = await import('../../app/lib/agents/workflow-configuration');
  const mcp = await import('../../app/lib/mcp/shared-connections');
  const connections = await import('../../app/lib/integration-tools/connections/store');
  const profiles = await import('../../app/lib/composio/composio-shared-profiles');
  const personalProfiles = await import('../../app/lib/composio/composio-profiles');
  const { replaceScopedEnvEntries } = await import('../../app/lib/integrations/env-config');
  await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: `fixture-${randomBytes(24).toString('hex')}` }],
    { secretScope: 'organization', organizationId });
  const ownership = { type: 'organization' as const, organizationId };
  const grants = [{ targetType: 'user' as const, targetId: owner.userId, canUse: true, canManage: false, allowedToolNames: null }];
  const mcps: IntegrationConnectionRecord[] = [];
  const sharedProfiles: Awaited<ReturnType<typeof profiles.createSharedComposioProfile>>[] = [];
  for (const index of [1, 2]) {
    mcps.push(await mcp.createSharedMcpConnection(sourceActor, {
      ownership, displayName: `Durable shared MCP ${index}`, accessMode: 'restricted', grants, allowedToolNames: ['read_fixture'],
      config: { url: `https://shared-${index}.durable-admission.fixture.invalid/mcp`, transport: 'http', auth: 'none', enabled: true },
    }));
    sharedProfiles.push(await profiles.createSharedComposioProfile({ actor: sourceActor,
      ownership, name: `Durable shared Composio ${index}`, providerMode: 'local' }));
  }
  // These are genuine server-side setup IDs, persisted by the real creation
  // service. Bracket the generated MCP refs so lexical order necessarily mixes
  // provider kinds, rather than accidentally matching a source-kind sort.
  const setupRefs = [`canvas-connection:00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`,
    `canvas-connection:ffffffff-ffff-4fff-bfff-${randomBytes(6).toString('hex')}`];
  assert(mcps.every(value => setupRefs[0] < value.resource.connectionRef && value.resource.connectionRef < setupRefs[1]));
  const composios: IntegrationConnectionRecord[] = [];
  for (const [index, profile] of sharedProfiles.entries()) composios.push(await connections.createSharedIntegrationConnection(sourceActor, {
    ownership, connectionRef: setupRefs[index], displayName: `Durable shared public search ${index}`, accessMode: 'restricted',
    grants, allowedToolNames: ['PUBLIC_FIND'], backend: { source: 'composio', profileId: profile.id, toolkit: 'duckduckgo',
      mode: 'local', accountBinding: 'no_auth', connectedAccountId: null },
  }));
  const ordered = [...mcps, ...composios].sort((left, right) => left.resource.connectionRef.localeCompare(right.resource.connectionRef));
  const sharedEntry = (source: IntegrationConnectionRecord): StandaloneExtensionInput => ({
    selection: source.backend.source === 'mcp'
      ? { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: source.resource.connectionRef, bindingRevision: source.resource.bindingRevision } }
      : { kind: 'composio', source: 'composio', toolkit: source.backend.toolkit,
        target: { kind: 'shared', connectionRef: source.resource.connectionRef, bindingRevision: source.resource.bindingRevision } },
    requirement: 'optional', toolCap: null,
  });
  const plugin: ExtensionSelectionEntry = { selection: { kind: 'plugin', package: packagePin, skillSelection: { kind: 'all' } },
    requirement: 'optional', toolCap: null };
  const mixedInput = (id: string, reversed: boolean) => input(id, { selection: { version: 1, origin: 'turn_reference',
    selections: [plugin, ...(reversed ? [...ordered].reverse() : ordered).map(sharedEntry)] } });
  // Keep the real eight-KiB/query-reserve boundary. Four source routes plus this
  // exact plugin pin do not fit; that must not be disguised as an admission.
  await assert.rejects(service.prepareChatMessageAdmission(mixedInput('mixed-over-budget', false)), error => {
    assert.equal(Reflect.get(error as object, 'code'), 'AGENT_EXTENSION_CONTEXT_TOO_LARGE');
    assert(Number(Reflect.get(error as object, 'requiredBytes')) > 8 * 1024);
    return true;
  });
  const sessionInput = input('mixed-source-context');
  const storedSession = await sql(database => database.get('SELECT agent_id FROM pi_sessions WHERE user_id=$1 AND session_id=$2',
    [sessionInput.userId, sessionInput.sessionId])) as { agent_id: string };
  const { resolveAgentExecutionContextForStoredSession } = await import('../../app/lib/pi/session-workspace-context');
  const genuineContext = await resolveAgentExecutionContextForStoredSession({ userId: sessionInput.userId,
    sessionId: sessionInput.sessionId, agentId: storedSession.agent_id });
  const acceptedSources = await import('../../app/lib/capabilities/extensions/accepted-turn-selection');
  const runtime = await import('../../app/lib/agents/workflow-runtime');
  const packageRuntime = await import('../../app/lib/capabilities/packages/runtime-bindings');
  const turnRuntime = await import('../../app/lib/capabilities/extensions/turn-runtime');
  const effectiveRuntime = await import('../../app/lib/capabilities/extensions/effective-context');
  const sourceRefs = ordered.map(source => source.resource.connectionRef);
  const sourceAttempts = new AsyncLocalStorage<string[]>();
  fixture.setAfterRead(async (query, params) => {
    if (query.includes('FROM integration_connection_resources') && query.includes('FOR UPDATE') && sourceRefs.includes(String(params[0]))) {
      sourceAttempts.getStore()?.push(String(params[0]));
    }
  });
  const accepted: { context: AgentExecutionContext; runtimeContext: AgentExecutionContext;
    handle: AcceptedTurnExtensionSelection; packages: AuthorizedAgentWorkflowPackageSelections;
    projection: AgentWorkflowRuntimeProjection | null }[] = [];
  for (const reversed of [false, true]) {
    const selection = { version: 1 as const, origin: 'turn_reference' as const,
      selections: (reversed ? [...ordered].reverse() : ordered).map(sharedEntry) };
    const context = { ...genuineContext, agentTurnId: randomUUID(), turnExtensions: selection };
    const handle = await acceptedSources.prepareAcceptedTurnExtensionSelection(context, selection);
    const packages = await packageRuntime.getAuthorizedAgentWorkflowPackageSelections(context);
    const runtimeContext = { ...context, turnExtensionSource: await turnRuntime.reissueAcceptedTurnRuntimeSelection(
      context, handle, context, { packageSelection: packages }) };
    const effective = await effectiveRuntime.resolveEffectiveExtensionContext(runtimeContext, { packageSelection: packages });
    const presentation = effectiveRuntime.readEffectiveExtensionContext(effective);
    assert(presentation);
    accepted.push({ context, runtimeContext, packages, handle, projection: presentation.workflowProjection });
  }
  const sourceBefore = await sql(database => database.all('SELECT connection_ref,binding_revision FROM integration_connection_resources ORDER BY connection_ref'));
  const guard = async (value: (typeof accepted)[number]) => {
    const observed: string[] = [];
    await sourceAttempts.run(observed, () => sql(async database => {
      await database.run('BEGIN');
      try {
        await runtime.withRevalidatedAgentWorkflowProjectionSourcesOnConnection(database, value.runtimeContext, value.projection,
          { additionalSharedRefs: sourceRefs }, () => acceptedSources.withRevalidatedAcceptedTurnExtensionSelectionOnConnection(
            database, value.context, value.handle, selection => packageRuntime.withRevalidatedAgentWorkflowPackageSelectionOnConnection(
              database, value.runtimeContext, value.packages, async () => {
                assert.equal(selection.privateFixedBindings.length, 4);
                assert.deepEqual([...new Set(observed)], sourceRefs,
                  'Actual mixed shared FOR UPDATE reads must precede the accepted-source callback in global lexical order.');
              })));
        await database.run('COMMIT');
      } catch (error) { await database.run('ROLLBACK'); throw error; }
    }));
  };
  try {
    if (fixture.native) await within(Promise.all(accepted.map(guard)), 'opposite mixed-provider actual SQL source guards');
    else for (const value of accepted) await guard(value);
  } finally { fixture.setAfterRead(undefined); }
  assert.deepEqual(await sql(database => database.all('SELECT connection_ref,binding_revision FROM integration_connection_resources ORDER BY connection_ref')), sourceBefore);
  // The full admission/public-writer contention retains both actual source
  // kinds and the exact plugin, within the unchanged mandatory context budget.
  const durableOrdered = [mcps[0], composios[1]].sort((left, right) => left.resource.connectionRef.localeCompare(right.resource.connectionRef));
  assert(durableOrdered[0].backend.source === 'mcp' && durableOrdered[1].backend.source === 'composio',
    'The durable fixture must differ from a Composio-before-MCP source-kind order.');
  const durableInput = (id: string) => input(id, { selection: { version: 1, origin: 'turn_reference',
    selections: [plugin, ...[...durableOrdered].reverse().map(sharedEntry)] } });
  const prepare = async (value: ChatMessageAdmissionInput) => {
    const result = await service.prepareChatMessageAdmission(value);
    assert.equal(result.kind, 'prepared');
    if (result.kind !== 'prepared') throw new Error('Expected an actual new admission.');
    return result.admission;
  };
  await service.commitPreparedChatMessageAdmission(await prepare(durableInput('mixed-durable')));
  const configuration: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed',
    selections: [plugin], workflow: { version: 1, packages: [{ ...packagePin, skillSelection: { kind: 'plugin' }, declarations: [] }] },
    standalone: [...durableOrdered].reverse().map(source => ({ mode: 'fixed', entry: sharedEntry(source) })),
  };
  const created = await management.createManagedAgent(actor, { name: `Durable fixed sources ${randomUUID()}`, scopeType: 'user',
    enabledTools: ['read', 'mcp'], extensions: configuration });
  const fixedSessionId = `durable-fixed-${randomUUID()}`;
  await sql(database => database.run(`INSERT INTO pi_sessions
    (session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,created_at,updated_at)
    VALUES ($1,$2,$3,'fixture','fixture',$4,$5,'personal',1,1)`,
  [fixedSessionId, owner.userId, created.agent.agentId, organizationId, owner.workspaceId]));
  const fixedInput = (id: string) => ({ ...input(id), sessionId: fixedSessionId, expectedAgentId: created.agent.agentId });
  const fixedRows = (id: string) => sql(database => database.all(`SELECT r.client_message_id FROM pi_message_delivery_receipts r
    JOIN pi_sessions s ON s.id=r.pi_session_db_id WHERE s.session_id=$1 AND r.client_message_id=$2`, [fixedSessionId, id]));
  await service.commitPreparedChatMessageAdmission(await prepare(fixedInput('fixed-no-turn')));
  const fixedComposio = await prepare(fixedInput('fixed-composio-drift'));
  await assert.rejects(profiles.mutateSharedComposioProfile({ actor: sourceActor, profileId: sharedProfiles[1].id,
    expectedProfileRevision: sharedProfiles[1].profileRevision, status: 'archived' }), error => {
    assert.equal(Reflect.get(error as object, 'code'), 'profile_in_use'); return true;
  });
  await profiles.mutateSharedComposioProfile({ actor: sourceActor, profileId: sharedProfiles[1].id,
    expectedProfileRevision: sharedProfiles[1].profileRevision, name: 'Changed real shared profile' });
  try {
    await assert.rejects(service.commitPreparedChatMessageAdmission(fixedComposio), error => {
      assert.equal(Reflect.get(error as object, 'code'), 'provider_denied'); return true;
    });
    assert.deepEqual(await fixedRows('fixed-composio-drift'), []);
  } finally {
    await profiles.mutateSharedComposioProfile({ actor: sourceActor, profileId: sharedProfiles[1].id,
      expectedProfileRevision: sharedProfiles[1].profileRevision + 1, name: sharedProfiles[1].name });
  }
  // A personal fixed account is also a real selected source when this turn has
  // no explicit extension selection. Archive through its actual owner service.
  const personalInputSelection = options.personalAccountInput.selection as import('../../app/lib/capabilities/extensions/contracts').ChatExtensionSelectionInput;
  const personalAccount = standaloneExtensionInputSchema.parse(personalInputSelection.selections[0]);
  assert(personalAccount.selection.kind === 'composio' && personalAccount.selection.target.kind === 'personal');
  const personalConfig: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null,
    standalone: [{ mode: 'fixed', entry: personalAccount }] };
  const personalAgent = await management.createManagedAgent(actor, { name: `Durable fixed account ${randomUUID()}`, scopeType: 'user',
    enabledTools: ['mcp'], extensions: personalConfig });
  const personalSessionId = `durable-fixed-personal-${randomUUID()}`;
  await sql(database => database.run(`INSERT INTO pi_sessions
    (session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,created_at,updated_at)
    VALUES ($1,$2,$3,'fixture','fixture',$4,$5,'personal',1,1)`,
  [personalSessionId, owner.userId, personalAgent.agent.agentId, organizationId, owner.workspaceId]));
  const personal = await prepare({ ...input('fixed-personal-drift'), sessionId: personalSessionId, expectedAgentId: personalAgent.agent.agentId });
  await personalProfiles.archiveComposioProfile({ ownerUserId: owner.userId, profileId: personalAccount.selection.target.profileId });
  await assert.rejects(service.commitPreparedChatMessageAdmission(personal), error => {
    assert.equal(Reflect.get(error as object, 'code'), 'provider_denied'); return true;
  });
  assert.deepEqual(await sql(database => database.all(`SELECT r.client_message_id FROM pi_message_delivery_receipts r
    JOIN pi_sessions s ON s.id=r.pi_session_db_id WHERE s.session_id=$1 AND r.client_message_id='fixed-personal-drift'`, [personalSessionId])), []);

  if (options.writerConcurrency) {
    assert(fixture.native, 'Actual public writer contention requires PostgreSQL.');
    const admission = await prepare(durableInput('writer-contention'));
    const references = durableOrdered.map(source => source.resource.connectionRef);
    const observedShared: string[] = [];
    let writerEntered!: () => void, releaseWriter!: () => void, packageEntered!: () => void, releaseAdmission!: () => void;
    const writerHeld = new Promise<void>(resolve => { writerEntered = resolve; });
    const writerResume = new Promise<void>(resolve => { releaseWriter = resolve; });
    const packageHeld = new Promise<void>(resolve => { packageEntered = resolve; });
    const admissionResume = new Promise<void>(resolve => { releaseAdmission = resolve; });
    let writerTransaction = false, admissionStarted = false, packageSeen = false;
    fixture.setAfterQuery(async query => {
      if (writerTransaction || query.trim() !== 'BEGIN') return;
      const caller = new Error().stack?.split('\n').find(line => line.includes('/app/'));
      if (!caller?.includes('updateManagedAgentConfiguration')) return;
      writerTransaction = true; writerEntered(); await writerResume;
    });
    fixture.setAfterRead(async (query, params) => {
      if (!admissionStarted) return;
      if (query.includes('FROM integration_connection_resources') && query.includes('FOR UPDATE') && references.includes(String(params[0]))) {
        observedShared.push(String(params[0]));
      }
      if (packageSeen || !query.includes('pg_advisory_xact_lock') || params[0] !== `capability-resource:${packageResourceId}`) return;
      packageSeen = true; packageEntered(); await admissionResume;
    });
    const writer = workflows.updateManagedAgentConfiguration({ actor, agentId: created.agent.agentId,
      expectedRevision: created.agent.revision, expectedWorkflowRevision: created.agent.workflowRevision!,
      name: 'Actual concurrent writer completed', extensions: configuration });
    void writer.catch(() => {});
    let committing: Promise<unknown> | undefined;
    try {
      await within(writerHeld, 'actual public Agent writer BEGIN after metadata preparation');
      admissionStarted = true;
      committing = service.commitPreparedChatMessageAdmission(admission); void committing.catch(() => {});
      await within(packageHeld, 'the actual admission package advisory lock');
      assert.deepEqual([...new Set(observedShared)], references, 'Every mixed shared source must be held globally in lexical ref order before Package.');
      fixture.setAfterQuery(undefined); releaseWriter();
      await within((async () => {
        for (;;) {
          const waiters = await sql(database => database.get(`SELECT COUNT(*)::integer AS count FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
              AND query LIKE '%FROM integration_connection_resources%FOR UPDATE%'`)) as { count: number };
          if (waiters.count > 0) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })(), 'the actual writer transaction waiting on the shared connection lock');
      fixture.setAfterRead(undefined); releaseAdmission();
      const [written] = await within(Promise.all([writer, committing]), 'the contending actual public writer and admission to complete');
      assert.equal(written.agent.revision, created.agent.revision + 1);
      const accepted = await service.readOwnedAcceptedChatMessage({ userId: input('writer-contention').userId,
        sessionId: input('writer-contention').sessionId, clientMessageId: 'writer-contention' });
      assert(accepted);
    } finally {
      fixture.setAfterQuery(undefined); fixture.setAfterRead(undefined); releaseWriter(); releaseAdmission();
      await within(Promise.allSettled([writer, ...(committing ? [committing] : [])]), 'owned contention operations to settle before fixture cleanup');
    }
  }
  await sql(database => database.run('DELETE FROM pi_sessions WHERE session_id=ANY($1)', [[fixedSessionId, personalSessionId]]));
  console.log(`PASS durable shared-source checks: actual 2MCP+2Composio opposite-order SQL source guards; actual four-provider+Plugin eight-KiB rejection; actual 1MCP+1Composio+exact Plugin durable admission; fixed selection:null shared Composio rename/personal archive denied; active shared-profile archive blocked by owner service${options.writerConcurrency ? '; real public Agent writer BEGIN/shared-lock wait/package contention' : ''}; no business calls.`);
}
