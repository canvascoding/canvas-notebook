import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DockerManager } from './docker';
import type { CanvasCliConfig, CommandResult } from './types';

export type PgvectorPolicy = 'required' | 'optional' | 'disabled';

export interface ExternalPostgresPreflightResult {
  databaseWritable: boolean;
  pgvectorAvailable: boolean;
  pgvectorVersion: string | null;
  serverVersion: string;
}

const PREFLIGHT_SCRIPT = String.raw`
const postgres = require('postgres');
const tableName = process.env.CANVAS_PREFLIGHT_TABLE;
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10, idle_timeout: 5 });
(async () => {
  try {
    const [version] = await sql` + '`' + `select current_setting('server_version') as server_version` + '`' + `;
    await sql.begin(async (transaction) => {
      await transaction.unsafe('CREATE TABLE "' + tableName + '" (id integer primary key)');
      await transaction.unsafe('DROP TABLE "' + tableName + '"');
    });
    const [vector] = await sql` + '`' + `
      select default_version, installed_version
      from pg_available_extensions
      where name = 'vector'
    ` + '`' + `;
    process.stdout.write(JSON.stringify({
      databaseWritable: true,
      pgvectorAvailable: Boolean(vector),
      pgvectorVersion: vector?.installed_version || vector?.default_version || null,
      serverVersion: String(version.server_version || ''),
    }));
  } finally {
    await sql.end({ timeout: 2 });
  }
})().catch((error) => {
  process.stderr.write(String(error?.message || 'External Postgres preflight failed.'));
  process.exit(1);
});
`;

function externalDatabaseUrl(config: CanvasCliConfig): string {
  const databaseUrl = String(config.env.DATABASE_URL || '').trim();
  if (!databaseUrl || /[\r\n]/u.test(databaseUrl)) {
    throw new Error('External Postgres requires a single-line DATABASE_URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  if (!parsed.username || !parsed.password || !parsed.hostname || !parsed.pathname.replace(/^\/+|\/+$/gu, '')) {
    throw new Error('External DATABASE_URL must include user, password, host, and database.');
  }
  return databaseUrl;
}

export async function preflightExternalPostgres(params: {
  config: CanvasCliConfig;
  docker: DockerManager;
  pgvectorPolicy?: PgvectorPolicy;
  timeoutSeconds?: number;
}): Promise<ExternalPostgresPreflightResult> {
  const databaseUrl = externalDatabaseUrl(params.config);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-postgres-preflight-'));
  const envFile = path.join(tempDir, 'database.env');
  const tableName = `canvas_preflight_${crypto.randomBytes(8).toString('hex')}`;
  await fs.chmod(tempDir, 0o700);
  try {
    await fs.writeFile(
      envFile,
      `DATABASE_URL=${databaseUrl}\nCANVAS_PREFLIGHT_TABLE=${tableName}\n`,
      { mode: 0o600 },
    );
    let result: CommandResult;
    try {
      result = await params.docker.dockerOrThrow([
        'run',
        '--rm',
        '--env-file',
        envFile,
        '--entrypoint',
        'node',
        params.config.image,
        '-e',
        PREFLIGHT_SCRIPT,
      ], {
        timeoutMs: Math.max(1, params.timeoutSeconds ?? 30) * 1000,
      });
    } catch (error) {
      const parsed = new URL(databaseUrl);
      const password = decodeURIComponent(parsed.password || '');
      const rawMessage = error instanceof Error ? error.message : 'External Postgres preflight failed.';
      const redactedMessage = [databaseUrl, password]
        .filter(Boolean)
        .reduce((message, secret) => message.split(secret).join('[Filtered]'), rawMessage);
      throw new Error(redactedMessage);
    }
    let payload: ExternalPostgresPreflightResult;
    try {
      payload = JSON.parse(result.stdout.trim()) as ExternalPostgresPreflightResult;
    } catch {
      throw new Error('External Postgres preflight returned an invalid response.');
    }
    if (!payload.databaseWritable || !payload.serverVersion) {
      throw new Error('External Postgres preflight could not verify database write access.');
    }
    if ((params.pgvectorPolicy ?? 'required') === 'required' && !payload.pgvectorAvailable) {
      throw new Error('External Postgres does not provide the required pgvector extension.');
    }
    return payload;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
