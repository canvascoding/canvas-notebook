import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

type Json = Record<string, unknown>;
type ParentReceipt = {
  version: number; nonce: string; fixtureRoot: string; repo: string; ownerMarker: string;
  rootDevice: string; rootInode: string; createAcknowledged: boolean; phase: string; actorId: string | null; uncertain: boolean;
};
type IssuerReceipt = {
  version: 1; nonce: string; fixtureRoot: string; controlPlaneRoot: string; databaseName: string; processId: number;
  databaseOwner: string | null; ownerMarker: string; rootDevice: string; rootInode: string;
  createAcknowledged: boolean; databaseDropped: boolean; poolsClosed: boolean; appClosed: boolean;
  phase: string; uncertain: boolean; licenseId: string | null; instanceId: string;
  actorId: string | null; organizationId: string | null; grantRequestId: string; grantExpiresAt: string;
  grantId: string | null; requestsInFlight: number;
};
export type AgentWorkflowTeamIssuerReady = {
  version: 1; nonce: string; fixtureRoot: string; origin: string; certificatePath: string;
  initialPublicKey: string; initialPublicKeyFingerprint: string; testPublicKey: string; testPublicKeyFingerprint: string;
  licenseId: string; instanceId: string; cpOrganizationId: string; controlSecret: string;
};
type IssuerRequest = { method: string; url: string; body: unknown; headers: Record<string, string | string[] | undefined> };
type IssuerReply = { code(status: number): IssuerReply; send(value: unknown): unknown };
type IssuerApp = {
  register(plugin: unknown, options?: { prefix: string }): Promise<unknown>;
  addHook(name: 'preHandler', handler: (request: IssuerRequest, reply: IssuerReply) => Promise<unknown>): void;
  post(route: string, handler: (request: IssuerRequest, reply: IssuerReply) => Promise<unknown>): void;
  get(route: string, handler: (request: IssuerRequest, reply: IssuerReply) => Promise<unknown>): void;
  setErrorHandler(handler: (error: unknown, request: IssuerRequest, reply: IssuerReply) => unknown): void;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
};
type IssuerInput = { parent: ParentReceipt; parentPath: string; root: string; cpRoot: string; maintenance: URL; instanceId: string };
type IssuerState = {
  input: IssuerInput; receipt: IssuerReceipt; receiptPath: string; origin: string; administration: Pool; database?: Pool;
  app?: IssuerApp; closeDatabase?: () => Promise<void>; authPool?: Pool;
  validateInstanceToken?: (token: string, scope: string) => Promise<{ license: { id: string }; token: { instanceId: string } }>;
  ownerEmail: string; ownerPassword: string; sessionToken: string | null; controlSecret: string;
  activationToken: string | null; initialPublicKey: string; testPublicKey: string; closed: boolean; stopping: boolean;
};
const protocolVersion = 'canvas-team-seat-protocol-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

async function assertIssuerInput(): Promise<IssuerInput> {
  assert.equal(process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN, '1');
  assert.equal(process.env.NODE_ENV, 'development');
  assert.equal(process.argv.length, 2, 'The owned issuer does not accept additional CLI arguments.');
  const parentPath = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE ?? '';
  assert(path.isAbsolute(parentPath)); assert.equal(path.basename(parentPath), 'recovery.json');
  const root = path.dirname(parentPath), stat = await fs.lstat(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(root), root); assert.equal(stat.uid, process.getuid?.());
  const receiptStat = await fs.lstat(parentPath);
  assert(receiptStat.isFile() && !receiptStat.isSymbolicLink() && receiptStat.nlink === 1 && (receiptStat.mode & 0o777) === 0o600);
  assert(receiptStat.size < 64 * 1024 && receiptStat.uid === stat.uid);
  const parent = JSON.parse(await fs.readFile(parentPath, 'utf8')) as ParentReceipt;
  assert.equal(parent.version, 1); assert.match(parent.nonce, /^[a-f0-9]{32}$/u);
  assert.equal(parent.fixtureRoot, root); assert.equal(parent.rootDevice, String(stat.dev)); assert.equal(parent.rootInode, String(stat.ino));
  assert.equal(parent.phase, 'bootstrap'); assert.equal(parent.createAcknowledged, true); assert.equal(parent.uncertain, false);
  assert(typeof parent.actorId === 'string' && parent.actorId.length > 0);
  const marker = await fs.lstat(path.join(root, '.fixture-owner'));
  assert(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1 && (marker.mode & 0o777) === 0o600);
  assert.equal(await fs.readFile(path.join(root, '.fixture-owner'), 'utf8'), parent.ownerMarker);
  const repo = await fs.realpath(process.cwd()); assert.equal(parent.repo, repo);
  const cpRoot = await fs.realpath(process.env.CANVAS_CONTROL_PLANE_TEST_ROOT ?? '');
  assert.equal(cpRoot, await fs.realpath(path.join(repo, '..', 'canvas-control-plane')));
  const manifest = JSON.parse(await fs.readFile(path.join(cpRoot, 'apps/api/package.json'), 'utf8')) as Json;
  assert.equal(manifest.name, '@canvas-control-plane/api');
  const maintenance = new URL(process.env.CANVAS_ISSUER_MAINTENANCE_DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(maintenance.protocol)); assert.equal(maintenance.hostname, '127.0.0.1'); assert.equal(maintenance.port, '55433');
  assert.equal(maintenance.pathname, '/postgres'); assert.equal(maintenance.search, ''); assert.equal(maintenance.hash, '');
  const instanceId = process.env.CANVAS_INSTANCE_ID ?? '';
  assert.equal(instanceId, `agent-settings-browser-${parent.nonce}`);
  return { parent, parentPath, root, cpRoot, maintenance, instanceId };
}

