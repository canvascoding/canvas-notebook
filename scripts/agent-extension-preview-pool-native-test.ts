import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';

async function within<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The isolated ${label} did not complete within its bounded deadline.`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1');
  const poolArgument = process.argv.slice(2);
  assert(poolArgument.length === 1 && ['--pool=2', '--pool=10'].includes(poolArgument[0]));
  const poolMax = Number(poolArgument[0].slice('--pool='.length)) as 2 | 10;
  // Fail an exhausted test checkout instead of stranding fixture setup. This
  // process-only deadline is not a change to production database settings.
  process.env.CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS = '5000';
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: true, nativePoolMax: poolMax });
  const pending: Promise<unknown>[] = [];
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.push(operation); void operation.catch(() => undefined); return operation;
  };
  let observer: Pool | undefined, releaseFrame: (() => void) | undefined;
  try {
    assert.equal(fixture.native, true);
    const pool = fixture.database.getPostgresRuntimeQueryable() as Pool;
    assert(pool instanceof Pool); assert.equal(pool.options.max, poolMax);
    const connectionString = pool.options.connectionString;
    assert.equal(typeof connectionString, 'string');
    const ownDatabase = new URL(connectionString!).pathname.slice(1);
    assert.match(ownDatabase, /^canvas_connection_test_[a-f0-9]{32}$/u);
    observer = new Pool({ connectionString, max: 1, application_name: 'canvas_extension_pool_regression', connectionTimeoutMillis: 3000 });
    assert.equal((await observer.query('SELECT current_database() AS name')).rows[0].name, ownDatabase);
    const { owner } = fixture;
    const actor = { ...owner, source: 'api' as const };
    const storage = await import('../app/lib/agents/storage');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    await storage.writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, activeProvider: 'google',
      runtimeMigrations: { skillToolsDefaultEnabled: true }, providers: { ...DEFAULT_PI_CONFIG.providers,
        google: { ...DEFAULT_PI_CONFIG.providers.google, model: 'fixture-metadata-only-model', enabledTools: ['read', 'mcp'] } } });
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const { previewAgentExtensionConfiguration } = await import('../app/lib/agents/extension-options-preview');
    const { listManagedAgentExtensionOptions } = await import('../app/lib/agents/extension-options');
    const { resolveAgentExtensionOptionsContext } = await import('../app/lib/agents/extension-options-context');
    const { inspectManagedAgent } = await import('../app/lib/agents/management-actions');
    const name = `pool-regression-${randomUUID().slice(0, 8)}`;
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0',
        description: 'Checks exact source reads while competing catalogue requests wait.', skills: './skills' }),
      'skills/held-step/SKILL.md': '---\nname: held-step\ndescription: Read a source while another catalogue read is waiting\n---\n\nUse this exact published source.\n',
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, {
      source: { kind: 'plugin', registryId: 'store-application', entryKey: name, version: '1.0.0', checksum: archive.checksum },
      ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }],
    });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef,
      checksum: installed.published.checksum };
    const mcpConfig = await import('../app/lib/mcp/config');
    const mcpName = 'Exact own pool-regression MCP';
    await mcpConfig.writeMcpConfigRaw(JSON.stringify({ mcpServers: { [mcpName]: {
      url: 'https://pool-regression.fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true,
    } } }), { userId: owner.userId });
    const ownMcp = (await mcpConfig.readMcpConfig({ userId: owner.userId })).mcpServers[mcpName];
    assert(ownMcp.connectionId);
    const configuration: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed',
      selections: [{ selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'required', toolCap: null }],
      workflow: { version: 1, packages: [{ ...pin, skillSelection: { kind: 'plugin' }, declarations: [] }] },
      standalone: [{ mode: 'fixed', entry: { requirement: 'optional', toolCap: null, selection: { kind: 'mcp', source: 'mcp',
        target: { kind: 'personal', connectionRef: `mcp-personal:${ownMcp.connectionId}` } } } }] };
    const target = { kind: 'prospective' as const, scopeType: 'user' as const };
    const context = await resolveAgentExtensionOptionsContext(actor, target);
    const mainId = storage.DEFAULT_MANAGED_AGENT_ID;
    await inspectManagedAgent(actor, mainId, { includeFiles: true });
    await fixture.releaseSetupConnection();
    const { readAgentExtensionPackageVersion } = await import('../app/lib/agents/extension-package-options');
    const source = await readAgentExtensionPackageVersion(owner, pin, { allowPersonalPackages: true });
    assert(source.metadata.skillRoots.some(skill => skill.name === 'held-step'));

    let frameEntered!: () => void;
    const frameHeld = new Promise<void>(resolve => { frameEntered = resolve; });
    const resumeFrame = new Promise<void>(resolve => { releaseFrame = resolve; });
    let intercepted = false;
    fixture.setAfterRead(async query => {
      if (intercepted || query.replace(/\s+/gu, ' ').trim()
        !== 'SELECT organization_id FROM canvas_organization_settings ORDER BY created_at ASC LIMIT 1 FOR SHARE') return;
      // Package preflight takes a similar short lock. Saturate the pool only
      // after the real compilation transaction takes its own actor lock.
      if (!(new Error().stack ?? '').includes('compileProposedAgentExtensionOptionsPreview')) return;
      intercepted = true; frameEntered(); await resumeFrame;
    });
    const preview = track(previewAgentExtensionConfiguration(context, { operation: 'preview', target, configuration, enabledTools: ['read', 'mcp'] }));
    await within(frameHeld, 10_000, 'real Preview share-lock barrier');
    const searches = Array.from({ length: poolMax - 1 }, () => track(listManagedAgentExtensionOptions(actor, {
      operation: 'search', target, q: name, types: ['plugin', 'skill'], source: 'store',
    })));
    await within((async () => {
      for (;;) {
        const result = await observer!.query(`SELECT COUNT(*)::integer AS count FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE 'UPDATE canvas_organization_settings SET deployment_mode%'`);
        if (result.rows[0].count >= poolMax - 1) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })(), 10_000, 'actual competing SQL readers');
    const files = track(inspectManagedAgent(actor, mainId, { includeFiles: true }));
    fixture.setAfterRead(undefined); assert(releaseFrame); releaseFrame();
    const result = await within(preview, 10_000, 'Preview on its already held connection');
    assert.equal(result.preview.configurationReadiness, 'valid', JSON.stringify(result.preview));
    assert.equal(result.preview.contextValidation, 'complete');
    assert.equal(result.preview.providerHealth, 'unknown');
    assert.equal(result.preview.runtimeReadiness, 'not_checked');
    assert(!result.preview.issues.some(issue => issue.severity === 'error'));
    assert(result.preview.contextPreview?.includes('held-step'));
    for (const search of await within(Promise.all(searches), 15_000, 'competing catalogue reads')) {
      assert.equal(search.operation, 'search');
      if (search.operation !== 'search') throw new Error('The actual search must keep its operation.');
      assert(search.items.some(row => (row.item.kind === 'plugin' || row.item.kind === 'skill') && row.item.package?.resourceRef === pin.resourceRef));
    }
    assert((await within(files, 10_000, 'Agent files after Preview release')).files);
    assert.equal(pool.waitingCount, 0);
    assert.equal((await observer.query(`SELECT COUNT(*)::integer AS count FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'`)).rows[0].count, 0);

    await observer.query("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [owner.workspaceId]);
    await assert.rejects(previewAgentExtensionConfiguration(context, { operation: 'preview', target, configuration }),
      { code: 'AGENT_ACTOR_CONTEXT_DENIED', status: 403 },
      'An issued context cannot bypass the current workspace revocation.');
    await observer.query("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [owner.workspaceId]);
    await observer.query("UPDATE capability_resources SET status='archived',metadata_revision=metadata_revision+1 WHERE resource_ref=$1", [pin.resourceRef]);
    const revoked = await previewAgentExtensionConfiguration(context, { operation: 'preview', target, configuration });
    assert.equal(revoked.preview.configurationReadiness, 'blocked');
    assert(revoked.preview.issues.some(issue => issue.severity === 'error'));
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS native PostgreSQL pool=${poolMax}: actual held package/personal-MCP Preview, ${poolMax - 1} blocked catalogue reads, concurrent Agent files, fresh workspace/source revocation, zero leftover transactions or provider actions.`);
  } catch (error) {
    // Only this helper's nonce database is addressed. Interrupt owned failed
    // work so a regression cannot strand its pool and prevent safe teardown.
    if (observer) await observer.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()').catch(() => undefined);
    throw error;
  } finally {
    fixture.setAfterRead(undefined); releaseFrame?.();
    await Promise.allSettled(pending); await observer?.end(); await fixture.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
