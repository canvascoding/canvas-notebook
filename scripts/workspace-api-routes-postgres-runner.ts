import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { Pool } from 'pg';

function localPostgresUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  const socketHost = url.searchParams.get('host');
  const isLocalUnixSocket = !url.hostname
    && socketHost !== null
    && (socketHost === '/var/run/postgresql' || socketHost.startsWith('/var/run/postgresql/'));
  const ipv4 = url.hostname.split('.').map((part) => Number.parseInt(part, 10));
  const isPrivateIpv4 = ipv4.length === 4
    && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (
      ipv4[0] === 10
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168)
    );
  const privateNetworkAllowed = process.env.CANVAS_WORKSPACE_API_TEST_ALLOW_PRIVATE_NETWORK === 'true';
  assert(
    localHosts.has(url.hostname) || isLocalUnixSocket || (isPrivateIpv4 && privateNetworkAllowed),
    'Workspace API route tests require a local PostgreSQL server; private-network databases require explicit test opt-in and public databases are refused.',
  );
  assert(
    url.protocol === 'postgres:' || url.protocol === 'postgresql:',
    'Workspace API route tests require a PostgreSQL DATABASE_URL.',
  );
  return url;
}

function databaseUrl(baseUrl: URL, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function runRouteAssertions(databaseUrlValue: string): Promise<void> {
  const testScript = path.resolve(process.cwd(), 'scripts/workspace-api-routes-test.ts');
  const child = spawn(
    process.execPath,
    ['--conditions=react-server', '--import=tsx', testScript],
    {
      env: {
        ...process.env,
        CANVAS_WORKSPACE_API_TEST_CHILD: 'true',
        DATABASE_URL: databaseUrlValue,
      },
      stdio: 'inherit',
    },
  );
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(
    result.code,
    0,
    result.signal
      ? `Workspace API route test child exited via ${result.signal}.`
      : `Workspace API route test child exited with code ${result.code}.`,
  );
}

async function main(): Promise<void> {
  const configuredDatabaseUrl = process.env.DATABASE_URL?.trim();
  assert(configuredDatabaseUrl, 'Workspace API route tests require a local PostgreSQL DATABASE_URL.');
  const baseDatabaseUrl = localPostgresUrl(configuredDatabaseUrl);
  const testDatabaseName = `canvas_workspace_api_test_${process.pid}_${Date.now()}`;
  const adminPool = new Pool({
    connectionString: databaseUrl(baseDatabaseUrl, 'postgres'),
    max: 1,
  });
  let databaseCreated = false;

  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`);
    databaseCreated = true;
    await runRouteAssertions(databaseUrl(baseDatabaseUrl, testDatabaseName));
  } finally {
    try {
      if (databaseCreated) {
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabaseName)}`);
      }
    } finally {
      await adminPool.end();
    }
  }
}

void main().then(
  () => console.log('workspace api route PostgreSQL test database cleaned up'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