async function writeIssuerPrivateJson(file: string, value: unknown): Promise<void> {
  // Callers pass only fixed files under the already verified fixture root.
  try {
    const stat = await fs.lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

async function importControlPlaneSource<T>(cpRoot: string, relative: string): Promise<T> {
  assert(/^(?:lib|services|routes|plugins|db)\/[a-zA-Z0-9/-]+\.ts$/u.test(relative));
  const file = path.join(cpRoot, 'apps/api/src', relative);
  assert.equal(await fs.realpath(file), file);
  return await import(pathToFileURL(file).href) as T;
}

function issuerFingerprint(pem: string): string {
  return createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex');
}

function configureIssuerEnvironment(input: IssuerInput, origin: string, runtimeUrl: URL, keys: { initial: string; test: string }): void {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'];
  const inherited = Object.fromEntries(allowed.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  // This is an isolated child. Clearing its environment cannot affect Notebook,
  // and prevents inherited .env, SMTP, Stripe or provider credentials being used.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, inherited, {
    NODE_ENV: 'development', DATABASE_URL: runtimeUrl.toString(), BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), CORS_ORIGIN: origin,
    BETTER_AUTH_TRUSTED_ORIGINS: origin, PANEL_WEB_URL: origin, PUBLIC_SIGNUP_ENABLED: 'true',
    BILLING_MODE: 'disabled', EMAIL_PROVIDER: 'smtp', LICENSE_EMAIL_DELIVERY_MODE: 'console',
    LICENSE_PRIVATE_KEY: keys.initial, LICENSE_TEST_PRIVATE_KEY: keys.test, LICENSE_TEST_AUDIENCE: 'canvas-notebook-test',
    LICENSE_CLAIM_CODE_SECRET: randomBytes(48).toString('base64url'), LICENSE_COMMUNITY_EXPIRY_DAYS: '1',
    TEAM_SEAT_CONTROL_PLANE_ENVIRONMENT: 'production', TEAM_SEAT_TEST_GRANTS_ENABLED: 'true',
    TEAM_SEAT_TEST_ALLOWED_ENVIRONMENTS: 'development', TEAM_SEAT_TEST_MAX_TTL_HOURS: '24', TEAM_SEAT_TEST_MAX_SEATS: '4',
    TEAM_SEAT_GRANT_CERTIFICATE_TTL_SECONDS: '3600', TEAM_SEAT_COMMUNITY_CLAIM_ENABLED: 'true',
    TEAM_SEAT_CLOUD_COMMERCIAL_ENABLED: 'false', TEAM_SEAT_COMMUNITY_COMMERCIAL_ENABLED: 'false', TEAM_SEAT_STRIPE_MUTATIONS_ENABLED: 'false',
    LOG_DIR: path.join(input.root, 'issuer-logs'), TMPDIR: path.join(input.root, 'tmp'), __NEXT_PROCESSED_ENV: 'true',
  });
}

async function migrateIssuerDatabase(state: IssuerState): Promise<void> {
  // Capture every real pool's close function before loading broader services.
  const connection = await importControlPlaneSource<{ db: unknown; closeDatabaseConnection(): Promise<void> }>(state.input.cpRoot, 'db/connection.ts');
  state.closeDatabase = connection.closeDatabaseConnection;
  const authDatabase = await importControlPlaneSource<{ authPool: Pool }>(state.input.cpRoot, 'lib/authDatabase.ts');
  state.authPool = authDatabase.authPool;
  const { auth } = await importControlPlaneSource<{ auth: { options: unknown } }>(state.input.cpRoot, 'lib/auth.ts');
  const migrations = await import(pathToFileURL(path.join(state.input.cpRoot, 'node_modules/better-auth/dist/db/get-migration.mjs')).href) as {
    getMigrations(options: unknown): Promise<{ runMigrations(): Promise<void> }>;
  };
  await (await migrations.getMigrations(auth.options)).runMigrations();
  const requireCp = createRequire(path.join(state.input.cpRoot, 'apps/api/package.json'));
  const { migrate } = await import(pathToFileURL(requireCp.resolve('drizzle-orm/postgres-js/migrator')).href) as {
    migrate(database: unknown, options: { migrationsFolder: string }): Promise<void>;
  };
  await migrate(connection.db, { migrationsFolder: path.join(state.input.cpRoot, 'apps/api/drizzle') });
  assert(state.database);
  assert.equal((await state.database.query('SELECT current_database() AS name')).rows[0].name, state.receipt.databaseName);
  assert.equal((await state.database.query('SELECT COUNT(*)::integer AS count FROM "user"')).rows[0].count, 0);
  assert.equal((await state.database.query('SELECT COUNT(*)::integer AS count FROM licenses')).rows[0].count, 0);
}

