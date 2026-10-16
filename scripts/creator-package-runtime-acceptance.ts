import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { SqlConnection } from '../app/lib/db';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { IntegrationGatewayAgentTool } from '../app/lib/pi/integration-tool-gateway';
import type { IntegrationRequest, IntegrationProviderPage, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';

const DOMAIN = 'example.testcompany';
const COMPANY = 'Acme Research GmbH';
const HUBSPOT_TOOL = 'HUBSPOT_GET_COMPANY';
const MCP_TOOL = 'research_company';
const id = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const actorSchema = z.object({ userId: id, workspaceId: id, agentId: id, sessionId: id }).strict();
const evidenceSchema = z.object({ schemaVersion: z.literal(1), exactPin: z.object({
  resourceRef: z.string().regex(/^canvas-resource:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
  publishedRevisionRef: z.string().regex(/^canvas-package-revision:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict(), actors: z.tuple([actorSchema, actorSchema]),
expectedFixtureOrigin: z.string().refine(value => {
  try { const url = new URL(value); return /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value) && url.origin === value && Number(url.port) <= 65535; }
  catch { return false; }
}), domain: z.literal(DOMAIN) }).strict().superRefine((value, context) => {
  const [first, second] = value.actors;
  if (first.userId === second.userId || first.sessionId === second.sessionId || first.agentId !== second.agentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Two users and sessions on the same fixed Agent are required.' });
  }
});
type Evidence = z.infer<typeof evidenceSchema>;
type Actor = z.infer<typeof actorSchema>;
type Row = Record<string, unknown>;
const fixtureStatusSchema = z.object({ schemaVersion: z.literal(1), nonce: z.string().uuid(), requests: z.number().int().nonnegative(),
  available: z.object({ composio: z.literal(true), mcp: z.literal(true) }),
  rotated: z.object({ composio: z.literal(false), mcp: z.literal(false) }), composioVersion: z.literal('20261016_01'),
  actors: z.array(z.object({ slot: z.enum(['actor-a', 'actor-b']), entityHash: z.string().regex(/^[a-f0-9]{64}$/u),
    accounts: z.array(z.object({ toolkit: z.string(), accountHash: z.string(), active: z.boolean() })) })),
  calls: z.array(z.object({ sequence: z.number().int(), provider: z.enum(['composio', 'mcp']), operation: z.string(),
    tool: z.string().optional(), actorSlot: z.enum(['actor-a', 'actor-b']).optional(), entityHash: z.string().optional(),
    accountHash: z.string().optional(), argumentsHash: z.string().optional(), versionHash: z.string().optional(),
    exactBinding: z.boolean().optional(), successful: z.boolean().optional() })),
});
type FixtureStatus = z.infer<typeof fixtureStatusSchema>;
type Prepared = { actor: Actor; context: AgentExecutionContext; gateway: IntegrationGatewayAgentTool;
  entityHash: string; accountHash: string; hubspotProviderRef: string; mcpProviderRef: string; configurationHash: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let stage = 'arguments';

/** Match the integration-runtime CLI harness: bridge actual ESM namespaces into tsx's CJS product imports. */
async function bootstrapPiEsmImports(): Promise<() => void> {
  const modules = new Map<string, unknown>();
  for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) {
    modules.set(name, await import(name));
  }
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, main) => modules.has(name) ? modules.get(name) : original(name, parent, main);
  return () => { loader._load = original; };
}

function must(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function record(value: unknown): Row {
  must(value && typeof value === 'object' && !Array.isArray(value), 'RESULT_OBJECT_REQUIRED'); return value as Row;
}
function pinMatches(value: { resourceRef: string; publishedRevisionRef: string; checksum: string }, input: Evidence): boolean {
  return value.resourceRef === input.exactPin.resourceRef && value.publishedRevisionRef === input.exactPin.publishedRevisionRef && value.checksum === input.exactPin.checksum;
}

async function privateInput(file: string): Promise<Evidence> {
  const handle = await fs.open(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    must(stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024 && (stat.mode & 0o077) === 0
      && (!process.getuid || stat.uid === process.getuid()), 'PRIVATE_INPUT_REQUIRED');
    return evidenceSchema.parse(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }
}

async function fixtureStatus(input: Evidence): Promise<FixtureStatus> {
  const response = await fetch(`${input.expectedFixtureOrigin}/__fixture/status`, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  must(response.ok, 'FIXTURE_UNAVAILABLE');
  const bytes = await response.arrayBuffer(); must(bytes.byteLength <= 1024 * 1024, 'FIXTURE_STATUS_TOO_LARGE');
  return fixtureStatusSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
}

async function configurationFacts(database: SqlConnection, actor: Actor): Promise<string> {
  const session = await database.get(`SELECT session_id,user_id,agent_id,organization_id,workspace_id,workspace_type,
    workspace_name,workspace_root_relative_path,customer_id,project_id,archived_at FROM pi_sessions
    WHERE session_id=$1 AND user_id=$2 AND agent_id=$3 AND workspace_id=$4 AND archived_at IS NULL`,
  [actor.sessionId, actor.userId, actor.agentId, actor.workspaceId]);
  must(session, 'STORED_SESSION_REQUIRED');
  const agent = await database.get('SELECT * FROM agents WHERE agent_id=$1', [actor.agentId]);
  const bindings = await database.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY id', [actor.agentId]);
  const preferences = await database.all('SELECT * FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2 ORDER BY agent_id,user_id', [actor.agentId, actor.userId]);
  return hash(JSON.stringify([session, agent, bindings, preferences]));
}

async function prepare(input: Evidence, actor: Actor): Promise<Prepared> {
  const { openDb } = await import('../app/lib/db');
  const { readStoredAgentWorkspaceOnConnection, workspaceToAgentExecutionContext } = await import('../app/lib/pi/session-workspace-context');
  const { readManagedAgentWorkflow, getSelectedAgentWorkflowCapability } = await import('../app/lib/agents/workflow-configuration');
  const { readOwnedComposioProfileOnConnection } = await import('../app/lib/composio/composio-profiles');
  const { resolveEffectiveExtensionContext, readEffectiveExtensionContext } = await import('../app/lib/capabilities/extensions/effective-context');
  const { isHeldCapabilityPackageRuntimeBinding } = await import('../app/lib/capabilities/packages/runtime-bindings');
  const { authorizeIntegrationConnection } = await import('../app/lib/integration-tools/connections/store');
  const { createSharedIntegrationProviderRef } = await import('../app/lib/integration-tools/connections/provider-authorization');
  const { readSharedMcpConnectionConfig } = await import('../app/lib/mcp/shared-connections');
  const { readMcpConfig } = await import('../app/lib/mcp/config');
  const database = await openDb();
  let base: AgentExecutionContext, configurationHash: string;
  let entityHash = '', accountHash = '', hubspotProviderRef = '', mcpProviderRef = '';
  try {
    await database.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const workspace = await readStoredAgentWorkspaceOnConnection(database, { ...actor, permissions: ['canRead', 'canRunAgent'] });
    must(workspace.organizationId && !workspace.legacy, 'CURRENT_ORGANIZATION_WORKSPACE_REQUIRED');
    const session = record(await database.get(`SELECT organization_id,workspace_type,workspace_name,workspace_root_relative_path,customer_id,project_id
      FROM pi_sessions WHERE session_id=$1 AND user_id=$2 AND agent_id=$3`, [actor.sessionId, actor.userId, actor.agentId]));
    must(session.organization_id === workspace.organizationId && session.workspace_type === workspace.workspaceType
      && session.workspace_name === (workspace.displayName ?? null) && session.workspace_root_relative_path === (workspace.rootRelativePath ?? null)
      && session.customer_id === (workspace.customerId ?? null) && session.project_id === (workspace.projectId ?? null), 'SESSION_WORKSPACE_SNAPSHOT_STALE');
    configurationHash = await configurationFacts(database, actor);
    base = workspaceToAgentExecutionContext({ workspace, ...actor });
    const workflow = await readManagedAgentWorkflow({ userId: actor.userId, workspaceId: actor.workspaceId }, actor.agentId, { database });
    must(workflow.access.canUse && workflow.workflowVersion !== null, 'FIXED_WORKFLOW_USE_REQUIRED');
    // V2 package rows expose their normalized exact package configuration through the ordinary decoder.
    const packages = workflow.bindings.flatMap(binding => binding.configuration ? [binding.configuration] : []);
    const pkg = packages.find(candidate => pinMatches(candidate, input));
    must(pkg, 'EXACT_STORED_CAPABILITY_BINDING_REQUIRED');
    for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
      const selected = getSelectedAgentWorkflowCapability(workflow, pkg, declaration, capability);
      if (!selected) continue;
      const alternative = capability.alternatives.find(item => (item.source === 'composio' ? `composio:${item.toolkit}` : `mcp:${item.connector}`) === selected.alternativeKey);
      if (alternative?.source === 'composio' && alternative.toolkit === 'hubspot') {
        const target = selected.target, binding = target.personalBinding;
        must(target.kind === 'personal' && target.ownerUserId === actor.userId && binding?.source === 'composio'
          && binding.ownerUserId === actor.userId && binding.mode === 'local' && binding.toolkit === 'hubspot'
          && binding.accountBinding === 'account' && binding.connectedAccountId && target.boundProviderRef, 'EXACT_OWN_HUBSPOT_ACCOUNT_REQUIRED');
        const profile = await readOwnedComposioProfileOnConnection(database, actor.userId, binding.profileId);
        must(profile && !hubspotProviderRef, 'ONE_OWN_HUBSPOT_TARGET_REQUIRED');
        entityHash = hash(profile.composioUserId); accountHash = hash(binding.connectedAccountId); hubspotProviderRef = target.boundProviderRef;
      }
      if (alternative?.source === 'mcp' && alternative.connector === 'company-research') {
        must(!mcpProviderRef, 'ONE_RESEARCH_TARGET_REQUIRED');
        const target = selected.target;
        let config: import('../app/lib/mcp/config').McpServerConfig | undefined;
        if (target.kind === 'shared') {
          const authorization = await authorizeIntegrationConnection({ userId: actor.userId, workspaceId: actor.workspaceId,
            organizationId: workspace.organizationId, agentId: actor.agentId, sessionId: actor.sessionId }, target.connectionRef, 'inspect');
          must(authorization.backend.source === 'mcp', 'MCP_TARGET_REQUIRED');
          config = await readSharedMcpConnectionConfig(authorization); mcpProviderRef = createSharedIntegrationProviderRef(authorization.resource);
        } else {
          must(target.kind === 'personal' && target.ownerUserId === actor.userId && target.personalBinding?.source === 'mcp'
            && target.boundProviderRef, 'OWN_MCP_TARGET_REQUIRED');
          const binding = target.personalBinding;
          config = Object.values((await readMcpConfig({ userId: actor.userId })).mcpServers).find(item => item.connectionId === binding.connectionId);
          mcpProviderRef = target.boundProviderRef;
        }
        must(config?.url === `${input.expectedFixtureOrigin}/mcp` && !config.command && config.enabled !== false
          && (!config.auth || config.auth === 'none'), 'CONTROLLED_MCP_URL_REQUIRED');
      }
    }
    must(hubspotProviderRef && mcpProviderRef, 'BOTH_STORED_CAPABILITIES_REQUIRED');
    await database.run('COMMIT');
  } catch (error) { try { await database.run('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
  finally { await database.close(); }
  const context = await resolveEffectiveExtensionContext(base);
  const effective = readEffectiveExtensionContext(context);
  must(effective?.mode === 'fixed' && effective.packageSelection.packages.some(pkg => pinMatches(pkg, input)), 'EXACT_RESOLVED_WORKFLOW_PIN_REQUIRED');
  const bindings = context.skillPackageBindings?.filter(binding => pinMatches(binding, input)) ?? [];
  must(bindings.length && bindings.every(binding => isHeldCapabilityPackageRuntimeBinding(binding, context)), 'ACTUAL_ISSUED_PACKAGE_BINDING_REQUIRED');
  must(!context.agentTurnId && !context.turnExtensions && !context.turnExtensionSource, 'NO_SYNTHETIC_TURN_AUTHORITY');
  const { getPiTools } = await import('../app/lib/pi/tool-registry');
  const { isIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
  const tools = await getPiTools(actor.userId, actor.agentId, actor.sessionId,
    { executionContext: context, strictAuthorization: true, metadataOnlyExternal: true });
  const gateway = tools.find(isIntegrationGatewayTool); must(gateway, 'NORMAL_INTEGRATION_GATEWAY_REQUIRED');
  return { actor, context, gateway, entityHash, accountHash, hubspotProviderRef, mcpProviderRef, configurationHash };
}

async function invoke(prepared: Prepared, request: IntegrationRequest) {
  const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
  return runWithAgentExecutionContext(prepared.context, () => prepared.gateway.execute('creator-runtime-acceptance', request));
}
function details<T>(result: { details: unknown }): T {
  const value = record(result.details);
  if (value.integrationError) {
    const code = record(record(value.integrationError).error).code;
    throw new Error(typeof code === 'string' ? `GATEWAY_${code.toUpperCase()}` : 'GATEWAY_FAILED');
  }
  return value as T;
}
function jsonContent(result: { content: unknown }): Row {
  const content = result.content; must(Array.isArray(content), 'TOOL_CONTENT_REQUIRED');
  for (const block of content) if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
    try { return record(JSON.parse(block.text)); } catch { /* A later content block may contain the structured result. */ }
  }
  throw new Error('STRUCTURED_FIXTURE_RESULT_REQUIRED');
}

async function main() {
  const { values } = parseArgs({ options: { evidence: { type: 'string' }, output: { type: 'string' },
    'validate-input': { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    process.stdout.write('P7 targeted runtime bridge: --evidence <private 0600 JSON> [--output <new safe JSON>] [--validate-input].\nJSON: {schemaVersion:1,exactPin:{resourceRef,publishedRevisionRef,checksum},actors:[{userId,workspaceId,agentId,sessionId},{...}],expectedFixtureOrigin:"http://127.0.0.1:<port>",domain:"example.testcompany"}.\nUses existing managed DATABASE_URL/DATA and COMPOSIO_BASE_URL supplied by the caller. Creates no Agent, Session, grant, choice or intake receipt. Executes only the two controlled readonly Gateway tools; normal audit/cache/observations remain active. No model invocation or synthetic agentTurnId. Fixture counters cover recorded discovery/account/tool operations, not all provider HTTP requests.\n'); return;
  }
  must(values.evidence, 'PRIVATE_EVIDENCE_ARGUMENT_REQUIRED'); stage = 'input';
  const input = await privateInput(values.evidence);
  if (values['validate-input']) { process.stdout.write('{"schemaVersion":1,"inputValid":true,"runtimeStarted":false}\n'); return; }
  stage = 'environment';
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  const databaseName = databaseUrl.pathname.slice(1);
  must(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname) && databaseUrl.port === '55433'
    && (databaseName === 'canvas_notebook' || /^canvas_creator_e2e_[a-f0-9]{16,32}$/u.test(databaseName)), 'EXISTING_MANAGED_NOTEBOOK_DATABASE_REQUIRED');
  must(process.env.DATA || process.env.CANVAS_DATA_ROOT, 'EXPLICIT_MANAGED_DATA_REQUIRED');
  must(process.env.COMPOSIO_BASE_URL?.replace(/\/$/u, '') === input.expectedFixtureOrigin, 'CONTROLLED_COMPOSIO_ORIGIN_REQUIRED');
  const savedConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  let suppressedProductLogs = 0;
  // Product diagnostics can contain private connection IDs. Keep only a count; never mirror them into acceptance evidence.
  for (const name of Object.keys(savedConsole) as Array<keyof typeof savedConsole>) console[name] = () => { suppressedProductLogs++; };
  let cleanup: (() => Promise<void>) | undefined;
  let restorePiImports: (() => void) | undefined;
  try {
    stage = 'module-bootstrap'; restorePiImports = await bootstrapPiEsmImports();
    stage = 'fixture-start'; const before = await fixtureStatus(input);
    cleanup = async () => {
      try { await (await import('../app/lib/mcp/manager')).closeAllMcpServers(); }
      finally { await (await import('../app/lib/db')).closeDatabaseConnections(); }
    };
    stage = 'prepare-first'; const first = await prepare(input, input.actors[0]);
    stage = 'prepare-second'; const second = await prepare(input, input.actors[1]);
    must(first.context.organizationId === second.context.organizationId && first.entityHash !== second.entityHash
      && first.accountHash !== second.accountHash && first.hubspotProviderRef !== second.hubspotProviderRef, 'SEPARATE_OWN_ACTOR_ACCOUNTS_REQUIRED');
    const { openDb } = await import('../app/lib/db');
    const preparedStatus = await fixtureStatus(input);
    must(preparedStatus.requests === before.requests, 'CONSTRUCTION_MUST_NOT_ADD_RECORDED_FIXTURE_OPERATIONS');
    const schemas: IntegrationToolSchema[] = [];
    const results: Row[] = [];
    for (const [index, prepared] of [first, second].entries()) {
      stage = `actor-${index + 1}-discovery`;
      const registered = preparedStatus.actors.find(actor => actor.entityHash === prepared.entityHash);
      must(registered && registered.accounts.some(account => account.toolkit === 'hubspot' && account.active && account.accountHash === prepared.accountHash), 'EXACT_FIXTURE_ACCOUNT_REGISTRATION_REQUIRED');
      const providers = details<IntegrationProviderPage>(await invoke(prepared, { action: 'list', target: 'providers', limit: 50 }));
      must(providers.complete && !providers.nextCursor && !providers.providerErrors.length, 'COMPLETE_PROVIDER_DISCOVERY_REQUIRED');
      const hubspot = providers.providers.find(provider => provider.source === 'composio' && provider.application === 'hubspot' && provider.providerRef === prepared.hubspotProviderRef);
      const research = providers.providers.find(provider => provider.source === 'mcp' && provider.providerRef === prepared.mcpProviderRef);
      must(hubspot && research, 'EXACT_WORKFLOW_PROVIDERS_REQUIRED');
      for (const [provider, toolName] of [[hubspot, HUBSPOT_TOOL], [research, MCP_TOOL]] as const) {
        // A personal workflow provider initially exposes configuration metadata; its tools perform the current runtime check.
        must(provider.configured && provider.nextActions.some(action => action.kind === 'gateway'
          && action.request.action === 'list' && action.request.target === 'tools'
          && action.request.providerRef === provider.providerRef), 'EXACT_PROVIDER_TOOL_DISCOVERY_ACTION_REQUIRED');
        stage = `actor-${index + 1}-${toolName}-schema`;
        const page = details<IntegrationToolPage>(await invoke(prepared, { action: 'list', target: 'tools', providerRef: provider.providerRef, limit: 50 }));
        must(page.complete && !page.nextCursor, 'COMPLETE_TOOL_DISCOVERY_REQUIRED');
        const tool = page.tools.find(candidate => candidate.name === toolName); must(tool, 'READONLY_TOOL_DISCOVERY_REQUIRED');
        const schema = details<IntegrationToolSchema>(await invoke(prepared, { action: 'describe', toolRef: tool.toolRef }));
        must(schema.providerRef === provider.providerRef && schema.inputSchema && typeof schema.inputSchema === 'object'
          && Array.isArray(schema.inputSchema.required) && schema.inputSchema.required.includes('domain'), 'ACTUAL_DOMAIN_SCHEMA_REQUIRED');
        if (toolName === HUBSPOT_TOOL) { must(schema.toolVersion === before.composioVersion, 'CONCRETE_COMPOSIO_VERSION_REQUIRED'); schemas.push(schema); }
        const snapshot = await fixtureStatus(input); stage = `actor-${index + 1}-${toolName}-call`;
        const result = await invoke(prepared, { action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: { domain: input.domain } });
        details(result); const content = jsonContent(result);
        const after = await fixtureStatus(input);
        const executions = after.calls.filter(call => call.sequence > snapshot.requests && call.tool === toolName
          && call.operation === (toolName === HUBSPOT_TOOL ? 'tools/execute' : 'tools/call'));
        must(executions.length === 1 && executions[0].successful, 'ONE_CONFIRMED_FIXTURE_EXECUTION_REQUIRED');
        if (toolName === HUBSPOT_TOOL) {
          must(content.successful === true && record(record(content.data).company).name === COMPANY, 'ACTUAL_CRM_COMPANY_RESULT_REQUIRED');
          must(executions[0].exactBinding && executions[0].actorSlot === registered.slot && executions[0].entityHash === prepared.entityHash
            && executions[0].accountHash === prepared.accountHash && typeof schema.toolVersion === 'string'
            && executions[0].versionHash === hash(schema.toolVersion), 'ACTUAL_OWN_ACCOUNT_DISPATCH_REQUIRED');
        } else must(content.company === COMPANY && content.domain === input.domain && Array.isArray(content.facts) && content.facts.length === 3
          && Array.isArray(content.sources) && content.sources.length === 2, 'ACTUAL_RESEARCH_FACTS_AND_SOURCES_REQUIRED');
        results.push({ actor: index + 1, tool: toolName, schemaHash: hash(JSON.stringify(schema.inputSchema)),
          confirmedExecution: true, exactOwnAccount: toolName === HUBSPOT_TOOL ? true : undefined, resultHash: hash(JSON.stringify(content)) });
      }
    }
    stage = 'cross-actor-receipt'; must(schemas.length === 2, 'BOTH_ISSUED_SCHEMAS_REQUIRED');
    const crossBefore = await fixtureStatus(input);
    const cross = record((await invoke(second, { action: 'call', toolRef: schemas[0].toolRef, schemaRef: schemas[0].schemaRef,
      arguments: { domain: input.domain } })).details);
    must(cross.integrationError && record(record(cross.integrationError).error).code === 'schema_changed', 'CROSS_ACTOR_SCHEMA_RECEIPT_MUST_BE_DENIED');
    const crossAfter = await fixtureStatus(input);
    must(crossAfter.requests === crossBefore.requests, 'CROSS_ACTOR_DENIAL_MUST_PRECEDE_RECORDED_FIXTURE_OPERATION');
    stage = 'configuration-preserved';
    const database = await openDb();
    try { for (const prepared of [first, second]) must(await configurationFacts(database, prepared.actor) === prepared.configurationHash, 'STORED_CONFIGURATION_CHANGED'); }
    finally { await database.close(); }
    const summary = { schemaVersion: 1, status: 'passed', claim: 'targeted_gateway_from_stored_fixed_agent_sessions',
      naturalModelOrAcceptedTurnClaim: false, syntheticTurnId: false, setupMutations: false,
      exactPinHash: hash(JSON.stringify(input.exactPin)), actors: 2, distinctOwnAccounts: true, results,
      recordedFixtureOperations: { beforePreparation: before.requests, afterPreparation: preparedStatus.requests,
        beforeCrossActorCall: crossBefore.requests, afterCrossActorCall: crossAfter.requests },
      providerHttpRequestsMeasured: false, crossActorSchemaReceiptDeniedBeforeRecordedFixtureOperation: true,
      configurationPreserved: true, suppressedProductLogs };
    if (values.output) await fs.writeFile(path.resolve(values.output), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify(summary) + '\n');
  } finally { try { await cleanup?.(); } finally { restorePiImports?.(); Object.assign(console, savedConsole); } }
}

void main().catch(error => {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code
    : error instanceof Error ? error.message : '';
  process.stderr.write(JSON.stringify({ schemaVersion: 1, status: 'failed', stage,
    code: /^[A-Z][A-Z0-9_]{1,100}$/u.test(code) ? code : 'ACCEPTANCE_FAILED', privateDiagnosticsOmitted: true }) + '\n');
  process.exitCode = 1;
});
