import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import YAML from 'yaml';
import { validateCreatorPluginManifest } from '../app/lib/plugins/creator-plugin-manifest';
import { parseSkillFile } from '../app/lib/skills/canvas-skill-manifest';
import { validateCreatorPluginSvg } from '../app/lib/capabilities/packages/creator-plugin-svg';
import { projectCapabilityPackageMcpTemplateConfig } from '../app/lib/capabilities/packages/mcp-template-projection';
import type { CapabilityPackageFileEntry } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityPackageSourceCapture } from '../app/lib/capabilities/packages/source-captures';
import { projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';

type Row = Record<string, unknown>;
type Entry = CapabilityPackageFileEntry & { bytes: Buffer; executable: boolean };
type CompletedPackageOperation = { result: Row; arguments: Row; callIndex: number; resultIndex: number };
type DocxUiExpectation = { checksum: string; fields: Array<{ path: 'interface.display_name' | 'interface.default_prompt';
  sourceText: string; targetText: string; sourceTextSha256: string; targetTextSha256: string }> };
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;
let stage = 'arguments';
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const record = (value: unknown): Row => { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; };
const decoded = (value: unknown): unknown => JSON.parse(text(value));
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = (value: string, prefix: string) => {
  assert.match(value, new RegExp(`^${prefix}:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$`, 'u'));
  return value.slice(prefix.length + 1);
};
function local(value: string): string {
  const normalized = value.replace(/^\.\//u, '');
  assert(normalized && !path.isAbsolute(normalized) && !/[\\\p{Cc}\p{Cf}]/u.test(normalized));
  assert(normalized.split('/').every(part => part && part !== '.' && part !== '..'));
  return normalized;
}
const packageHash = (files: readonly Entry[]) => {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) hash.update(file.path).update('\0').update(file.bytes).update('\0');
  return hash.digest('hex');
};

/** Independent, read-only inventory: deliberately does not use the product's temporary capture writer. */
async function inventory(root: string, dataRoot: string): Promise<Entry[]> {
  assert(root.startsWith(`${dataRoot}${path.sep}`));
  let ancestor = dataRoot;
  for (const segment of path.relative(dataRoot, root).split(path.sep)) {
    ancestor = path.join(ancestor, segment);
    const stat = await fs.lstat(ancestor); assert(stat.isDirectory() && !stat.isSymbolicLink());
  }
  const files: Entry[] = []; let total = 0, directories = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    assert(depth <= 32 && ++directories <= 2000, 'Package directory limit exceeded.');
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.DS_Store'].includes(item.name)) continue;
      const file = path.join(directory, item.name), relative = local(path.relative(root, file).split(path.sep).join('/'));
      const before = await fs.lstat(file, { bigint: true }); assert(!before.isSymbolicLink());
      if (before.isDirectory()) { await visit(file, depth + 1); continue; }
      assert(before.isFile() && before.nlink === BigInt(1) && before.size <= BigInt(32 * 1024 * 1024));
      assert(files.length < 2000 && total + Number(before.size) <= 250 * 1024 * 1024);
      assert(!/(?:^|\/)(?:\.env(?:\..*)?|Canvas-Secrets\.env|credentials\.json|auth\.json)$/iu.test(relative), 'Secret file bundled in package.');
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat({ bigint: true }); assert.equal(opened.ino, before.ino); assert.equal(opened.dev, before.dev);
        bytes = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); assert(read.bytesRead); offset += read.bytesRead; }
        assert.equal((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead, 0);
        const after = await handle.stat({ bigint: true });
        assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs); assert.equal(after.size, before.size);
      } finally { await handle.close(); }
      total += bytes.length; files.push({ path: relative, bytes, size: bytes.length, checksum: digest(bytes), executable: Boolean(before.mode & BigInt(0o111)) });
    }
  }
  await visit(root, 0); return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function one(database: PoolClient, sql: string, parameters: unknown[]): Promise<Row> {
  const rows = (await database.query<Row>(sql, parameters)).rows; assert.equal(rows.length, 1, 'Expected one exact fixture record.'); return rows[0];
}
function publishedRoot(dataRoot: string, resource: Row, version: Row): string {
  const scope = resource.ownership_type === 'organization' || resource.ownership_type === 'team'
    ? ['organizations', text(resource.organization_id)] : ['users', text(resource.owner_user_id)];
  assert(scope.every(part => part && !/[\\/]/u.test(part)));
  return path.join(dataRoot, ...scope, 'capability-packages', 'published', uuid(text(version.resource_ref), 'canvas-resource'),
    uuid(text(version.revision_ref), 'canvas-package-revision'), local(text(version.name)));
}
function verifyInventory(files: Entry[], version: Row): void {
  assert.equal(packageHash(files), version.checksum, 'Filesystem package checksum differs from its immutable SQL version.');
  const expected = decoded(version.files) as CapabilityPackageFileEntry[];
  assert.deepEqual(files.map(({ path, size, checksum }) => ({ path, size, checksum })),
    expected.map(({ path, size, checksum }) => ({ path, size, checksum })).sort((left, right) => left.path.localeCompare(right.path)));
  assert.equal(files.reduce((sum, file) => sum + file.size, 0), Number(version.total_bytes));
}