async function requestIssuerJson(state: IssuerState, route: string, body?: Json, authenticated = false): Promise<Json> {
  assert(route.startsWith('/api/auth/') || route.startsWith('/v1/'));
  assert(!state.stopping);
  const url = new URL(route, state.origin); assert.equal(url.origin, state.origin);
  try {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Origin: state.origin, 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${state.sessionToken}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const length = Number(response.headers.get('content-length') ?? 0); assert(length <= 256 * 1024);
    const text = await response.text(); assert(Buffer.byteLength(text) <= 256 * 1024);
    assert(response.ok, `The owned issuer HTTP request was rejected (${response.status}).`);
    const result: unknown = JSON.parse(text); assert(result && typeof result === 'object' && !Array.isArray(result));
    return result as Json;
  } catch (error) {
    // Any uncertain mutation remains recoverable in the own database/receipt.
    state.receipt.uncertain = true; await writeIssuerPrivateJson(state.receiptPath, state.receipt); throw error;
  }
}

async function bootstrapIssuerOwner(state: IssuerState): Promise<void> {
  const signup = await requestIssuerJson(state, '/api/auth/sign-up/email', {
    name: 'Owned workflow test issuer', email: state.ownerEmail, password: state.ownerPassword,
  });
  const user = signup.user as Json | undefined; assert(user && typeof user.id === 'string');
  assert(state.database);
  // The sanctioned local bootstrap only verifies the real signup account. No
  // license, entitlement, seat, Notebook user or membership is fabricated here.
  const verified = await state.database.query('UPDATE "user" SET "emailVerified"=true,role=$3,"updatedAt"=NOW() WHERE id=$1 AND LOWER(email)=LOWER($2) RETURNING id',
    [user.id, state.ownerEmail, 'admin']);
  assert.equal(verified.rowCount, 1);
  const signin = await requestIssuerJson(state, '/api/auth/sign-in/email', { email: state.ownerEmail, password: state.ownerPassword });
  const signedUser = signin.user as Json | undefined;
  assert(signedUser && signedUser.id === user.id && signedUser.role === 'admin');
  assert(typeof signin.token === 'string' && signin.token.length >= 16); state.sessionToken = signin.token;
  const context = await requestIssuerJson(state, '/v1/organizations/context', undefined, true);
  assert(typeof context.activeOrganizationId === 'string' && context.activeRole === 'owner');
  state.receipt.actorId = user.id; state.receipt.organizationId = context.activeOrganizationId;
  process.env.TEAM_SEAT_GRANT_ADMIN_USER_IDS = user.id; process.env.TEAM_SEAT_TEST_ALLOWED_USER_IDS = user.id;
  await writeIssuerPrivateJson(state.receiptPath, state.receipt);
}

async function assertIssuerSubject(state: IssuerState, claimed = false): Promise<void> {
  assert(state.database && state.receipt.licenseId);
  const licenses = (await state.database.query('SELECT id,instance_id,hosting_mode,license_environment,claimed_by_user_id,billing_organization_id FROM licenses')).rows;
  assert.equal(licenses.length, 1); assert.equal(licenses[0].id, state.receipt.licenseId);
  assert.equal(licenses[0].instance_id, state.input.instanceId); assert.equal(licenses[0].hosting_mode, 'community');
  assert.equal(licenses[0].license_environment, state.receipt.grantId ? 'development' : 'production');
  if (claimed) { assert.equal(licenses[0].claimed_by_user_id, state.receipt.actorId); assert.equal(licenses[0].billing_organization_id, state.receipt.organizationId); }
  if (state.receipt.actorId) {
    const members = (await state.database.query('SELECT m.role,u.role AS user_role,u."emailVerified" FROM member m JOIN "user" u ON u.id=m."userId" JOIN organization o ON o.id=m."organizationId" WHERE m."organizationId"=$1 AND m."userId"=$2 AND o."deletedAt" IS NULL',
      [state.receipt.organizationId, state.receipt.actorId])).rows;
    assert.equal(members.length, 1); assert.equal(members[0].role, 'owner'); assert.equal(members[0].user_role, 'admin'); assert.equal(members[0].emailVerified, true);
  }
}

