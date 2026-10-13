import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { parseEnvDocument } from '../../app/lib/secrets/env-document';

type Json = Record<string, unknown>;
type Target = { scope: 'organization' | 'team'; connectionRef: string; workspaceId: string; profileId: string };
type FileDigest = { relative: string; mode: number; bytes: number; sha256: string };
type BindingDigest = { scope: 'organization' | 'team'; connectionRefHash: string; profileIdHash: string;
  accountIdHash: string; composioUserIdHash: string; workspaceIdHash: string | null;
  metadataRevision: number; grantsRevision: number; bindingRevision: number;
  resourceSHA: string; profileSHA: string; grantsSHA: string };
export type ReplaySnapshotLineageProof = { version: 1; nonce: string; sourceNonce: string;
  phase: 'source_before' | 'clone_after' | 'source_final'; organizationIdHash: string; actorIdHash: string;
  organizationSHA: string; ownerPermissionSHA: string; bindings: BindingDigest[]; encryptedEnvSHA: string;
  dataManifestSHA: string; dataFileCount: number; dataBytes: number; licenseIdentityExcluded: true };
type SnapshotInput = { phase: ReplaySnapshotLineageProof['phase']; database: Pool; databaseName: string;
  dataRoot: string; root: string; nonce: string; sourceNonce: string; organizationId: string; actorId: string;
  expected?: ReplaySnapshotLineageProof };