async function readDocxUiExpectation(file: string): Promise<DocxUiExpectation> {
  const handle = await fs.open(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assert(before.isFile() && before.nlink === BigInt(1) && before.size <= BigInt(16 * 1024) && (before.mode & BigInt(0o077)) === BigInt(0)
      && (!process.getuid || before.uid === BigInt(process.getuid())));
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); assert(read.bytesRead); offset += read.bytesRead; }
    assert.equal((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead, 0);
    const after = await handle.stat({ bigint: true });
    assert(before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs);
    const value = record(JSON.parse(bytes.toString('utf8')));
    assert.deepEqual(Object.keys(value).sort(), ['fields', 'schemaVersion']); assert.equal(value.schemaVersion, 1);
    assert(Array.isArray(value.fields) && value.fields.length === 2);
    const fields = value.fields.map(value => {
      const field = record(value);
      assert.deepEqual(Object.keys(field).sort(), ['path', 'sourceText', 'sourceTextSha256', 'targetText', 'targetTextSha256']);
      assert(field.path === 'interface.display_name' || field.path === 'interface.default_prompt');
      const sourceText = text(field.sourceText), targetText = text(field.targetText);
      assert(sourceText.length > 0 && sourceText.length <= 1500 && targetText.length > 0 && targetText.length <= 1500);
      assert.equal(digest(sourceText), field.sourceTextSha256); assert.equal(digest(targetText), field.targetTextSha256);
      return { path: field.path as 'interface.display_name' | 'interface.default_prompt', sourceText, targetText,
        sourceTextSha256: text(field.sourceTextSha256), targetTextSha256: text(field.targetTextSha256) };
    });
    assert.equal(new Set(fields.map(field => field.path)).size, 2);
    return { checksum: digest(bytes), fields };
  } finally { await handle.close(); }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    nonce: { type: 'string' }, 'session-id': { type: 'string' }, 'origin-session-id': { type: 'string' },
    'authoring-session-id': { type: 'string' }, 'package-name': { type: 'string' },
    'resource-ref': { type: 'string' }, 'revision-ref': { type: 'string' }, checksum: { type: 'string' },
    'prior-revision-ref': { type: 'string' }, 'prior-checksum': { type: 'string' },
    'api-evidence': { type: 'string' }, 'agent-id': { type: 'string' }, output: { type: 'string' },
    'docx-skill': { type: 'string', default: 'docx-export' }, 'docx-version': { type: 'string', default: '1.2.1' },
    'docx-ui-fixture': { type: 'string' },
    'new-skill': { type: 'string', default: 'account-brief' },
    'require-provisioned': { type: 'boolean', default: false }, help: { type: 'boolean' },
  }, strict: true });
  if (values.help) {
    console.info('Read-only P7 evidence: --nonce <fixture-marker> --session-id <actual-session> [--origin-session-id <actual-before-host-OOM-session>] [--authoring-session-id <actual intermediate V1 publication session>] --package-name <nonce-name> --resource-ref <exact-ref> --revision-ref <exact-revision> --checksum <sha256> [--prior-revision-ref <exact initial publication> --prior-checksum <sha256>] [--docx-version <strict semver; default 1.2.1>] [--docx-ui-fixture <private JSON: exact source/target display_name and default_prompt values with UTF-8 hashes>] [--api-evidence <JSON>] [--agent-id <actual-agent>] [--require-provisioned] [--output <JSON>]. A prior pin enables strict two-version natural creation followed by operator-guided workflow correction; both immutable inventories and the actual edit lineage are checked. An intermediate authoring session requires the origin and both prior fields; all three sessions must share the exact actor/workspace and independently paired draft/pin lineage. DATABASE_URL and DATA must already be supplied by the caller; no env or credential files are loaded.'); return;
  }
  assert(values.nonce && /^[a-z0-9][a-z0-9-]{7,100}$/u.test(values.nonce), 'One explicit fixture nonce is required.');
  const nonce = values.nonce;
  assert(values['docx-version'].length <= 128 && SEMVER.test(values['docx-version']) && values['docx-version'] !== '1.2.0', 'Choose one explicit valid independent DOCX version.');
  assert(values['package-name']?.includes(values.nonce), 'The exact package name must contain the fixture nonce.');
  assert(values['session-id'] && values['resource-ref'] && values['revision-ref'] && values.checksum);
  assert.match(values.checksum, /^[a-f0-9]{64}$/u);
  const correction = values['prior-revision-ref'] !== undefined || values['prior-checksum'] !== undefined;
  if (correction) {
    assert(values['prior-revision-ref'] && values['prior-checksum'], 'Both exact prior pin fields are required together.');
    uuid(values['prior-revision-ref'], 'canvas-package-revision');
    assert.match(values['prior-checksum'], /^[a-f0-9]{64}$/u);
    assert.notEqual(values['prior-revision-ref'], values['revision-ref']);
    assert.notEqual(values['prior-checksum'], values.checksum);
  }
  if(values['authoring-session-id']) assert(values['origin-session-id']&&correction,'An explicit intermediate authoring session requires the origin session and complete prior pin.');
  const docxUiExpectation = values['docx-ui-fixture'] ? await readDocxUiExpectation(values['docx-ui-fixture']) : null;
  stage = 'database-scope';
  const connection = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1'].includes(connection.hostname) && connection.port === '55433', 'Only the existing local managed PostgreSQL is allowed.');
  assert(process.env.DATA || process.env.CANVAS_DATA_ROOT, 'An explicit managed DATA root is required.');
  const dataRoot = await fs.realpath(path.resolve(process.env.CANVAS_DATA_ROOT || process.env.DATA!));
  const pool = new Pool({ connectionString: connection.toString(), max: 1, application_name: 'creator-p7-readonly-evidence',
    options: '-c default_transaction_read_only=on -c statement_timeout=15000' });
  const database = await pool.connect();
  try {
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    stage = 'sessions';
    const session = await one(database, 'SELECT id,session_id,user_id,agent_id,organization_id,workspace_id,title,provider,model,runtime_provider_installation_id,runtime_selection_source,created_at FROM pi_sessions WHERE session_id=$1', [values['session-id']]);
    const messages = (await database.query<Row>('SELECT role,content,sequence FROM pi_messages WHERE pi_session_db_id=$1 ORDER BY sequence,id LIMIT 2001', [session.id])).rows;
    assert(messages.length <= 2000);
    const parsedMessages = messages.map(message => record(decoded(message.content)));
    const admissions = (await database.query<Row>(`SELECT client_message_id,execution_phase,private_payload::jsonb->'message' AS message,
      private_payload::jsonb->>'serverMessageId' AS server_message_id,private_payload::jsonb->'body' AS body,
      private_payload::jsonb->'extensionSelection'->'publicSelection' AS selection
      FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1 AND payload_version=1`, [session.id])).rows;
    const originSession = values['origin-session-id'] ? await one(database,
      'SELECT id,session_id,user_id,agent_id,organization_id,workspace_id,title,provider,model,runtime_provider_installation_id,runtime_selection_source FROM pi_sessions WHERE session_id=$1', [values['origin-session-id']]) : null;
    const originMessages = originSession ? (await database.query<Row>('SELECT role,content,sequence FROM pi_messages WHERE pi_session_db_id=$1 ORDER BY sequence,id LIMIT 2001', [originSession.id])).rows : [];
    assert(originMessages.length <= 2000);
    const parsedOriginMessages = originMessages.map(message => record(decoded(message.content)));
    const originAdmissions = originSession ? (await database.query<Row>(`SELECT execution_phase,private_payload::jsonb->'extensionSelection'->'publicSelection' AS selection
      FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1 AND payload_version=1`, [originSession.id])).rows : [];
    const authoringSession = values['authoring-session-id'] ? await one(database,
      'SELECT id,session_id,user_id,agent_id,organization_id,workspace_id,title FROM pi_sessions WHERE session_id=$1', [values['authoring-session-id']]) : null;
    const authoringMessages = authoringSession ? (await database.query<Row>('SELECT role,content,sequence FROM pi_messages WHERE pi_session_db_id=$1 ORDER BY sequence,id LIMIT 2001',[authoringSession.id])).rows : [];
    assert(authoringMessages.length<=2000);
    const parsedAuthoringMessages = authoringMessages.map(message=>record(decoded(message.content)));
    const authoringAdmissions = authoringSession ? (await database.query<Row>(`SELECT execution_phase,private_payload::jsonb->'extensionSelection'->'publicSelection' AS selection
      FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1 AND payload_version=1`,[authoringSession.id])).rows : [];
    if (originSession) {
      assert(Number(originSession.id) < Number(session.id), 'The recovery origin must be a distinct earlier actual session.');
      assert(text(session.user_id) && text(session.workspace_id) && text(session.organization_id) && text(session.agent_id));
      for (const field of ['user_id', 'workspace_id', 'organization_id', 'agent_id']) assert.equal(originSession[field], session[field]);
      assert(text(originSession.title ?? '').includes(nonce) || parsedOriginMessages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(nonce)), 'The actual origin session must carry this fixture marker.');
    }
    if(authoringSession) {
      assert(originSession&&Number(originSession.id)<Number(authoringSession.id)&&Number(authoringSession.id)<Number(session.id),'Three explicitly chosen actual sessions must be distinct and chronological.');
      for(const field of ['user_id','workspace_id','organization_id','agent_id']) assert.equal(authoringSession[field],session[field]);
      assert(text(authoringSession.title??'').includes(nonce)||parsedAuthoringMessages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes(nonce)));
    }
    const creatorReference = (rows: Row[]) => rows.some(admission => {
      const selection = admission.selection == null ? null : record(admission.selection);
      return selection && Array.isArray(selection.selections) && selection.selections.some(entry => {
        const chosen = record(record(entry).selection);
        return chosen.kind === 'core_plugin' && record(chosen.coreSource).resourceRef === 'canvas-capability:v1:plugin:system:core:plugin-creator';
      });
    });
    const acceptedCreatorReference = creatorReference(admissions) && (!originSession || creatorReference(originAdmissions))
      && (!authoringSession || creatorReference(authoringAdmissions));
    assert(text(session.title ?? '').includes(nonce) || parsedMessages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(nonce)), 'Session does not carry the explicit fixture marker.');
    const resource = await one(database, 'SELECT * FROM capability_resources WHERE resource_ref=$1 AND artifact_name=$2 AND organization_id=$3', [values['resource-ref'], values['package-name'], session.organization_id]);
    assert.equal(resource.ownership_type, 'organization'); assert.equal(resource.resource_type, 'plugin'); assert.equal(resource.status, 'active');
    const versions = (await database.query<Row>('SELECT * FROM capability_package_versions WHERE resource_ref=$1 ORDER BY published_at,revision_ref', [values['resource-ref']])).rows;
    assert.equal(versions.length, correction ? 2 : 1, 'The explicit publication sequence must contain exactly the expected immutable versions.');
    const version = versions[correction ? 1 : 0]; assert.equal(version.revision_ref, values['revision-ref']); assert.equal(version.checksum, values.checksum);
    const priorVersion = correction ? versions[0] : null;
    if (priorVersion) {
      assert.equal(priorVersion.revision_ref, values['prior-revision-ref']); assert.equal(priorVersion.checksum, values['prior-checksum']);
      assert.equal(priorVersion.published_by_user_id, session.user_id);
      assert(Number(priorVersion.published_at) <= Number(version.published_at));
      if(authoringSession) assert(Number(priorVersion.published_at)<=Number(session.created_at),'The repair chat must follow the actual initial publication.');
      assert.equal(version.base_revision_ref, priorVersion.revision_ref); assert.equal(version.source_resource_ref, resource.resource_ref);
      assert.equal(version.source_revision_ref, priorVersion.revision_ref); assert.equal(version.source_checksum, priorVersion.checksum);
      const stamp = record(decoded(version.source_stamp));
      assert.equal(stamp.resourceId, resource.legacy_resource_id); assert.equal(stamp.kind, 'plugin'); assert.equal(stamp.name, priorVersion.name);
      assert.equal(stamp.version, priorVersion.version); assert.equal(stamp.checksum, priorVersion.checksum); assert.equal(stamp.registryChecksum, priorVersion.checksum);
      assert.equal(stamp.sourcePluginId, null);
    }
    assert.equal(version.published_by_user_id, session.user_id);
    const initialVersion = priorVersion ?? version;
    for (const field of ['base_revision_ref','source_resource_ref','source_revision_ref','source_checksum','source_stamp']) {
      assert.equal(initialVersion[field], null, 'The initial package retains its complete source-free origin; child lineage is separate.');
    }
    const state = await one(database, 'SELECT * FROM capability_package_states WHERE resource_ref=$1', [resource.resource_ref]);
    assert.equal(state.current_published_revision_ref, version.revision_ref);
    assert.equal(Number(state.package_revision), versions.length);
    const currentStamp = record(decoded(state.current_source_stamp));
    assert.equal(currentStamp.resourceId, resource.legacy_resource_id); assert.equal(currentStamp.checksum, version.checksum);
    assert.equal(currentStamp.registryChecksum, version.checksum); assert.equal(currentStamp.version, version.version);
    assert.equal(currentStamp.kind,'plugin');assert.equal(currentStamp.name,resource.artifact_name);assert.equal(currentStamp.sourcePluginId,null);
    const checkedVersions = [];
    for (const version of versions) {
      stage = 'published-inventory';
      const root = publishedRoot(dataRoot, resource, version), files = await inventory(root, dataRoot), byPath = new Map(files.map(file => [file.path, file]));
      verifyInventory(files, version);
      const manifestResult = validateCreatorPluginManifest(byPath.get('.canvas-plugin/plugin.json')!.bytes.toString('utf8'));
      assert(manifestResult.valid && manifestResult.manifest, JSON.stringify(manifestResult.issues));
      const manifest = manifestResult.manifest; assert.equal(manifest.name, values['package-name']); assert.equal(manifest.version, version.version);
      const logoPath = local(manifest.interface.logo), logo = byPath.get(logoPath); assert(logo);
      assert.deepEqual(validateCreatorPluginSvg(logo.bytes, logoPath), [], 'The actual purpose SVG must satisfy the production passive XML validator.');
      assert(manifest.connectors?.composio?.some(item => item.toolkit === 'hubspot'));
      assert(manifest.connectors?.mcp?.some(item => item.name === 'company-research'));
      for (const connector of manifest.connectors?.mcp ?? []) if (connector.configPath) {
        const config = byPath.get(local(connector.configPath)); assert(config);
        assert.deepEqual(projectCapabilityPackageMcpTemplateConfig(record(JSON.parse(config.bytes.toString('utf8'))), connector.name).redactedFields, []);
      }
      const skillRoot = manifest.skills === '.' ? '' : local(manifest.skills);
      const skillPaths = byPath.has(`${skillRoot ? `${skillRoot}/` : ''}SKILL.md`) ? [`${skillRoot ? `${skillRoot}/` : ''}SKILL.md`]
        : files.filter(file => path.posix.basename(file.path) === 'SKILL.md' && path.posix.dirname(path.posix.dirname(file.path)) === skillRoot).map(file => file.path);
      const skills = []; let suppressedParserDiagnostics = 0;
      const workflowCapabilities: Row[] = [];
      const declaration = (value: unknown) => {
        if (!value) return;
        const capabilities = record(value).integrationCapabilities;
        if (Array.isArray(capabilities)) workflowCapabilities.push(...capabilities.map(record));
      };
      declaration(manifest.workflow);
      for (const relative of skillPaths) {
        // Parser errors may contain raw YAML excerpts. Keep only a count in this standalone verifier.
        const diagnostics = { warn: console.warn, error: console.error };
        let skill: Awaited<ReturnType<typeof parseSkillFile>>;
        try {
          console.warn = console.error = () => { suppressedParserDiagnostics++; };
          skill = await parseSkillFile(path.join(root, relative), { validateDirectoryName: relative !== 'SKILL.md' });
        } finally { console.warn = diagnostics.warn; console.error = diagnostics.error; }
        assert(skill?.version && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(skill.version));
        declaration(skill.workflow);
        skills.push({ name: skill.name, version: skill.version, root: path.posix.dirname(relative) });
      }
      assert(skills.some(skill => skill.name === values['new-skill'])); assert(skills.some(skill => skill.name === values['docx-skill']));
      stage = 'source-capture';
      // Edits retain their exact source revision; historical captures remain attached to the initial publication.
      const captureRows = (await database.query<Row>('SELECT capture_json FROM capability_package_source_captures WHERE target_resource_ref=$1 AND published_revision_ref=$2 AND actor_user_id=$3 ORDER BY capture_ref', [resource.resource_ref, initialVersion.revision_ref, session.user_id])).rows;
      const captures = captureRows.map(row => decoded(row.capture_json) as CapabilityPackageSourceCapture);
      const docx = captures.find(capture => capture.source === 'package' && capture.targetName === values['docx-skill']);
      assert(docx?.source === 'package' && docx.revisionRef, 'DOCX must have a persisted exact immutable source capture.');
      const sourceVersion = await one(database, 'SELECT * FROM capability_package_versions WHERE revision_ref=$1', [docx.revisionRef]);
      const sourceResource = await one(database, 'SELECT * FROM capability_resources WHERE resource_ref=$1 AND organization_id=$2', [sourceVersion.resource_ref, session.organization_id]);
      const sourceFiles = await inventory(publishedRoot(dataRoot, sourceResource, sourceVersion), dataRoot);
      verifyInventory(sourceFiles, sourceVersion);
      const upstream = record(record(decoded(sourceVersion.source_stamp)).storeOrigin);
      assert.equal(upstream.registryId, 'canvas-official'); assert.equal(upstream.entryKey, 'document-suite'); assert.equal(upstream.version, '1.4.0');
      assert.equal(upstream.relation, 'installed'); assert.equal(upstream.upstreamChecksum, 'f1e48ededc2346a541130f08a15a74f9b1ff9463dbda8d103263c1530af486d0');
      assert.equal(sourceVersion.checksum, upstream.upstreamChecksum, 'The exact installed source must match the selected official offering.');
      assert.equal(packageHash(sourceFiles), docx.parentChecksum ?? docx.checksum);
      const sourceChild = sourceFiles.filter(file => file.path.startsWith(`${docx.childRelativeRoot}/`))
        .map(file => ({ ...file, path: file.path.slice(docx.childRelativeRoot.length + 1) }));
      assert.deepEqual(sourceChild.map(file=>file.path), ['agents/canvas.yaml','SKILL.md'].sort((left,right)=>left.localeCompare(right)));
      assert.equal(packageHash(sourceChild), docx.selectedChildChecksum);
      const currentDocxVersion = skills.find(skill => skill.name === docx.targetName)?.version;
      assert.equal(currentDocxVersion, values['docx-version'], 'The published DOCX child must have the explicitly configured independent version.');
      const changedDocxFiles: string[] = [];
      for (const original of sourceChild) {
        const target = byPath.get(`${docx.targetRelativeRoot}/${original.path}`); assert(target, `Copied DOCX resource missing: ${original.path}`);
        assert.equal(target.executable, original.executable, `Copied DOCX executable mode changed: ${original.path}`);
        if (target.checksum !== original.checksum) {
          assert(docx.changes.length && (original.path === 'SKILL.md' || original.path === 'agents/canvas.yaml'), `Undocumented copied DOCX resource change: ${original.path}`);
          changedDocxFiles.push(original.path);
        }
        if(original.path==='SKILL.md') {
          const parts=(bytes:Buffer)=>{const value=bytes.toString('utf8'),frontmatter=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(value);assert(frontmatter);
            return {frontmatter:record(YAML.parse(frontmatter[1],{maxAliasCount:0})),body:value.slice(frontmatter[0].length)};};
          const sourceParts=parts(original.bytes),targetParts=parts(target.bytes);
          assert.equal(targetParts.body,sourceParts.body,'The complete Marketplace DOCX instructions must survive rename/version changes byte-for-byte.');
          assert.equal(record(sourceParts.frontmatter.metadata).version, docx.version);
          assert.equal(record(targetParts.frontmatter.metadata).version, currentDocxVersion);
          delete sourceParts.frontmatter.name;delete targetParts.frontmatter.name;
          delete record(sourceParts.frontmatter.metadata).version;delete record(targetParts.frontmatter.metadata).version;
          assert.deepEqual(targetParts.frontmatter,sourceParts.frontmatter,'Copied DOCX frontmatter may change only its explicit name and independent version.');
        } else if(original.path==='agents/canvas.yaml') {
          const normalized=(bytes:Buffer,version:string,rename:boolean)=>{
            const document=record(YAML.parse(bytes.toString('utf8'),{maxAliasCount:0}));
            if (docxUiExpectation) for (const field of docxUiExpectation.fields) {
              const iface = record(document.interface), key = field.path.slice('interface.'.length), value = text(iface[key]);
              assert.equal(value, rename ? field.targetText : field.sourceText);
              assert.equal(digest(value), rename ? field.targetTextSha256 : field.sourceTextSha256);
              delete iface[key];
            }
            for(const key of ['skill','package','metadata','interface']) if(document[key] && typeof document[key]==='object') {
              const value=record(document[key]);if(typeof value.version==='string'){assert.equal(value.version,version);delete value.version;}
              if(key==='interface' && rename) for(const prompt of ['default_prompt','defaultPrompt']) if(typeof value[prompt]==='string') value[prompt]=value[prompt].replaceAll(docx.targetName,docx.name);
              if(Object.keys(value).length===0) delete document[key];
            }
            if(typeof document.version==='string'){assert.equal(document.version,version);delete document.version;}return document;
          };
          assert.deepEqual(normalized(target.bytes,currentDocxVersion!,true),normalized(original.bytes,docx.version,false),
            'Copied DOCX interface must preserve all fields except versions and explicitly checked UI metadata.');
        }
      }
      assert.equal(docx.parentVersion, '1.4.0'); assert.equal(docx.version, '1.2.0');
      if (originSession) {
        assert.match(docx.targetVersion, SEMVER);
        assert.notEqual(docx.targetVersion, docx.version, 'The renamed child retained its distinct version at capture.');
      } else assert.equal(docx.targetVersion, currentDocxVersion);
      const parentLicense = sourceFiles.find(file => /^LICENSE(?:\.[a-z]+)?$/u.test(file.path)); assert(parentLicense, 'Document Suite parent license must be present.');
      assert.equal(parentLicense.checksum, '3a9b3ffc15c7f9e77391c78bae99c239d2f6e3d9d06c7f020d6efd06641b2fdf');
      assert.equal(byPath.get(parentLicense.path)?.checksum, parentLicense.checksum, 'Parent license bytes must survive complete composition.');
      const attribution = byPath.get(`licenses/${docx.targetName}/source-plugin.json`); assert(attribution);
      const parentAttribution = record(JSON.parse(attribution.bytes.toString('utf8'))); assert.equal(parentAttribution.version, docx.parentVersion); assert.equal(parentAttribution.license, 'MIT');
      const alternatives = workflowCapabilities.flatMap(capability => Array.isArray(capability.alternatives) ? capability.alternatives.map(record) : []);
      const workflow = { capabilityCount: workflowCapabilities.length,
        hubspot: alternatives.some(alternative => alternative.source === 'composio' && alternative.toolkit === 'hubspot'),
        research: alternatives.some(alternative => alternative.source === 'mcp' && alternative.connector === 'company-research') };
      checkedVersions.push({ version, files, manifest, skills, logoPath, logo, docx, captureRows, captures, currentDocxVersion,
        sourceVersion, sourceChild, changedDocxFiles, workflow, suppressedParserDiagnostics });
    }
    const checked = checkedVersions.find(checked => checked.version.revision_ref === version.revision_ref)!;
    const { files, manifest, skills, logoPath, logo, docx, captureRows, captures, currentDocxVersion,
      sourceVersion, sourceChild, changedDocxFiles, workflow } = checked;
    const suppressedParserDiagnostics = checkedVersions.reduce((sum,checked)=>sum+checked.suppressedParserDiagnostics,0);
    assert(workflow.hubspot && workflow.research, 'The final publication must declare actual bindable HubSpot and research workflow capabilities.');
    stage = 'operation-evidence';
    const operations = (await database.query<Row>('SELECT operation,status,draft_ref,draft_revision,published_revision_ref,request_id,result FROM capability_package_operations WHERE resource_ref=$1 AND actor_user_id=$2 ORDER BY created_at', [resource.resource_ref, session.user_id])).rows;
    assert.equal(operations.filter(operation => operation.operation === 'create').length, 1);
    assert.equal(operations.filter(operation => operation.operation === 'publish' && operation.status === 'published').length, correction ? 2 : 1);
    if (!correction) assert.equal((await database.query('SELECT 1 FROM capability_package_drafts WHERE resource_ref=$1 AND actor_user_id=$2', [resource.resource_ref, session.user_id])).rowCount, 0, 'Published draft must be consumed.');
    const grants = (await database.query<Row>('SELECT target_type,target_id,can_use,can_edit,can_manage FROM capability_resource_grants WHERE resource_ref=$1 ORDER BY target_type,target_id', [resource.resource_ref])).rows;
    assert(grants.every(grant => !grant.can_edit && !grant.can_manage), 'Explicit provisioning grants Use only.');
    const toolCalls = parsedMessages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part?.type === 'toolCall').map(part => record(part)) : []);
    const callOperations = toolCalls.map(call => ({ name: text(call.name), arguments: record(call.arguments ?? {}) }))
      .map(call => ({ tool: call.name, operation: typeof call.arguments.operation === 'string' ? call.arguments.operation : call.name, action: call.arguments.action }));
    const runs = [{ sessionId: text(session.session_id), messages: parsedMessages },
      ...(originSession ? [{ sessionId: text(originSession.session_id), messages: parsedOriginMessages }] : []),
      ...(authoringSession ? [{sessionId:text(authoringSession.session_id),messages:parsedAuthoringMessages}] : [])];
    // Pair in chronological windows within one session; toolCallIds may restart across turns too.
    const completedRuns = runs.map(run => {
      const completed = new Map<string, CompletedPackageOperation[]>();
      const calls = run.messages.flatMap((message,messageIndex) => Array.isArray(message.content)
        ? message.content.filter(part => part?.type === 'toolCall').map(part => ({call:record(part),messageIndex})) : []);
      for (const [callPosition, entry] of calls.entries()) {
        const {call,messageIndex:callIndex}=entry;
        const nextSameId=calls.slice(callPosition+1).find(entry=>entry.call.id===call.id)?.messageIndex ?? Infinity;
        const args = record(call.arguments ?? {});
        if (call.name === 'canvas_extensions' && args.action !== 'call') continue;
        const operation = call.name === 'canvas_extensions' ? args.operation : call.name;
        if (typeof operation !== 'string') continue;
        for (const [resultIndex,message] of run.messages.entries()) {
          if(resultIndex<=callIndex || resultIndex>=nextSameId) continue;
          if (message.role !== 'toolResult' || message.toolCallId !== call.id || message.isError === true) continue;
          const details = record(message.details ?? {});
          if (details.error || details.errorDetails || !details.capabilityPackage) continue;
          const completion = record(details.capabilityPackage);
          if (completion.operation !== operation || !completion.result) continue;
          const result = record(completion.result);
          if (result.error || result.success === false) continue;
          completed.set(operation, [...(completed.get(operation) ?? []), { result, arguments: record(args.arguments ?? args),callIndex,resultIndex }]);
        }
      }
      return { sessionId: run.sessionId, completed };
    });
    const completedOperations = completedRuns[0].completed;
    const originalOperations = originSession ? completedRuns[1].completed : completedOperations;
    const authoringOperations = authoringSession ? completedRuns.find(run=>run.sessionId===authoringSession.session_id)!.completed : completedOperations;
    const initialMessages = authoringSession ? parsedAuthoringMessages : parsedMessages;
    const continuousDraftRef = text(operations.find(operation => operation.operation === 'create')!.draft_ref);
    if (originSession) {
      if(!correction) assert(operations.every(operation => operation.draft_ref === continuousDraftRef), 'Recovery must retain the original actor-private draft receipt.');
      const sameDraftResume = initialMessages.some(message => {
        if (message.role !== 'user') return false;
        const content = JSON.stringify(message.content);
        return content.includes(continuousDraftRef) && content.includes(text(resource.artifact_name))
          && (content.includes('Setze meinen Plugin-Entwurf') || content.includes('Continue my plugin draft'));
      });
      assert(sameDraftResume, 'The accepted continuation must carry the normal explicit same-draft Creator resume context.');
      for (const [operation, completed] of [
        ['create_canvas_package_draft', originalOperations], ['compose_canvas_package_skills', originalOperations],
        ['write_canvas_package_draft_file', authoringOperations], ['validate_canvas_package_draft', authoringOperations],
        ['publish_canvas_package_draft', authoringOperations],
      ] as const) {
        assert(completed.get(operation)?.some(({ arguments: args, result }) => {
          if (operation === 'create_canvas_package_draft') return args.operation === 'create' && args.kind === 'plugin'
            && args.targetName === resource.artifact_name && result.draftRef === continuousDraftRef && result.resourceRef === resource.resource_ref;
          if (args.draftRef !== continuousDraftRef) return false;
          if (operation === 'publish_canvas_package_draft') return record(result.state ?? {}).resourceRef === resource.resource_ref
            && record(result.published ?? {}).resourceRef === resource.resource_ref
            && record(result.published ?? {}).revisionRef === initialVersion.revision_ref && record(result.published ?? {}).checksum === initialVersion.checksum;
          const draft = record(result.draft ?? {});
          return draft.draftRef === continuousDraftRef && draft.resourceRef === resource.resource_ref
            && (operation !== 'validate_canvas_package_draft' || record(result.validation ?? {}).valid === true);
        }), 'Recovery operations must pair successfully with the same actual draft and resource in the correct session.');
      }
      assert(originalOperations.get('compose_canvas_package_skills')?.some(({ arguments: args, result }) => {
        const draft = record(result.draft ?? {});
        if (args.draftRef !== continuousDraftRef || draft.draftRef !== continuousDraftRef || draft.resourceRef !== resource.resource_ref) return false;
        const composition = record(result.composition ?? {});
        return Array.isArray(composition.skills) && composition.skills.some(value => {
          const captured = record(value);
          return captured.name === docx.targetName && captured.version === docx.targetVersion
            && captured.relativeRoot === docx.targetRelativeRoot && captured.sourceResourceRef === docx.resourceRef
            && captured.sourceRevisionRef === docx.revisionRef && captured.selectedChildChecksum === docx.selectedChildChecksum
            && captured.parentChecksum === docx.parentChecksum && JSON.stringify(captured.changes) === JSON.stringify(docx.changes);
        });
      }), 'Persisted historical capture facts must match the actual original successful Compose result.');
    }
    let correctionEvidence: Row | null = null;
    if(priorVersion) {
      stage='correction-lineage';
      const createReceipt=operations.find(operation=>operation.operation==='create')!;
      assert.equal(createReceipt.status,'published'); assert.equal(createReceipt.published_revision_ref,priorVersion.revision_ref);
      const initialReceipt=operations.find(operation=>operation.operation==='publish'&&operation.published_revision_ref===priorVersion.revision_ref);
      const finalReceipt=operations.find(operation=>operation.operation==='publish'&&operation.published_revision_ref===version.revision_ref);
      assert(initialReceipt&&finalReceipt); assert.equal(initialReceipt.draft_ref,continuousDraftRef);
      const editDraftRef=text(finalReceipt.draft_ref);uuid(editDraftRef,'canvas-package-draft');assert.notEqual(editDraftRef,continuousDraftRef);
      for(const draftRef of [continuousDraftRef,editDraftRef]) assert.equal((await database.query('SELECT 1 FROM capability_package_drafts WHERE draft_ref=$1',[draftRef])).rowCount,0,'The exact published draft must be consumed.');
      const initialPublish=authoringOperations.get('publish_canvas_package_draft')?.find(({arguments:args,result})=>args.draftRef===continuousDraftRef
        &&record(result.published??{}).resourceRef===resource.resource_ref&&record(result.published??{}).revisionRef===priorVersion.revision_ref
        &&record(result.published??{}).checksum===priorVersion.checksum);
      const finalPublish=completedOperations.get('publish_canvas_package_draft')?.find(({arguments:args,result})=>args.draftRef===editDraftRef
        &&record(result.published??{}).resourceRef===resource.resource_ref&&record(result.published??{}).revisionRef===version.revision_ref
        &&record(result.published??{}).checksum===version.checksum);
      assert(initialPublish&&finalPublish,'Both explicit publication pins need their own successful paired result.');
      assert.equal(initialPublish.arguments.expectedPackageRevision,0);assert.equal(initialPublish.arguments.expectedPublishedRevisionRef,null);
      assert.equal(finalPublish.arguments.expectedPackageRevision,1);assert.equal(finalPublish.arguments.expectedPublishedRevisionRef,priorVersion.revision_ref);
      for(const [receipt,publish,published] of [[initialReceipt,initialPublish,priorVersion],[finalReceipt,finalPublish,version]] as const) {
        assert.equal(Number(receipt.draft_revision),publish.arguments.expectedDraftRevision);assert.equal(receipt.request_id,publish.arguments.requestId??null);
        const saved=record(decoded(receipt.result)),pin=record(saved.published);
        assert.equal(pin.resourceRef,resource.resource_ref);assert.equal(pin.revisionRef,published.revision_ref);assert.equal(pin.checksum,published.checksum);
        assert.equal(record(saved.state).currentPublishedRevisionRef,published.revision_ref);
        if(published===version) {
          assert.deepEqual(record(saved.state).currentSourceStamp,currentStamp);
          assert.deepEqual(record(publish.result.state).currentSourceStamp,currentStamp);
        }
      }
      assert.equal(Number(createReceipt.draft_revision),initialPublish.arguments.expectedDraftRevision);
      const edit=completedOperations.get('create_canvas_package_draft')?.find(({arguments:args,result})=>args.operation==='edit'
        &&args.resourceRef===resource.resource_ref&&result.operation==='edit'&&result.draftRef===editDraftRef&&result.resourceRef===resource.resource_ref);
      assert(edit,'The corrected publication must come from an actual normal Edit result.');
      assert((authoringSession||edit.callIndex>initialPublish.resultIndex)&&finalPublish.callIndex>edit.resultIndex,'Correction must follow the initial successful publication and Edit.');
      assert.equal(edit.arguments.expectedPackageRevision,1);assert.equal(edit.arguments.expectedPublishedRevisionRef,priorVersion.revision_ref);
      assert.equal(edit.result.actorUserId,session.user_id);assert.equal(edit.result.basePackageRevision,1);assert.equal(edit.result.sourcePackageRevision,1);
      assert.equal(edit.result.basePublishedRevisionRef,priorVersion.revision_ref);assert.equal(edit.result.sourcePublishedRevisionRef,priorVersion.revision_ref);
      assert.equal(edit.result.sourceResourceRef,resource.resource_ref);
      assert.deepEqual(edit.result.baseSourceStamp,decoded(version.source_stamp));
      if(authoringSession) {
        assert(completedOperations.get('inspect_canvas_package')?.some(({arguments:args,result,resultIndex})=>args.resourceRef===resource.resource_ref
          &&record(result.published??{}).resourceRef===resource.resource_ref&&record(result.published??{}).revisionRef===priorVersion.revision_ref
          &&record(result.published??{}).checksum===priorVersion.checksum&&resultIndex<edit.callIndex),'The explicit repair chat must inspect the exact actual V1 before Edit.');
      }
      for(const [draftRef,begin,end] of [[continuousDraftRef,-1,initialPublish.callIndex],[editDraftRef,edit.resultIndex,finalPublish.callIndex]] as const) {
        const completed=draftRef===continuousDraftRef?authoringOperations:completedOperations;
        const writes=completed.get('write_canvas_package_draft_file')?.filter(({arguments:args,result,callIndex,resultIndex})=>args.draftRef===draftRef
          &&record(result.draft??{}).draftRef===draftRef&&record(result.draft??{}).resourceRef===resource.resource_ref&&callIndex>begin&&resultIndex<end)??[];
        const validations=completed.get('validate_canvas_package_draft')?.filter(({arguments:args,result,callIndex,resultIndex})=>args.draftRef===draftRef
          &&record(result.draft??{}).draftRef===draftRef&&record(result.draft??{}).resourceRef===resource.resource_ref
          &&record(result.validation??{}).valid===true&&callIndex>begin&&resultIndex<end)??[];
        assert(writes.length&&validations.length,'Each published draft needs its own completed writes and valid validation.');
        const published: CompletedPackageOperation=draftRef===continuousDraftRef?initialPublish:finalPublish;
        assert(validations.some(validation=>record(validation.result.draft).draftRevision===published.arguments.expectedDraftRevision
          &&writes.some(write=>write.resultIndex<validation.callIndex)),'The validated exact revision must follow a successful write before its matching publication.');
      }
      const resumeIndex=parsedMessages.findIndex(message=>message.role==='user'&&JSON.stringify(message.content).includes(continuousDraftRef)
        &&(JSON.stringify(message.content).includes('Setze meinen Plugin-Entwurf')||JSON.stringify(message.content).includes('Continue my plugin draft')));
      const initialUserIndex=resumeIndex>=0?resumeIndex:parsedMessages.findIndex(message=>message.role==='user');
      const guidance=admissions.map(admission=>{
        const accepted=record(admission.message??{});
        assert.equal(accepted.role, 'user');
        // The real session store applies this exact projection before persistence;
        // server path redaction intentionally makes raw content non-identical.
        const expected = projectAgentMessageForPersistence({ ...accepted, clientMessageId: text(admission.client_message_id),
          serverMessageId: text(admission.server_message_id), ...(admission.body == null ? {} : { body: admission.body })
        } as unknown as Parameters<typeof projectAgentMessageForPersistence>[0]);
        const index=parsedMessages.findIndex(message=>message.role==='user'&&isDeepStrictEqual(message, expected));
        return {admission,index,accepted};
      }).filter(({admission,index,accepted})=>creatorReference([admission])&&index>(authoringSession?-1:initialUserIndex)&&index<edit.callIndex
        &&/workflow|capabilit/iu.test(JSON.stringify(accepted.content))
        &&(!authoringSession||/edit|bearbeit|überarbeit/iu.test(JSON.stringify(accepted.content))
          &&[resource.resource_ref,priorVersion.revision_ref,priorVersion.checksum].every(value=>JSON.stringify(accepted.content).includes(text(value)))));
      assert(guidance.length,'The actual correction needs an accepted additional human message with its inline Core Creator reference before Edit.');
      correctionEvidence={mode:authoringSession?'three_explicit_sessions_natural_creation_then_operator_guided_repair':'natural_creation_then_operator_guided_workflow_correction',unassistedInitialSuccess:false,
        initialPin:{resourceRef:resource.resource_ref,publishedRevisionRef:priorVersion.revision_ref,checksum:priorVersion.checksum},
        initialDraftRef:continuousDraftRef,editDraftRef,exactPublishedDraftsConsumed:true,
        guidance:guidance.map(({admission})=>({clientMessageId:admission.client_message_id,acceptedInlineCreator:true,
          exactAcceptedPersistenceProjection:true,executionPhase:admission.execution_phase})),
        exactSourceRevisionLineage:true,captureSourceRevisionRef:initialVersion.revision_ref};
    }
    for (const operation of ['create_canvas_package_draft', 'compose_canvas_package_skills', 'write_canvas_package_draft_file', 'validate_canvas_package_draft', 'publish_canvas_package_draft']) {
      const completed = ['create_canvas_package_draft', 'compose_canvas_package_skills'].includes(operation) ? originalOperations : completedOperations;
      assert(completed.get(operation)?.some(({ result }) => operation !== 'validate_canvas_package_draft'
        || record(result.validation ?? {}).valid === true), `Natural Creator run has no successful paired ${operation} result.`);
    }
    const toolResultText = (originSession ? parsedOriginMessages : parsedMessages).filter(message => message.role === 'toolResult').map(message => JSON.stringify(message.content));
    const creatorInstructionsDelivered = toolResultText.some(content => content.includes('Turn the requested workflow into an organization-managed Canvas package.'));
    const visualInstructionsDelivered = toolResultText.some(content => content.includes("Create a small editable illustration that communicates the plugin's actual job."));
    assert(acceptedCreatorReference, 'The accepted turn must explicitly reference the actual Core Plugin Creator.');
    assert(creatorInstructionsDelivered, 'The real Creator run must receive the Plugin Creator instructions.');
    assert(visualInstructionsDelivered, 'The real Creator run must receive the bundled plugin-visual instructions.');
    assert(completedOperations.get('publish_canvas_package_draft')?.some(({ result }) => {
      const published = record(result.published ?? {});
      return published.resourceRef === resource.resource_ref && published.revisionRef === version.revision_ref && published.checksum === version.checksum;
    }),
    'The real model run must have a successful normal Publish result carrying this exact immutable publication.');
    stage = 'api-and-agent-cross-check';
    const api = values['api-evidence'] ? record(JSON.parse(await fs.readFile(values['api-evidence'], 'utf8'))) : null;
    if (api) {
      const actual = record(api.inspection), actualVersion = record(actual.published);
      assert.equal(actualVersion.resourceRef, resource.resource_ref); assert.equal(actualVersion.revisionRef, version.revision_ref); assert.equal(actualVersion.checksum, version.checksum);
      assert.deepEqual(actualVersion.files, decoded(version.files));
    }
    if (values['require-provisioned']) {
      assert(api, 'Provisioning acceptance requires the actual authenticated API observation.');
      const provisioning = record(api.provisioning), pin = record(provisioning.pin);
      assert.equal(pin.resourceRef, resource.resource_ref); assert.equal(pin.publishedRevisionRef, version.revision_ref); assert.equal(pin.checksum, version.checksum);
      assert.equal(provisioning.defaultEnabled, true); assert.equal(record(provisioning.policy).canUse, true); assert.equal(record(provisioning.policy).enabled, true);
    }
    let agentPins: unknown[] = [];
    if (values['agent-id']) {
      const bindings = (await database.query<Row>('SELECT b.configuration_json FROM agent_capability_bindings b JOIN agents a ON a.agent_id=b.agent_id WHERE b.agent_id=$1 AND a.organization_id=$2 AND b.resource_type=\'plugin\' AND b.resource_id=$3', [values['agent-id'], session.organization_id, resource.legacy_resource_id])).rows;
      assert.equal(bindings.length, 1);
      agentPins = bindings.map(binding => record(decoded(binding.configuration_json)).workflow).map(workflow => {
        const pin = record(workflow); assert.equal(pin.resourceRef, resource.resource_ref); assert.equal(pin.publishedRevisionRef, version.revision_ref); assert.equal(pin.checksum, version.checksum);
        return { resourceRef: pin.resourceRef, publishedRevisionRef: pin.publishedRevisionRef, checksum: pin.checksum };
      });
    }
    await database.query('ROLLBACK');
    stage = 'report';
    const report = { schemaVersion: 1, nonce: values.nonce, sessionId: values['session-id'], scope: 'local managed SQL READ ONLY + immutable filesystem',
      verificationMode:authoringSession?'three_explicit_sessions_natural_creation_then_operator_guided_repair':correction?'natural_creation_then_operator_guided_workflow_correction':'natural_creation',
      runtime: { provider: session.provider, model: session.model, selectionSource: session.runtime_selection_source },
      pin: { resourceRef: resource.resource_ref, publishedRevisionRef: version.revision_ref, checksum: version.checksum },
      name: manifest.name, version: manifest.version, files: files.map(({ path, size, checksum }) => ({ path, size, checksum })), skills,
      svg: { path: logoPath, checksum: logo.checksum, validated: true }, docx: { sourceVersion: docx.parentVersion, childVersion: docx.version,
        targetVersion: currentDocxVersion, expectedCurrentVersion: values['docx-version'], targetVersionAtCapture: docx.targetVersion,
        captureSha256: digest(text(captureRows[captures.indexOf(docx)].capture_json)),
        sourcePin:{resourceRef:sourceVersion.resource_ref,publishedRevisionRef:sourceVersion.revision_ref,checksum:sourceVersion.checksum},
        sourceRoot:docx.childRelativeRoot,targetRoot:docx.targetRelativeRoot,sourceChecksum: docx.parentChecksum ?? docx.checksum,
        childChecksum: docx.selectedChildChecksum, fullSourceChildFiles: sourceChild.length, changedFiles: changedDocxFiles, licensePreserved: true,
        ...(docxUiExpectation ? { explicitUiMetadataAdaptation: { fixtureChecksum: docxUiExpectation.checksum,
          fields: docxUiExpectation.fields.map(({ path, sourceTextSha256, targetTextSha256 }) => ({ path, sourceTextSha256, targetTextSha256 })),
          otherInterfaceFieldsPreserved: true, completeSkillBodyPreserved: true } } : {}) },
      workflow,
      ...(priorVersion?{publications:checkedVersions.map(checked=>({pin:{resourceRef:resource.resource_ref,
        publishedRevisionRef:checked.version.revision_ref,checksum:checked.version.checksum},version:checked.version.version,
        files:checked.files.map(({path,size,checksum})=>({path,size,checksum})),skills:checked.skills,
        svg:{path:checked.logoPath,checksum:checked.logo.checksum,validated:true},workflow:checked.workflow,
        docx:{version:checked.currentDocxVersion,targetVersionAtCapture:checked.docx.targetVersion,completeSourceBodyPreserved:true,
          licensePreserved:true,captureSourceRevisionRef:initialVersion.revision_ref}})),correction:correctionEvidence}:{}),
      counts: { resources: 1, publishedVersions: versions.length, consumedDraft: true }, grants,
      acceptedCreatorReference, creatorInstructionsDelivered, visualInstructionsDelivered, admissionPhases:admissions.map(admission=>admission.execution_phase),
      operations: callOperations, ...(originSession ? { recovery: { mode: authoringSession?'origin_then_authoring_then_repair':correction?'same_draft_resumed_then_corrected_after_initial_publication':'same_draft_two_session', draftRef: continuousDraftRef,
        originSessionId: originSession.session_id, continuationSessionId: session.session_id, sameActorAndWorkspace: true,
        cause: 'host_oom', causeSource: 'operator_observation', originAdmissionPhases: originAdmissions.map(admission => admission.execution_phase),
        ...(authoringSession?{initialPublicationSessionId:authoringSession.session_id,authoringAdmissionPhases:authoringAdmissions.map(admission=>admission.execution_phase),
          authoringOperations:[...authoringOperations.keys()],additionalHostOomAfterInitialPublication:true,readExactPriorBeforeEdit:true}:{}),
        originalOperations: [...originalOperations.keys()] } } : {}),
      agentPins, suppressedParserDiagnostics, apiCrossChecked: Boolean(api), provisioningCrossChecked: Boolean(values['require-provisioned']) };
    if (values.output) {
      const output = path.resolve(values.output), parent = await fs.realpath(path.dirname(output));
      assert(parent !== dataRoot && !parent.startsWith(`${dataRoot}${path.sep}`));
      await fs.writeFile(path.join(parent,path.basename(output)), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag:'wx' });
    }
    console.info(JSON.stringify(report, null, 2));
  } finally { database.release(); await pool.end(); }
}
void main().catch(error => { console.error(JSON.stringify({ status: 'failed', stage,
  errorCode: error instanceof assert.AssertionError ? 'EVIDENCE_ASSERTION_FAILED' : 'EVIDENCE_FAILED',
  evidenceLine: error instanceof Error ? Number(/creator-vertical-evidence\.ts:(\d+):\d+/u.exec(error.stack ?? '')?.[1]) || null : null,
  privateDiagnosticsOmitted: true })); process.exitCode = 1; });