async function issueInitialIssuerCertificate(state: IssuerState): Promise<string> {
  const registered = await requestIssuerJson(state, '/v1/license/register', {
    email: state.ownerEmail, instanceId: state.input.instanceId, marketingOptIn: false, activationUrl: `${state.origin}/activate-license`,
  });
  assert.equal(registered.ok, true); assert(typeof registered.licenseId === 'string' && uuid.test(registered.licenseId));
  state.receipt.licenseId = registered.licenseId; await writeIssuerPrivateJson(state.receiptPath, state.receipt);
  await assertIssuerSubject(state);
  assert(state.activationToken && /^lea_[a-f0-9]{64}$/u.test(state.activationToken));
  const approved = await requestIssuerJson(state, '/v1/license/activation/v1/approve', { token: state.activationToken });
  assert.equal((approved.activation as Json).instanceId, state.input.instanceId);
  const activation = registered.activation as Json;
  const polled = await requestIssuerJson(state, '/v1/license/activation/v1/poll', {
    activationId: activation.id, pollToken: activation.pollToken, instanceId: state.input.instanceId,
  });
  const result = polled.activation as Json; assert.equal(result.status, 'activated'); assert(typeof result.license === 'string');
  const parts = result.license.split('.'); assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as Json;
  assert.equal(header.alg, 'RS256'); assert(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), state.initialPublicKey, Buffer.from(parts[2], 'base64url')));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Json;
  assert.equal(claims.iss, 'canvas-control-plane'); assert.equal(claims.aud, 'canvas-notebook'); assert.equal(claims.licenseId, state.receipt.licenseId);
  assert.equal(claims.sub, state.input.instanceId); assert.equal(claims.hostingMode, 'community');
  assert.equal(claims.licenseEnvironment, 'production'); assert.equal(claims.licenseClass, 'commercial');
  assert.equal(claims.edition, 'solo'); assert(typeof claims.exp === 'number' && claims.exp > Date.now() / 1000);
  const certificatePath = path.join(state.input.root, 'issuer-initial-certificate.jwt');
  await fs.writeFile(certificatePath, result.license, { mode: 0o600, flag: 'wx' });
  state.activationToken = null;
  return certificatePath;
}

async function approveClaim(state: IssuerState, userCode: string): Promise<Json> {
  assert(/^[a-zA-Z0-9-]{8,16}$/u.test(userCode)); await assertIssuerSubject(state);
  const preview = await requestIssuerJson(state, '/v1/license/claim/v1/preview', { protocolVersion, userCode }, true);
  const claim = preview.claim as Json;
  assert(typeof claim.claimSessionId === 'string' && uuid.test(claim.claimSessionId));
  assert.equal(claim.licenseId, state.receipt.licenseId); assert.equal(claim.instanceId, state.input.instanceId);
  assert.equal(claim.licenseEnvironment, 'production');
  const approved = await requestIssuerJson(state, '/v1/license/claim/v1/approve', {
    protocolVersion, userCode, organizationId: state.receipt.organizationId,
  }, true);
  const approvedClaim = approved.claim as Json;
  assert.equal(approvedClaim.claimSessionId, claim.claimSessionId); assert.equal(approvedClaim.status, 'approved');
  assert.equal(approvedClaim.instanceId, state.input.instanceId);
  assert.equal(approvedClaim.organizationId, state.receipt.organizationId);
  assert(state.database);
  const sessions = (await state.database.query('SELECT id,status,license_id,requested_instance_id,approved_by_user_id,approved_organization_id FROM license_claim_sessions WHERE id=$1', [claim.claimSessionId])).rows;
  assert.equal(sessions.length, 1); assert.equal(sessions[0].id, claim.claimSessionId); assert.equal(sessions[0].status, 'approved');
  assert.equal(sessions[0].license_id, state.receipt.licenseId); assert.equal(sessions[0].requested_instance_id, state.input.instanceId);
  assert.equal(sessions[0].approved_by_user_id, state.receipt.actorId); assert.equal(sessions[0].approved_organization_id, state.receipt.organizationId);
  return { success: true, licenseId: state.receipt.licenseId, instanceId: state.input.instanceId };
}

