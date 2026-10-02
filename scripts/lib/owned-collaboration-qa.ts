/** Explicit test-only target verification. The application never imports this module. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';

export type OwnedCollaborationQaTarget = {
  baseURL: string;
  port: number;
  dataRoot: string;
  appRoot: string;
  cloneDatabase: string;
  cloneOid: string;
  bindingHash: string;
};

export function ownedCollaborationQaEnabled(): boolean {
  return process.env.CANVAS_COLLABORATION_QA === '1';
}

function requireValue(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Owned collaboration QA target rejected (${label}).`);
}

function privateFile(filename: string): Buffer {
  const file = lstatSync(filename);
  requireValue(file.isFile() && !file.isSymbolicLink(), 'private regular file');
  requireValue((file.mode & 0o777) === 0o600 && file.uid === process.getuid?.(), 'private file ownership');
  return readFileSync(filename);
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** No mutation: verify published clone metadata, exact physical DATA, and live PostgreSQL identity. */
export async function requireOwnedCollaborationQaTarget(): Promise<OwnedCollaborationQaTarget> {
  requireValue(ownedCollaborationQaEnabled(), 'explicit opt-in');
  requireValue(process.env.COLLABORATION_E2E === '1' && process.env.E2E_EXTERNAL_SERVER === '1', 'E2E profile');
  requireValue(process.env.NODE_ENV === 'production', 'actual production runtime');
  requireValue(process.env.CANVAS_DATABASE_PROVIDER === 'postgres', 'PostgreSQL provider');
  requireValue(process.env.HOSTNAME === '127.0.0.1' && process.env.PORT === '4126', 'owned listener');
  const base = new URL(process.env.BASE_URL || '');
  requireValue(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)
    && base.port === '4126' && !base.username && !base.password
    && base.pathname === '/' && !base.search && !base.hash, 'plain loopback origin');
  requireValue(new URL(process.env.BETTER_AUTH_BASE_URL || '').origin === base.origin, 'auth origin');
  const appRoot = realpathSync(process.cwd());
  requireValue(realpathSync(process.env.CANVAS_APP_ROOT || '') === appRoot, 'exact checkout');
  const expectedHead = process.env.CANVAS_OLLAMA_QA_EXPECTED_HEAD || '';
  requireValue(/^[a-f0-9]{40}$/u.test(expectedHead), 'pinned HEAD');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  requireValue(head === expectedHead, 'current HEAD');
  const envFile = process.env.CANVAS_ENV_FILE || '';
  const qaRoot = path.dirname(envFile);
  requireValue(path.isAbsolute(envFile) && path.basename(envFile) === 'qa-database.env'
    && path.basename(qaRoot) === 'validation-426b', 'published private environment');
  const root = lstatSync(qaRoot);
  requireValue(root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o777) === 0o700
    && root.uid === process.getuid?.(), 'QA directory ownership');
  const envBytes = privateFile(envFile);
  const published = parse(envBytes);
  const url = new URL(published.DATABASE_URL || '');
  requireValue(['postgres:', 'postgresql:'].includes(url.protocol)
    && url.hostname === '127.0.0.1' && url.port === '55433'
    && /^\/canvas_426b_e2e_[a-f0-9]{16}$/u.test(url.pathname), 'isolated clone database');
  requireValue(process.env.DATABASE_URL === url.href, 'exact published database');
  const cloneDatabase = url.pathname.slice(1);
  const metadataBytes = privateFile(path.join(qaRoot,
    `qa-clone-${cloneDatabase.slice('canvas_426b_e2e_'.length)}`, 'metadata.json'));
  const metadata = JSON.parse(metadataBytes.toString('utf8')) as {
    cloneDatabase?: string; cloneOid?: string; privateDataRoot?: string;
    purpose?: string; verifiedSchemaAndCounts?: boolean; productionRestoreProof?: boolean;
  };
  requireValue(metadata.cloneDatabase === cloneDatabase && /^\d+$/u.test(metadata.cloneOid || ''), 'clone receipt identity');
  requireValue(metadata.purpose === 'isolated-local-QA-fixture' && metadata.verifiedSchemaAndCounts === true
    && metadata.productionRestoreProof === false, 'verified local clone receipt');
  const dataRoot = realpathSync(path.join(qaRoot, 'data'));
  requireValue(realpathSync(process.env.DATA || '') === dataRoot
    && realpathSync(process.env.CANVAS_DATA_ROOT || '') === dataRoot
    && realpathSync(metadata.privateDataRoot || '') === dataRoot, 'exact physical DATA');
  const data = statSync(dataRoot);
  requireValue(data.isDirectory() && (data.mode & 0o777) === 0o700 && data.uid === process.getuid?.(), 'DATA ownership');
  requireValue(Boolean(process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD)
    && process.env.TEST_LOGIN_EMAIL === process.env.BOOTSTRAP_ADMIN_EMAIL
    && process.env.TEST_LOGIN_PASSWORD === process.env.BOOTSTRAP_ADMIN_PASSWORD, 'configured bootstrap identity');
  const database = new Client({ connectionString: url.href, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 10_000, application_name: 'canvas_426b_owned_collaboration_qa_guard' });
  try {
    await database.connect();
    await database.query('BEGIN READ ONLY');
    const identity = (await database.query(`SELECT d.oid::text, current_database() AS name,
      current_user=(SELECT rolname FROM pg_roles WHERE oid=d.datdba) AS owned
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0] as { oid: string; name: string; owned: boolean } | undefined;
    requireValue(identity && identity.oid === metadata.cloneOid && identity.name === cloneDatabase && identity.owned === true, 'live clone OID and owner');
  } finally { await database.end(); }
  return { baseURL: base.origin, port: Number(base.port), appRoot, dataRoot, cloneDatabase,
    cloneOid: metadata.cloneOid!, bindingHash: sha256(JSON.stringify({ appRoot, head, base: base.origin,
      envHash: sha256(envBytes), metadataHash: sha256(metadataBytes), dataRoot,
      dataIdentity: [data.dev, data.ino, data.uid], cloneDatabase, cloneOid: metadata.cloneOid })) };
}