const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const tool = 'CANVA_GET_USERS_ME_CAPABILITIES';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function record(value: unknown): Json {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Json;
}
function canonical(value: unknown): string {
  const visit = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(visit)
    : entry !== null && typeof entry === 'object'
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, visit(child)]))
      : entry;
  return JSON.stringify(visit(value));
}
async function ownedDirectory(directory: string, privateMode = false): Promise<void> {
  const stat = await fs.lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
    && await fs.realpath(directory) === directory && (!privateMode || (stat.mode & 0o777) === 0o700));
}
async function proofRoot(root: string, nonce: string, sourceNonce?: string): Promise<void> {
  assert(path.isAbsolute(root) && /^canvas-composio-live-model-[A-Za-z0-9]{6}$/u.test(path.basename(root)));
  assert(/^[a-f0-9]{32}$/u.test(nonce));
  if (sourceNonce !== undefined) assert(/^[a-f0-9]{32}$/u.test(sourceNonce) && sourceNonce !== nonce);
  await ownedDirectory(root, true);
}
async function readOwnedBytes(filename: string, maximum: number, mode?: number): Promise<Buffer> {
  assert(path.isAbsolute(filename) && await fs.realpath(filename) === filename);
  const before = await fs.lstat(filename), handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid?.()
      && before.size <= maximum && (mode === undefined || (before.mode & 0o777) === mode));
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset); assert(read.bytesRead > 0); offset += read.bytesRead;
    }
    assert.equal((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead, 0);
    for (const current of [await handle.stat(), await fs.lstat(filename)]) assert(current.isFile()
      && !current.isSymbolicLink() && current.nlink === 1 && current.uid === before.uid && current.dev === before.dev
      && current.ino === before.ino && current.size === before.size && current.mode === before.mode
      && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs);
    return bytes;
  } finally { await handle.close(); }
}
async function privateProof(root: string, name: string, value: unknown): Promise<void> {
  assert(/^[a-z0-9-]+\.json$/u.test(name)); await ownedDirectory(root, true);
  const bytes = canonical(value); assert(Buffer.byteLength(bytes) <= 1024 * 1024);
  const handle = await fs.open(path.join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function readOnly<T>(database: Pool, databaseName: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  assert(/^canvas_connection_test_[a-f0-9]{32}$/u.test(databaseName));
  const client = await database.connect(); let opened = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); opened = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only, 'on');
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0]?.name, databaseName);
    const result = await operation(client); await client.query('COMMIT'); opened = false; return result;
  } finally { try { if (opened) await client.query('ROLLBACK'); } finally { client.release(); } }
}
async function dataManifest(dataRoot: string): Promise<FileDigest[]> {
  await ownedDirectory(dataRoot, true); const files: FileDigest[] = []; let total = 0, nodes = 0;
  const walk = async (directory: string): Promise<void> => {
    await ownedDirectory(directory);
    for (const name of (await fs.readdir(directory)).sort()) {
      assert(++nodes <= 50_000); const absolute = path.join(directory, name), relative = path.relative(dataRoot, absolute);
      // Only copied local license identity is quarantined. Every domain and scoped-secret byte remains covered.
      if (relative === 'secrets/license') continue;
      const stat = await fs.lstat(absolute); assert(!stat.isSymbolicLink() && stat.uid === process.getuid?.());
      if (stat.isDirectory()) await walk(absolute);
      else {
        assert(stat.isFile() && stat.nlink === 1); total += stat.size; assert(total <= 256 * 1024 * 1024);
        const bytes = await readOwnedBytes(absolute, 32 * 1024 * 1024);
        files.push({ relative, mode: stat.mode & 0o777, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  };
  await walk(dataRoot); return files.sort((a, b) => a.relative.localeCompare(b.relative));
}
async function snapshotBindings(client: PoolClient, organizationId: string): Promise<BindingDigest[]> {
  const rows = (await client.query(`SELECT to_jsonb(c) AS resource,to_jsonb(p) AS profile,to_jsonb(w) AS workspace
    FROM integration_connection_resources c LEFT JOIN composio_connection_profiles p ON p.id=c.backend_profile_id
    LEFT JOIN canvas_workspaces w ON w.id=c.team_workspace_id
    WHERE c.source='composio' AND c.organization_id=$1 ORDER BY c.connection_ref LIMIT 3`, [organizationId])).rows;
  assert.equal(rows.length, 2); const bindings: BindingDigest[] = [];
  for (const row of rows) {
    const resource = record(row.resource), profile = record(row.profile), scope = resource.ownership_type;
    assert(scope === 'organization' || scope === 'team');
    assert(resource.organization_id === organizationId && resource.status === 'active' && resource.backend_mode === 'local'
      && resource.backend_toolkit === 'canva' && resource.account_binding === 'account'
      && typeof resource.backend_account_id === 'string' && resource.backend_account_id.length > 0
      && typeof resource.connection_ref === 'string' && /^canvas-connection:[a-f0-9-]{36}$/u.test(resource.connection_ref)
      && typeof resource.backend_profile_id === 'string' && resource.backend_profile_id === profile.id);
    for (const key of ['metadata_revision', 'grants_revision', 'binding_revision']) assert(Number.isSafeInteger(Number(resource[key])) && Number(resource[key]) > 0);
    assert(profile.owner_user_id === null && profile.organization_id === organizationId && profile.provider_mode === 'local'
      && profile.status === 'active' && Number.isSafeInteger(Number(profile.profile_revision)) && Number(profile.profile_revision) > 0
      && typeof profile.composio_user_id === 'string' && profile.composio_user_id.length > 0);
    if (scope === 'organization') assert(resource.team_workspace_id === null && profile.workspace_id === null && profile.scope_type === 'organization');
    else {
      const workspace = record(row.workspace);
      assert(profile.scope_type === 'workspace' && profile.workspace_id === resource.team_workspace_id
        && workspace.id === resource.team_workspace_id && workspace.organization_id === organizationId
        && workspace.type === 'team' && workspace.status === 'active');
    }
    const grants = (await client.query('SELECT to_jsonb(g) AS entry FROM integration_connection_grants g WHERE connection_ref=$1 ORDER BY target_type,target_id LIMIT 101', [resource.connection_ref])).rows;
    assert(grants.length <= 100);
    const allowed = resource.allowed_tool_names_json === null ? null : JSON.parse(String(resource.allowed_tool_names_json));
    assert(allowed === null || Array.isArray(allowed) && allowed.includes(tool));
    bindings.push({ scope, connectionRefHash: hash(resource.connection_ref), profileIdHash: hash(String(profile.id)),
      accountIdHash: hash(resource.backend_account_id), composioUserIdHash: hash(String(profile.composio_user_id)),
      workspaceIdHash: scope === 'team' ? hash(String(resource.team_workspace_id)) : null,
      metadataRevision: Number(resource.metadata_revision), grantsRevision: Number(resource.grants_revision), bindingRevision: Number(resource.binding_revision),
      resourceSHA: hash(canonical(resource)), profileSHA: hash(canonical(profile)), grantsSHA: hash(canonical(grants.map(value => value.entry))) });
  }
  assert.deepEqual(bindings.map(entry => entry.scope).sort(), ['organization', 'team']);
  assert.equal(new Set(bindings.map(entry => entry.profileIdHash)).size, 2);
  assert.equal(new Set(bindings.map(entry => entry.accountIdHash)).size, 2);
  return bindings;
}

/** Three separate observations establish source-before, exact copied bytes, and untouched source-final. */
export async function assertReplaySnapshotLineage(input: SnapshotInput): Promise<ReplaySnapshotLineageProof> {
  try {
    await proofRoot(input.root, input.nonce, input.sourceNonce); assert(ID.test(input.organizationId) && ID.test(input.actorId));
    assert(['source_before', 'clone_after', 'source_final'].includes(input.phase));
    assert(input.phase === 'clone_after' ? input.dataRoot === path.join(input.root, 'data') : path.dirname(input.dataRoot) !== input.root);
    const files = await dataManifest(input.dataRoot);
    const envRelative = `organizations/${input.organizationId}/secrets/Canvas-Secrets.env`;
    assert.equal(files.filter(file => file.relative === envRelative).length, 1);
    const env = await readOwnedBytes(path.join(input.dataRoot, envRelative), 2 * 1024 * 1024, 0o600);
    const key = parseEnvDocument(env.toString('utf8')).find(entry => entry.key === 'COMPOSIO_API_KEY')?.value;
    assert(typeof key === 'string' && /^enc:(?:env:)?v1:/u.test(key));
    const sql = await readOnly(input.database, input.databaseName, async client => {
      const organizations = (await client.query('SELECT to_jsonb(o) AS entry FROM canvas_organization_settings o ORDER BY organization_id LIMIT 2')).rows;
      assert.equal(organizations.length, 1); const organization = record(organizations[0].entry);
      assert(organization.organization_id === input.organizationId && organization.owner_user_id === input.actorId);
      const owners = (await client.query(`SELECT to_jsonb(p) AS permission,u.id,u.role FROM organization_user_permissions p
        JOIN "user" u ON u.id=p.user_id WHERE p.organization_id=$1 AND p.user_id=$2`, [input.organizationId, input.actorId])).rows;
      assert.equal(owners.length, 1); const permission = record(owners[0].permission);
      assert(owners[0].id === input.actorId && owners[0].role === 'admin' && permission.role === 'owner'
        && (permission.status === 'active' || permission.status === null));
      return { organizationSHA: hash(canonical(organization)), ownerPermissionSHA: hash(canonical(permission)), bindings: await snapshotBindings(client, input.organizationId) };
    });
    const result: ReplaySnapshotLineageProof = { version: 1, nonce: input.nonce, sourceNonce: input.sourceNonce, phase: input.phase,
      organizationIdHash: hash(input.organizationId), actorIdHash: hash(input.actorId), ...sql, encryptedEnvSHA: hash(env),
      dataManifestSHA: hash(canonical(files)), dataFileCount: files.length, dataBytes: files.reduce((sum, file) => sum + file.bytes, 0), licenseIdentityExcluded: true };
    if (input.phase === 'source_before') assert.equal(input.expected, undefined);
    else {
      assert(input.expected?.phase === 'source_before');
      assert.deepEqual({ ...result, phase: 'source_before' }, input.expected);
    }
    await privateProof(input.root, `snapshot-lineage-${input.phase.replaceAll('_', '-')}.json`, result); return result;
  } catch { throw new Error('The owned replay snapshot lineage is unproven.'); }
}

/** This is a read-only baseline gate; it never repairs membership or outbox rows. */
export async function assertReplayBaselineReadiness(input: { database: Pool; databaseName: string; organizationId: string;
  actorId: string; additionalUsers: 2 }): Promise<{ activeMemberships: number; membershipSHA: string; terminalOutboxSHA: string }> {
  try {
    assert(ID.test(input.organizationId) && ID.test(input.actorId) && input.additionalUsers === 2);
    return await readOnly(input.database, input.databaseName, async client => {
      const memberships = (await client.query(`SELECT id,user_id,role FROM team_memberships WHERE organization_id=$1
        AND status='active' AND user_id IS NOT NULL AND accepted_at IS NOT NULL ORDER BY id LIMIT 5`, [input.organizationId])).rows;
      assert(memberships.length >= 1 && memberships.length + input.additionalUsers <= 4);
      assert.equal(memberships.filter(member => member.user_id === input.actorId && member.role === 'owner').length, 1);
      assert.equal(new Set(memberships.map(member => member.user_id)).size, memberships.length);
      const open = (await client.query(`SELECT id FROM team_seat_outbox WHERE organization_id=$1
        AND status IN ('pending','processing','retry_wait') LIMIT 1`, [input.organizationId])).rows;
      assert.equal(open.length, 0);
      const terminal = (await client.query(`SELECT id,operation_id,operation_kind,status,request_hash FROM team_seat_outbox
        WHERE organization_id=$1 ORDER BY id LIMIT 1001`, [input.organizationId])).rows;
      assert(terminal.length <= 1000 && terminal.every(operation => ['succeeded','failed','canceled'].includes(operation.status)));
      return { activeMemberships: memberships.length, membershipSHA: hash(canonical(memberships)), terminalOutboxSHA: hash(canonical(terminal)) };
    });
  } catch { throw new Error('The retained membership and seat-operation baseline is unproven.'); }
}

type Effect = { scope: Target['scope']; connectionRef: string; workspaceId: string; toolName: string; toolCallId: string;
  providerRef: string; toolRef: string; schemaRef: string; toolVersion: string; inputSchemaSHA: string; responseSHA: string; successful: boolean };
type Run = { actorId: string; authSessionHash: string; sessionId: string; agentId: string; workspaceId: string; organizationId: string;
  transcriptSHA: string; runtimeHash: string; role: string; access: Json; businessCalls: number; toolCallCount: number; effects: Effect[] };
type LiveReceipt = { version: number; nonce: string; actorId: string; actorIds: string[]; organizationId: string; workspaceId: string;
  agentId: string; phase: string; outstanding: unknown; authClosed: boolean; closedContexts: boolean; normalSessionNull: string[];
  targets: Target[]; runs: Run[]; cleanupFailures: unknown[]; failure?: unknown; evidence: Array<{ relative: string; sha256: string }>;
  sourceHashes: Record<string, string>; model: Json; publication: Json; fixedConfigurationHash: string };
type Operation = { index: number; toolCallId: string; arguments: Json; result: Json; providers?: Json[]; tools?: Json[]; schema?: Json };
type AuditInput = { database: Pool; databaseName: string; root: string; nonce: string; actorId: string; organizationId: string;
  snapshot: ReplaySnapshotLineageProof; expectedBrowserSourceHashes: Record<string, string> };
const flag = (value: unknown) => value === true || value === 1 || value === '1';

async function evidenceJson(root: string, receipt: LiveReceipt, name: string): Promise<{ value: Json; sha256: string }> {
  assert(/^[a-z0-9][a-z0-9.-]{0,99}$/u.test(name));
  const directory = path.join(root, 'live-composio-model-evidence'); await ownedDirectory(directory, true);
  const relative = `live-composio-model-evidence/${name}`, matches = receipt.evidence.filter(entry => entry.relative === relative);
  assert.equal(matches.length, 1); assert(SHA.test(matches[0].sha256));
  const bytes = await readOwnedBytes(path.join(root, relative), 256 * 1024, 0o600);
  assert.equal(hash(bytes), matches[0].sha256); return { value: record(JSON.parse(bytes.toString('utf8'))), sha256: hash(bytes) };
}

function assertProtocol(protocol: Json, run: Run, targets: Target[]): void {
  assert(protocol.version === 1 && protocol.transcriptSHA === run.transcriptSHA && protocol.toolCallCount === run.toolCallCount
    && protocol.toolErrors === 0 && protocol.providerResponsesPersisted === false && Array.isArray(protocol.operations));
  const operations = protocol.operations as Operation[];
  assert(operations.length >= 7 && operations.length <= 32 && operations.length === run.toolCallCount);
  assert.equal(new Set(operations.map(operation => operation.toolCallId)).size, operations.length);
  for (const operation of operations) {
    assert(Number.isSafeInteger(operation.index) && operation.index >= 0 && typeof operation.toolCallId === 'string'
      && operation.toolCallId.length > 0 && operation.toolCallId.length <= 256);
    const args = record(operation.arguments), result = record(operation.result);
    assert(['list','search','describe','call'].includes(String(args.action)) && result.version === 1 && result.action === args.action
      && Number.isSafeInteger(result.index) && Number(result.index) > operation.index);
    assert(Object.keys(args).every(key => ['version','action','target','providerRef','toolRef','schemaRef','arguments',
      'cursor','limit','source','state','application','pluginRef','capabilityRef','query'].includes(key)));
  }
  assert.equal(operations.filter(operation => operation.arguments.action === 'call').length, 2);
  const descriptions: number[] = [], calls: number[] = [];
  for (const target of targets) {
    const effect = run.effects.find(entry => entry.connectionRef === target.connectionRef); assert(effect);
    assert(effect.scope === target.scope && effect.workspaceId === run.workspaceId && effect.toolName === tool && effect.successful === true
      && SHA.test(effect.inputSchemaSHA) && SHA.test(effect.responseSHA));
    const providers = operations.filter(operation => operation.arguments.action === 'list' && operation.arguments.target === 'providers')
      .flatMap(operation => (operation.providers ?? []).map(provider => ({ provider, operation })))
      .filter(entry => record(entry.provider.scope).resourceId === target.connectionRef);
    assert(providers.length > 0);
    const first = providers[0], provider = record(first.provider), scope = record(provider.scope);
    assert(provider.providerRef === effect.providerRef && provider.source === 'composio' && provider.application === 'canva'
      && provider.state === 'ready' && provider.canExecute === true && provider.configured === true && provider.authorized === true
      && scope.organizationId === run.organizationId && scope.type === (target.scope === 'team' ? 'workspace' : 'organization')
      && (target.scope !== 'team' || scope.workspaceId === target.workspaceId));
    assert(providers.every(entry => entry.provider.providerRef === effect.providerRef));
    const tools = operations.filter(operation => operation.arguments.action === 'list' && operation.arguments.target === 'tools'
      && operation.arguments.providerRef === effect.providerRef && operation.index > Number(first.operation.result.index))
      .flatMap(operation => (operation.tools ?? []).map(entry => ({ entry, operation }))).filter(entry => entry.entry.name === tool);
    assert(tools.length > 0 && tools.every(entry => entry.entry.toolRef === effect.toolRef && entry.entry.providerRef === effect.providerRef));
    const described = operations.filter(operation => operation.arguments.action === 'describe' && operation.arguments.toolRef === effect.toolRef
      && operation.index > Number(tools[0].operation.result.index));
    assert(described.length > 0); const description = described[described.length - 1], schema = record(description.schema);
    assert(schema.version === 1 && schema.providerRef === effect.providerRef && schema.toolRef === effect.toolRef
      && schema.schemaRef === effect.schemaRef && schema.toolVersion === effect.toolVersion && effect.toolVersion !== 'latest'
      && typeof effect.toolVersion === 'string' && effect.toolVersion.length > 0 && effect.toolVersion.length <= 128);
    assert.equal(hash(JSON.stringify(record(schema.inputSchema))), effect.inputSchemaSHA);
    const called = operations.filter(operation => operation.arguments.action === 'call' && operation.arguments.toolRef === effect.toolRef);
    assert.equal(called.length, 1); const call = called[0];
    assert(call.index > Number(description.result.index) && call.toolCallId === effect.toolCallId && call.arguments.schemaRef === effect.schemaRef
      && Object.keys(record(call.arguments.arguments)).length === 0 && call.result.source === 'composio'
      && call.result.providerRef === effect.providerRef && call.result.toolRef === effect.toolRef && call.result.schemaRef === undefined
      && call.result.successful === true && call.result.responseSHA === effect.responseSHA);
    descriptions.push(Number(description.result.index)); calls.push(call.index);
  }
  assert(Math.max(...descriptions) < Math.min(...calls));
  for (const key of ['providerRef','toolRef','schemaRef','toolCallId'] as const) assert.equal(new Set(run.effects.map(effect => effect[key])).size, 2);
}

/** Real call audits prove the dispatcher effects; model/schema evidence comes from authenticated safe browser artifacts. */
export async function assertLiveComposioModelAudit(input: AuditInput): Promise<{ auditCount: 4; proofSHA: string }> {
  try {
    await proofRoot(input.root, input.nonce); assert(ID.test(input.actorId) && ID.test(input.organizationId));
    assert(input.snapshot.phase === 'source_before' && input.snapshot.nonce === input.nonce
      && input.snapshot.actorIdHash === hash(input.actorId) && input.snapshot.organizationIdHash === hash(input.organizationId));
    const receiptBytes = await readOwnedBytes(path.join(input.root, 'live-composio-model-receipt.json'), 1024 * 1024, 0o600);
    const receipt = record(JSON.parse(receiptBytes.toString('utf8'))) as unknown as LiveReceipt;
    assert(receipt.version === 1 && receipt.nonce === input.nonce && receipt.actorId === input.actorId && receipt.organizationId === input.organizationId
      && receipt.phase === 'verified_closed' && receipt.outstanding === null && receipt.authClosed === true && receipt.closedContexts === true
      && receipt.failure === undefined && Array.isArray(receipt.cleanupFailures) && receipt.cleanupFailures.length === 0
      && ID.test(receipt.agentId) && ID.test(receipt.workspaceId));
    assert(Array.isArray(receipt.actorIds) && receipt.actorIds.length === 2 && new Set(receipt.actorIds).size === 2
      && receipt.actorIds.every(actorId => ID.test(actorId) && actorId !== input.actorId));
    assert.deepEqual(receipt.normalSessionNull.slice().sort(), [input.actorId, ...receipt.actorIds].sort());
    assert.deepEqual(receipt.sourceHashes, input.expectedBrowserSourceHashes);
    assert(Object.keys(receipt.sourceHashes).length === 4);
    for (const [relative, digest] of Object.entries(receipt.sourceHashes)) {
      assert(['tests/composio-live-model.spec.ts','tests/helpers/composio-live-model-fixture.ts',
        'tests/helpers/natural-workflow-model-setup.ts','tests/playwright/playwright.composio-live-model-production.config.ts'].includes(relative) && SHA.test(digest));
      assert.equal(hash(await readOwnedBytes(path.resolve(relative), 2 * 1024 * 1024)), digest);
    }
    assert(receipt.model.providerId === 'ollama' && receipt.model.modelId === 'kimi-k2.6:cloud' && receipt.model.thinkingLevel === 'off'
      && receipt.model.credentialScope === 'organization' && receipt.model.status === 'ready' && receipt.model.verificationCode === 'PROVIDER_VERIFIED');
    assert(receipt.targets.length === 2 && receipt.targets[0].scope === 'organization' && receipt.targets[1].scope === 'team'
      && receipt.targets[1].workspaceId === receipt.workspaceId && new Set(receipt.targets.map(target => target.connectionRef)).size === 2
      && new Set(receipt.targets.map(target => target.profileId)).size === 2);
    assert(receipt.runs.length === 2 && new Set(receipt.runs.map(run => run.sessionId)).size === 2
      && new Set(receipt.runs.map(run => run.authSessionHash)).size === 2);
    assert.deepEqual(receipt.runs.map(run => run.actorId).sort(), receipt.actorIds.slice().sort());
    assert(receipt.evidence.length >= 9 && receipt.evidence.length <= 32);
    assert.equal(new Set(receipt.evidence.map(entry => entry.relative)).size, receipt.evidence.length);
    for (const artifact of receipt.evidence) {
      assert(/^live-composio-model-evidence\/[a-z0-9][a-z0-9.-]{0,99}$/u.test(artifact.relative));
      if (artifact.relative.endsWith('.json')) await evidenceJson(input.root, receipt, path.basename(artifact.relative));
      else {
        assert(/^live-composio-model-evidence\/user-[12]-model-ui\.png$/u.test(artifact.relative) && SHA.test(artifact.sha256));
        const bytes = await readOwnedBytes(path.join(input.root, artifact.relative), 16 * 1024 * 1024, 0o600);
        assert.equal(hash(bytes), artifact.sha256); assert(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
      }
    }
    const routing = (await evidenceJson(input.root, receipt, 'fixed-routing.json')).value;
    assert(routing.agentId === receipt.agentId && hash(JSON.stringify(routing.configuration)) === receipt.fixedConfigurationHash);
    const configuration = record(routing.configuration); assert(configuration.version === 1 && Array.isArray(configuration.packages) && configuration.packages.length === 1);
    const configured = record(configuration.packages[0]);
    assert(configured.resourceRef === receipt.publication.resourceRef && configured.publishedRevisionRef === receipt.publication.publishedRevisionRef
      && configured.checksum === receipt.publication.checksum && SHA.test(String(configured.checksum)));
    const safeAudits: Json[] = [];
    await readOnly(input.database, input.databaseName, async client => {
      const currentBindings = await snapshotBindings(client, input.organizationId);
      for (const target of receipt.targets) {
        const before = input.snapshot.bindings.find(binding => binding.connectionRefHash === hash(target.connectionRef));
        const current = currentBindings.find(binding => binding.connectionRefHash === hash(target.connectionRef)); assert(before && current);
        assert(current.scope === target.scope && current.profileIdHash === hash(target.profileId) && current.profileSHA === before.profileSHA
          && current.accountIdHash === before.accountIdHash && current.composioUserIdHash === before.composioUserIdHash
          && current.bindingRevision === before.bindingRevision && current.metadataRevision === before.metadataRevision
          && current.workspaceIdHash === before.workspaceIdHash && current.grantsRevision === before.grantsRevision + 2);
      }
      const storedRows = (await client.query('SELECT configuration_json FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY id LIMIT 2', [receipt.agentId])).rows;
      assert.equal(storedRows.length, 1); const stored = record(JSON.parse(storedRows[0].configuration_json));
      assert(stored.resourceRef === receipt.publication.resourceRef && stored.publishedRevisionRef === receipt.publication.publishedRevisionRef
        && stored.checksum === receipt.publication.checksum && Array.isArray(stored.declarations));
      const capabilities = (stored.declarations as Json[]).flatMap(declaration => { assert(Array.isArray(declaration.capabilities)); return declaration.capabilities as Json[]; });
      assert.equal(capabilities.length, 2);
      for (const target of receipt.targets) {
        const capability = capabilities.find(entry => entry.capabilityId === `${target.scope}-canva`); assert(capability);
        const selection = record(capability.selection), bound = record(selection.target);
        assert(selection.mode === 'fixed' && selection.alternativeKey === 'composio:canva'); assert.deepEqual(selection.toolCap, [tool]);
        const expected = input.snapshot.bindings.find(binding => binding.connectionRefHash === hash(target.connectionRef)); assert(expected);
        assert(bound.kind === 'shared' && bound.source === 'composio' && bound.connectionRef === target.connectionRef && bound.bindingRevision === expected.bindingRevision);
      }
      const agents = (await client.query('SELECT scope_type,organization_id,created_by_user_id,workflow_version FROM agents WHERE agent_id=$1', [receipt.agentId])).rows;
      assert.equal(agents.length, 1); assert(agents[0].scope_type === 'organization' && agents[0].organization_id === input.organizationId
        && agents[0].created_by_user_id === input.actorId && Number(agents[0].workflow_version) === 1);
      const audits = (await client.query(`SELECT organization_id,user_id,session_id,agent_id,workspace_id,status,metadata_json
        FROM audit_events WHERE source='agent_tool' AND entity_type='integration_tool' AND action='integrations.call'
        AND agent_id=$1 ORDER BY created_at,id LIMIT 5`, [receipt.agentId])).rows;
      assert.equal(audits.length, 4);
      for (const [index, run] of receipt.runs.entries()) {
        assert(ID.test(run.actorId) && run.agentId === receipt.agentId && run.workspaceId === receipt.workspaceId && run.organizationId === input.organizationId
          && ID.test(run.sessionId) && SHA.test(run.authSessionHash) && SHA.test(run.transcriptSHA) && SHA.test(run.runtimeHash)
          && run.role === 'user' && run.businessCalls === 2 && run.effects.length === 2);
        assert.deepEqual(run.access, { canUse: true, canEdit: false, canManage: false });
        const modelArtifact = await evidenceJson(input.root, receipt, `user-${index + 1}-session-model.json`), sessionModel = modelArtifact.value;
        assert(modelArtifact.sha256 === run.runtimeHash && sessionModel.userId === run.actorId && sessionModel.sessionId === run.sessionId
          && sessionModel.agentId === receipt.agentId && sessionModel.workspaceId === receipt.workspaceId && sessionModel.organizationId === input.organizationId
          && sessionModel.providerInstallationId === receipt.model.installationId && sessionModel.providerId === 'ollama'
          && sessionModel.modelId === 'kimi-k2.6:cloud' && sessionModel.thinkingLevel === 'off' && sessionModel.credentialScope === 'organization'
          && sessionModel.status === 'ready' && ['app_default','session'].includes(String(sessionModel.selectionSource)));
        const readArtifact = (await evidenceJson(input.root, receipt, `user-${index + 1}-read-proof.json`)).value;
        assert.deepEqual(readArtifact, run);
        assertProtocol((await evidenceJson(input.root, receipt, `user-${index + 1}-protocol.json`)).value, run, receipt.targets);
        const members = (await client.query(`SELECT u.role,p.role AS organization_role,p.status AS organization_status,m.status AS membership_status,m.accepted_at
          FROM "user" u JOIN organization_user_permissions p ON p.user_id=u.id AND p.organization_id=$1
          JOIN team_memberships m ON m.user_id=u.id AND m.organization_id=$1 WHERE u.id=$2`, [input.organizationId, run.actorId])).rows;
        assert.equal(members.length, 1); assert(members[0].role === 'user' && members[0].organization_role === 'member'
          && members[0].organization_status === 'active' && members[0].membership_status === 'active' && members[0].accepted_at !== null);
        const grants = (await client.query(`SELECT can_use,can_edit,can_manage FROM agent_grants
          WHERE agent_id=$1 AND target_type='user' AND target_id=$2 AND organization_id=$3`, [receipt.agentId, run.actorId, input.organizationId])).rows;
        assert.equal(grants.length, 1); assert(flag(grants[0].can_use) && !flag(grants[0].can_edit) && !flag(grants[0].can_manage));
        assert.equal((await client.query('SELECT id FROM pi_sessions WHERE session_id=$1 AND user_id=$2', [run.sessionId, run.actorId])).rowCount, 0);
        assert.equal((await client.query('SELECT id FROM "session" WHERE user_id=$1 LIMIT 1', [run.actorId])).rowCount, 0);
        for (const effect of run.effects) {
          const matched = audits.filter(audit => {
            assert(typeof audit.metadata_json === 'string' && audit.metadata_json.length <= 4096); const metadata = record(JSON.parse(audit.metadata_json));
            return audit.organization_id === input.organizationId && audit.user_id === run.actorId && audit.session_id === run.sessionId
              && audit.agent_id === receipt.agentId && audit.workspace_id === receipt.workspaceId && audit.status === 'success'
              && metadata.version === 1 && metadata.action === 'call' && metadata.source === 'composio'
              && metadata.toolCallId === effect.toolCallId && metadata.toolRef === effect.toolRef && metadata.providerRef === effect.providerRef
              && metadata.schemaRef === undefined;
          });
          assert.equal(matched.length, 1);
          safeAudits.push({ actorIdHash: hash(run.actorId), sessionIdHash: hash(run.sessionId), scope: effect.scope,
            connectionRefHash: hash(effect.connectionRef), toolCallIdHash: hash(effect.toolCallId), toolRefHash: hash(effect.toolRef),
            providerRefHash: hash(effect.providerRef), schemaRefHash: hash(effect.schemaRef), inputSchemaSHA: effect.inputSchemaSHA, responseSHA: effect.responseSHA });
        }
      }
    });
    assert.equal(new Set(safeAudits.map(audit => canonical([audit.actorIdHash, audit.sessionIdHash, audit.toolCallIdHash]))).size, 4);
    const proof = { version: 1, nonce: input.nonce, browserReceiptSHA: hash(receiptBytes), auditCount: 4, calls: safeAudits,
      schemaRefObservedInCallAudit: false, schemaRefEvidence: 'authenticated-current-describe-and-submitted-request',
      modelEvidence: 'authenticated-safe-session-model-readback-before-normal-chat-delete',
      responseEvidence: 'browser-authenticated-provider-success-and-response-hash; independent-dispatcher-call-audits',
      rawExternalResponsePersisted: false, persistedAfterDeleteMessageClaim: false, snapshotSourceAdopted: false };
    await privateProof(input.root, 'live-composio-model-audit-proof.json', proof); return { auditCount: 4, proofSHA: hash(canonical(proof)) };
  } catch { throw new Error('The genuine Composio model workflow audit is unproven.'); }
}