async function issueDevelopmentGrant(state: IssuerState): Promise<Json> {
  await assertIssuerSubject(state, true);
  const result = await requestIssuerJson(state, '/v1/license/admin/team-grants', {
    requestId: state.receipt.grantRequestId, subjectType: 'license', licenseId: state.receipt.licenseId,
    grantType: 'test', licenseEnvironment: 'development', allowedUserId: state.receipt.actorId, allowedInstanceId: state.input.instanceId,
    seatLimit: 4, features: { team: true }, expiresAt: state.receipt.grantExpiresAt,
    reason: 'Owned workflow UI acceptance fixture', externalReference: `workflow-ui-${state.input.parent.nonce}`, testScenario: 'success',
  }, true);
  const grant = result.grant as Json;
  assert.equal(grant.subjectType, 'license'); assert.equal(grant.licenseId, state.receipt.licenseId);
  assert.equal(grant.grantType, 'test'); assert.equal(grant.licenseEnvironment, 'development'); assert.equal(grant.seatLimit, 4);
  assert.equal(grant.allowedInstanceId, state.input.instanceId); assert.equal(grant.allowedUserId, state.receipt.actorId);
  assert(typeof grant.id === 'string' && uuid.test(grant.id));
  assert.equal((result.certificateReissue as Json).status, 'issued');
  state.receipt.grantId = grant.id; await writeIssuerPrivateJson(state.receiptPath, state.receipt);
  await inspectSeatOperation(state);
  return { success: true, licenseId: state.receipt.licenseId, instanceId: state.input.instanceId };
}

async function inspectSeatOperation(state: IssuerState, operationId?: string): Promise<Json> {
  await assertIssuerSubject(state, true); assert(state.database);
  if (operationId) assert(uuid.test(operationId));
  const grants = (await state.database.query('SELECT id,subject_type,license_id,grant_type,license_class,license_environment,allowed_user_id,allowed_instance_id,seat_limit,status FROM team_entitlement_grants ORDER BY created_at LIMIT 65')).rows;
  assert.equal(grants.length, 1);
  const grant = grants[0]; assert.equal(grant.id, state.receipt.grantId); assert.equal(grant.license_id, state.receipt.licenseId);
  assert.equal(grant.subject_type, 'license'); assert.equal(grant.grant_type, 'test'); assert.equal(grant.license_class, 'test');
  assert.equal(grant.license_environment, 'development'); assert.equal(grant.allowed_user_id, state.receipt.actorId);
  assert.equal(grant.allowed_instance_id, state.input.instanceId); assert.equal(grant.seat_limit, 4); assert.equal(grant.status, 'active');
  const operations = (await state.database.query('SELECT id,operation_key,subject_type,license_id,provider,environment,status,payment_status,previous_quantity,requested_quantity,effective_quantity,certificate_reissue_status FROM team_seat_billing_operations ORDER BY created_at LIMIT 65')).rows;
  assert(operations.length <= 64);
  for (const operation of operations) {
    assert.equal(operation.subject_type, 'license'); assert.equal(operation.license_id, state.receipt.licenseId);
    assert.equal(operation.provider, 'test'); assert.equal(operation.environment, 'development');
  }
  const selected = operationId ? operations.filter(item => item.id === operationId || item.operation_key === operationId) : operations;
  if (operationId) assert.equal(selected.length, 1);
  const snapshots = (await state.database.query('SELECT subject_type,license_id,instance_id,revision,observed_quantity,drift_status FROM team_seat_snapshots ORDER BY received_at LIMIT 65')).rows;
  assert(snapshots.length <= 64);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.subject_type, 'license'); assert.equal(snapshot.license_id, state.receipt.licenseId); assert.equal(snapshot.instance_id, state.input.instanceId);
  }
  return { success: true, licenseId: state.receipt.licenseId, instanceId: state.input.instanceId,
    operations: selected.map(item => ({ operationId: item.id, operationKey: item.operation_key, provider: item.provider,
      environment: item.environment, status: item.status, paymentStatus: item.payment_status, previousQuantity: item.previous_quantity,
      requestedQuantity: item.requested_quantity, effectiveQuantity: item.effective_quantity, certificateReissueStatus: item.certificate_reissue_status })),
    snapshots: snapshots.map(item => ({ revision: String(item.revision), observedQuantity: item.observed_quantity, driftStatus: item.drift_status })) };
}

function registerIssuerControls(state: IssuerState): void {
  assert(state.app);
  const handle = (operation: (body: Json) => Promise<Json>) => async (request: IssuerRequest, reply: IssuerReply) => {
    if (state.stopping) return reply.code(503).send({ success: false, code: 'OWN_ISSUER_STOPPING' });
    const provided = request.headers.authorization;
    const expected = `Bearer ${state.controlSecret}`;
    if (typeof provided !== 'string' || provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return reply.code(403).send({ success: false, code: 'OWN_ISSUER_CONTROL_DENIED' });
    }
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) return reply.code(400).send({ success: false });
    state.receipt.requestsInFlight += 1;
    try { return await operation(request.body as Json); }
    catch { state.receipt.uncertain = true; return reply.code(503).send({ success: false, code: 'OWN_ISSUER_OPERATION_FAILED' }); }
    finally { state.receipt.requestsInFlight -= 1; await writeIssuerPrivateJson(state.receiptPath, state.receipt); }
  };
  state.app.post('/__owned/approve-claim', handle(async body => {
    assert.deepEqual(Object.keys(body), ['userCode']); assert(typeof body.userCode === 'string'); return approveClaim(state, body.userCode);
  }));
  state.app.post('/__owned/development-grant', handle(async body => { assert.equal(Object.keys(body).length, 0); return issueDevelopmentGrant(state); }));
  state.app.post('/__owned/inspect', handle(async body => {
    assert(Object.keys(body).every(key => key === 'operationId')); assert(body.operationId === undefined || typeof body.operationId === 'string');
    return inspectSeatOperation(state, body.operationId as string | undefined);
  }));
}

