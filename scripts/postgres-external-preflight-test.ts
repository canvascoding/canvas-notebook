import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import type { DockerManager } from '../cli/src/core/docker';
import { preflightExternalPostgres } from '../cli/src/core/postgresPreflight';
import type { CanvasCliConfig } from '../cli/src/core/types';

const databaseUrl = 'postgresql://external-user:external-password@db.example.test:5432/canvas?sslmode=require';

function config(url = databaseUrl): CanvasCliConfig {
  return {
    domain: '',
    image: 'canvas-notebook:test',
    hostPort: 3000,
    containerPort: 3000,
    dataDir: '/tmp/canvas-test',
    platform: { os: 'linux', serviceMode: 'none' },
    paths: {
      installDir: '/tmp/canvas-test',
      dataDir: '/tmp/canvas-test',
      configFile: '/tmp/canvas-test/config.json',
      composeFile: '/tmp/canvas-test/compose.yaml',
      containerEnvFile: '/tmp/canvas-test/container.env',
      composeEnvFile: '/tmp/canvas-test/compose.env',
      logFile: '/tmp/canvas-test/manager.log',
    },
    swap: { enabled: false, size: '2G', file: '/swapfile', swappiness: 10 },
    autoUpdate: { enabled: false, schedule: '*-*-* 04:00:00' },
    env: {
      CANVAS_DATABASE_PROVIDER: 'postgres',
      CANVAS_POSTGRES_MODE: 'external',
      DATABASE_URL: url,
    },
  };
}

async function main() {
  let envFilePath = '';
  let envFileMode = 0;
  let envFileText = '';
  let dockerArgs: string[] = [];
  const docker = {
  async dockerOrThrow(args: string[]) {
    dockerArgs = args;
    envFilePath = args[args.indexOf('--env-file') + 1] || '';
    envFileMode = (await fs.stat(envFilePath)).mode & 0o777;
    envFileText = await fs.readFile(envFilePath, 'utf8');
    return {
      status: 0,
      stdout: JSON.stringify({
        databaseWritable: true,
        pgvectorAvailable: true,
        pgvectorVersion: '0.8.3',
        serverVersion: '18.4',
      }),
      stderr: '',
    };
  },
  } as unknown as DockerManager;

  const result = await preflightExternalPostgres({ config: config(), docker });
  assert.equal(result.databaseWritable, true);
  assert.equal(result.pgvectorAvailable, true);
  assert.equal(envFileMode, 0o600);
  assert.match(envFileText, /^DATABASE_URL=postgresql:\/\//u);
  assert.equal(JSON.stringify(dockerArgs).includes(databaseUrl), false);
  await assert.rejects(fs.access(envFilePath), /ENOENT/u);

  const noVectorDocker = {
  async dockerOrThrow() {
    return {
      status: 0,
      stdout: JSON.stringify({
        databaseWritable: true,
        pgvectorAvailable: false,
        pgvectorVersion: null,
        serverVersion: '18.4',
      }),
      stderr: '',
    };
  },
  } as unknown as DockerManager;
  await assert.rejects(
    preflightExternalPostgres({ config: config(), docker: noVectorDocker }),
    /required pgvector extension/u,
  );
  assert.equal((await preflightExternalPostgres({
    config: config(),
    docker: noVectorDocker,
    pgvectorPolicy: 'optional',
  })).pgvectorAvailable, false);

  let invalidDockerCalled = false;
  const invalidDocker = {
  async dockerOrThrow() {
    invalidDockerCalled = true;
    throw new Error('unexpected');
  },
  } as unknown as DockerManager;
  await assert.rejects(
    preflightExternalPostgres({ config: config('postgresql://missing-password@db.example.test/canvas'), docker: invalidDocker }),
    /include user, password, host, and database/u,
  );
  assert.equal(invalidDockerCalled, false);

  const leakingDocker = {
  async dockerOrThrow() {
    throw new Error(`failed ${databaseUrl} external-password`);
  },
  } as unknown as DockerManager;
  await assert.rejects(
    preflightExternalPostgres({ config: config(), docker: leakingDocker }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message.includes(databaseUrl), false);
      assert.equal(message.includes('external-password'), false);
      return true;
    },
  );

  console.log('external Postgres preflight tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