export async function createAgentWorkflowTeamIssuerFixture(signal?: AbortSignal): Promise<{ ready: AgentWorkflowTeamIssuerReady; close(): Promise<void> }> {
  const input = await assertIssuerInput();
  assert(Number.isSafeInteger(process.pid) && process.pid > 0);
  const receiptPath = path.join(input.root, 'issuer-recovery.json');
  // Fixed-path exclusive acknowledgement precedes CREATE. A collision/unknown
  // CREATE never authorizes dropping a database based merely on its role/name.
  const receipt: IssuerReceipt = { version: 1, nonce: input.parent.nonce, fixtureRoot: input.root, controlPlaneRoot: input.cpRoot,
    databaseName: `canvas_workflow_issuer_${input.parent.nonce}`, processId: process.pid, databaseOwner: null, ownerMarker: randomBytes(24).toString('hex'),
    rootDevice: input.parent.rootDevice, rootInode: input.parent.rootInode, createAcknowledged: false, databaseDropped: false,
    poolsClosed: false, appClosed: false, phase: 'before_create', uncertain: false, licenseId: null, instanceId: input.instanceId,
    actorId: null, organizationId: null, grantRequestId: randomUUID(), grantExpiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
    grantId: null, requestsInFlight: 0 };
  await fs.writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  const administration = new Pool({ connectionString: input.maintenance.toString(), max: 1, connectionTimeoutMillis: 5_000, query_timeout: 30_000 });
  const keys = [0, 1].map(() => generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }));
  assert.notEqual(issuerFingerprint(keys[0].publicKey), issuerFingerprint(keys[1].publicKey));
  const state: IssuerState = { input, receipt, receiptPath, origin: '', administration, ownerEmail: `workflow-issuer-${input.parent.nonce}@example.test`,
    ownerPassword: randomBytes(32).toString('base64url'), sessionToken: null, controlSecret: randomBytes(48).toString('base64url'),
    activationToken: null, initialPublicKey: keys[0].publicKey, testPublicKey: keys[1].publicKey, closed: false, stopping: false };
  const cancelled = () => { state.stopping = true; if (receipt.phase !== 'ready') receipt.uncertain = true; };
  signal?.addEventListener('abort', cancelled, { once: true });
  const close = async (): Promise<void> => {
    if (state.closed) return;
    state.stopping = true; receipt.phase = 'closing'; await writeIssuerPrivateJson(receiptPath, receipt);
    const bounded = async (operation: Promise<void>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Own issuer shutdown remained unconfirmed.')), 5_000); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    try { if (state.app) await bounded(state.app.close()); receipt.appClosed = true; }
    catch { receipt.uncertain = true; }
    try {
      await bounded(Promise.all([state.authPool?.end(), state.closeDatabase?.(), state.database?.end()]).then(() => {}));
      receipt.poolsClosed = true;
    } catch { receipt.uncertain = true; }
    try {
      const root = await fs.lstat(input.root);
      assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700);
      assert.equal(String(root.dev), receipt.rootDevice); assert.equal(String(root.ino), receipt.rootInode);
      assert.equal(await fs.realpath(input.root), input.root);
      const marker = await fs.lstat(path.join(input.root, '.fixture-owner'));
      assert(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1 && marker.uid === root.uid && (marker.mode & 0o777) === 0o600);
      assert.equal(await fs.readFile(path.join(input.root, '.fixture-owner'), 'utf8'), input.parent.ownerMarker);
      assert.equal(receipt.requestsInFlight, 0);
      if (receipt.createAcknowledged && receipt.appClosed && receipt.poolsClosed && !receipt.uncertain) {
        const current = (await administration.query("SELECT pg_get_userbyid(datdba) AS owner,current_user AS role,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [receipt.databaseName])).rows[0];
        assert(current && current.owner === receipt.databaseOwner && current.owner === current.role && current.marker === receipt.ownerMarker);
        await administration.query(`DROP DATABASE "${receipt.databaseName}"`);
        receipt.databaseDropped = true;
        assert.equal((await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [receipt.databaseName])).rowCount, 0);
      }
    } catch { receipt.uncertain = true; }
    receipt.phase = receipt.databaseDropped && !receipt.uncertain ? 'cleaned' : 'preserved';
    await writeIssuerPrivateJson(receiptPath, receipt);
    await administration.end(); state.closed = true; signal?.removeEventListener('abort', cancelled);
    if (!receipt.databaseDropped || receipt.uncertain) throw new Error('The own issuer database was preserved.');
  };
  const reserved = net.createServer();
  try {
    signal?.throwIfAborted();
    assert.equal((await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [receipt.databaseName])).rowCount, 0);
    receipt.databaseOwner = (await administration.query('SELECT current_user AS role')).rows[0].role;
    receipt.phase = 'create_in_flight'; await writeIssuerPrivateJson(receiptPath, receipt);
    await administration.query(`CREATE DATABASE "${receipt.databaseName}"`); receipt.createAcknowledged = true;
    await writeIssuerPrivateJson(receiptPath, receipt);
    await administration.query(`COMMENT ON DATABASE "${receipt.databaseName}" IS '${receipt.ownerMarker}'`);
    signal?.throwIfAborted();
    const runtimeUrl = new URL(input.maintenance); runtimeUrl.pathname = `/${receipt.databaseName}`;
    await new Promise<void>((resolve, reject) => { reserved.once('error', reject); reserved.listen(0, '127.0.0.1', resolve); });
    const address = reserved.address(); assert(address && typeof address === 'object'); state.origin = `http://127.0.0.1:${address.port}`;
    configureIssuerEnvironment(input, state.origin, runtimeUrl, { initial: keys[0].privateKey, test: keys[1].privateKey });
    state.database = new Pool({ connectionString: runtimeUrl.toString(), max: 1, connectionTimeoutMillis: 5_000, query_timeout: 30_000 });
    // Capture only the actual console-delivered activation token in RAM. CP auth
    // log streams may contain URLs: suppress their output for the whole child.
    const suppressOutput = ((...values: unknown[]) => {
      const callback = values.at(-1);
      if (typeof callback === 'function') queueMicrotask(() => callback());
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = suppressOutput; process.stderr.write = suppressOutput;
    console.log = console.warn = console.error = console.debug = () => {};
    console.info = (...values: unknown[]) => {
      if (values[0] !== '[license/email] Development activation link') return;
      const details = values[1] as Json | undefined;
      assert(details && details.instanceId === input.instanceId && details.to === state.ownerEmail && typeof details.activationUrl === 'string');
      const approval = new URL(details.activationUrl); assert.equal(approval.origin, state.origin); assert.equal(approval.pathname, '/activate-license');
      state.activationToken = new URLSearchParams(approval.hash.slice(1)).get('token');
    };
    receipt.phase = 'migrations'; await writeIssuerPrivateJson(receiptPath, receipt); await migrateIssuerDatabase(state); signal?.throwIfAborted();
    const requireCp = createRequire(path.join(input.cpRoot, 'apps/api/package.json'));
    const fastify = requireCp('fastify') as (options: Json) => IssuerApp;
    state.app = fastify({ logger: false, bodyLimit: 256 * 1024, requestTimeout: 30_000 });
    const claims = await importControlPlaneSource<{ validateCommunityInstanceToken: NonNullable<IssuerState['validateInstanceToken']> }>(input.cpRoot, 'services/communityLicenseClaims.ts');
    state.validateInstanceToken = claims.validateCommunityInstanceToken;
    // Expose only the fixture's real license protocol, not unrelated CP routes.
    state.app.addHook('preHandler', async (request, reply) => {
      const route = new URL(request.url, state.origin).pathname;
      if (route.startsWith('/__owned/')) return;
      try {
        assert(!state.stopping);
        const body = request.body as Json | undefined;
        if (route.startsWith('/api/auth/')) {
          assert(!receipt.actorId && request.method === 'POST' && ['/api/auth/sign-up/email', '/api/auth/sign-in/email'].includes(route));
          assert(body?.email === state.ownerEmail && body?.password === state.ownerPassword); return;
        }
        if (request.method === 'GET' && ['/v1/license/public-key', '/v1/license/public-key/test'].includes(route)) return;
        if (route === '/v1/organizations/context' || ['/v1/license/claim/v1/preview', '/v1/license/claim/v1/approve', '/v1/license/admin/team-grants'].includes(route)) {
          assert(state.sessionToken && request.headers.authorization === `Bearer ${state.sessionToken}`); return;
        }
        if (['/v1/license/register', '/v1/license/activation/v1/approve', '/v1/license/activation/v1/poll'].includes(route)) {
          assert(receipt.phase !== 'ready' && request.method === 'POST');
          if (route === '/v1/license/register') assert(!receipt.licenseId && body?.instanceId === input.instanceId && body?.email === state.ownerEmail);
          else if (route.endsWith('/approve')) assert(body?.token === state.activationToken);
          else assert(body?.instanceId === input.instanceId);
          return;
        }
        if (route === '/v1/license/claim/v1/start') {
          assert(request.method === 'POST' && body?.instanceId === input.instanceId && typeof body.licenseCertificate === 'string');
          const certificate = await fs.readFile(path.join(input.root, 'issuer-initial-certificate.jwt'), 'utf8');
          assert.equal(body.licenseCertificate, certificate); await assertIssuerSubject(state); return;
        }
        if (route === '/v1/license/claim/v1/poll') {
          assert(request.method === 'POST' && typeof body?.deviceCode === 'string' && body.deviceCode.length <= 128 && state.database);
          const sessions = (await state.database.query('SELECT license_id,requested_instance_id FROM license_claim_sessions WHERE device_code_hash=$1',
            [createHash('sha256').update(body.deviceCode).digest('hex')])).rows;
          assert.equal(sessions.length, 1); assert.equal(sessions[0].license_id, receipt.licenseId); assert.equal(sessions[0].requested_instance_id, input.instanceId); return;
        }
        const scopes: Record<string, string> = { '/refresh': 'license:refresh', '/team/preflight': 'seat:prepare', '/seats/prepare': 'seat:prepare',
          '/seats/execute': 'seat:execute', '/seats/snapshot': 'seat:snapshot' };
        const suffix = route.replace(/^\/v1\/license\/community\/v1/u, '');
        const scope = scopes[suffix] ?? (/^\/seats\/quotes\/[a-f0-9-]{36}$/u.test(suffix) ? 'seat:prepare' : undefined);
        assert(scope && route.startsWith('/v1/license/community/v1/'));
        const token = request.headers.authorization; assert(typeof token === 'string' && token.startsWith('Bearer '));
        const access = await claims.validateCommunityInstanceToken(token.slice(7), scope);
        assert.equal(access.license.id, receipt.licenseId); assert.equal(access.token.instanceId, input.instanceId);
        await assertIssuerSubject(state, true);
      } catch { return reply.code(403).send({ error: 'Owned issuer subject required', code: 'OWN_ISSUER_SUBJECT_DENIED' }); }
    });
    state.app.setErrorHandler((_error, _request, reply) => reply.code(503).send({ error: 'Owned issuer request failed', code: 'OWN_ISSUER_REQUEST_FAILED' }));
    await state.app.register((await importControlPlaneSource<{ default: unknown }>(input.cpRoot, 'plugins/jwtAuth.ts')).default);
    await state.app.register((await importControlPlaneSource<{ default: unknown }>(input.cpRoot, 'routes/auth.ts')).default);
    await state.app.register((await importControlPlaneSource<{ default: unknown }>(input.cpRoot, 'routes/organizations.ts')).default, { prefix: '/v1' });
    await state.app.register((await importControlPlaneSource<{ default: unknown }>(input.cpRoot, 'routes/license.ts')).default, { prefix: '/v1' });
    registerIssuerControls(state);
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => reserved.close(error => error ? reject(error) : resolve()));
    assert.equal(await state.app.listen({ host: '127.0.0.1', port: address.port }), state.origin);
    receipt.phase = 'owner_bootstrap'; await writeIssuerPrivateJson(receiptPath, receipt); await bootstrapIssuerOwner(state);
    const certificatePath = await issueInitialIssuerCertificate(state);
    // Solo activation/claim uses the ordinary production-audience certificate.
    // Only the real subsequent grant issues the isolated development test key.
    process.env.TEAM_SEAT_CONTROL_PLANE_ENVIRONMENT = 'development';
    assert(receipt.licenseId && receipt.organizationId);
    const ready: AgentWorkflowTeamIssuerReady = { version: 1, nonce: receipt.nonce, fixtureRoot: input.root, origin: state.origin, certificatePath,
      initialPublicKey: state.initialPublicKey, initialPublicKeyFingerprint: issuerFingerprint(state.initialPublicKey),
      testPublicKey: state.testPublicKey, testPublicKeyFingerprint: issuerFingerprint(state.testPublicKey),
      licenseId: receipt.licenseId, instanceId: input.instanceId, cpOrganizationId: receipt.organizationId, controlSecret: state.controlSecret };
    receipt.phase = 'ready'; await writeIssuerPrivateJson(receiptPath, receipt);
    await writeIssuerPrivateJson(path.join(input.root, 'issuer-ready.json'), ready);
    return { ready, close };
  } catch (error) {
    receipt.uncertain = true;
    if (reserved.listening) await new Promise<void>(resolve => reserved.close(() => resolve()));
    try { await close(); } catch { /* Preserve the exact receipt/database; never FORCE drop. */ }
    throw error;
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let stopped = false;
  let resolveStop: (() => void) | undefined;
  const stop = () => { stopped = true; controller.abort(); resolveStop?.(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const fixture = await createAgentWorkflowTeamIssuerFixture(controller.signal);
    if (!stopped) await new Promise<void>(resolve => { resolveStop = resolve; });
    await fixture.close();
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}

// This helper is launched only in its own recorded child process. No parent
// imports it; all CP module globals and environment changes stay in this child.
void main().catch(() => { process.exitCode = 1; });
