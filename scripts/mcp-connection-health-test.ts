import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function waitForChild(child: ReturnType<typeof spawn>): Promise<string> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`health reader exited ${code}: ${stderr}`)));
  });
}

async function readHealthWorker(): Promise<void> {
  const scope = { userId: process.env.MCP_CONNECTION_HEALTH_TEST_USER || '' };
  const { readMcpConfig } = await import('../app/lib/mcp/config');
  const { readMcpConnectionHealth } = await import('../app/lib/mcp/connection-health');
  const connection = (await readMcpConfig(scope)).mcpServers.remote;
  assert.ok(connection?.connectionId);
  const health = await readMcpConnectionHealth(connection as typeof connection & { connectionId: string }, scope);
  process.stdout.write(JSON.stringify(health));
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-connection-health-'));
  const userScope = { userId: 'health-owner' };
  const otherScope = { userId: 'health-foreign-user' };
  const originalEnv = {
    CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT,
    DATA: process.env.DATA,
    INTEGRATIONS_ENV_MASTER_KEY: process.env.INTEGRATIONS_ENV_MASTER_KEY,
  };
  process.env.CANVAS_DATA_ROOT = tempRoot;
  process.env.DATA = tempRoot;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(48).toString('hex');

  try {
    const { readMcpConfig, writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    const {
      claimMcpConnectionProbe,
      classifyMcpConnectionFailure,
      markMcpConnectionIncidentRead,
      readMcpConnectionHealth,
      recordMcpConnectionObservation,
    } = await import('../app/lib/mcp/connection-health');
    const { invalidateMcpOAuthGeneration } = await import('../app/lib/mcp/oauth-lifecycle');
    const { readMcpTextFileIfExists } = await import('../app/lib/mcp/storage');

    async function configure(scope: typeof userScope, enabled = true) {
      await writeMcpConfigRaw(JSON.stringify({
        settings: { toolPrefix: 'health', idleTimeout: 10 },
        mcpServers: {
          remote: {
            url: 'https://health-fixture.invalid/mcp',
            auth: 'oauth',
            enabled,
            oauth: { issuer: 'https://health-fixture.invalid', clientId: 'fixture-client' },
          },
        },
      }), scope);
      const connection = (await readMcpConfig(scope)).mcpServers.remote;
      assert.ok(connection?.connectionId);
      return connection as typeof connection & { connectionId: string };
    }

    const connection = await configure(userScope);
    const otherConnection = await configure(otherScope);
    const now = 1_750_000_000_000;

    assert.equal(classifyMcpConnectionFailure({ code: 'network_error', message: 'provider-secret-never-persisted' }), 'network_error');
    assert.equal(classifyMcpConnectionFailure({ message: 'provider-secret-never-persisted' }), null);

    await recordMcpConnectionObservation(connection, userScope, { kind: 'failure', code: 'network_error' }, { now });
    await recordMcpConnectionObservation(connection, userScope, { kind: 'failure', code: 'network_error' }, { now: now + 5_000 });
    let health = await readMcpConnectionHealth(connection, userScope);
    assert.equal(health.consecutiveFailures, 1, 'a burst in the same check window counts once');
    assert.equal(health.incident, null);

    await recordMcpConnectionObservation(connection, userScope, { kind: 'failure', code: 'network_error' }, { now: now + 31_000 });
    health = await readMcpConnectionHealth(connection, userScope);
    assert.equal(health.consecutiveFailures, 2);
    assert.equal(health.incident, null, 'fewer than three independent failures cannot create an incident');

    await recordMcpConnectionObservation(connection, userScope, { kind: 'failure', code: 'network_error' }, { now: now + 5 * 60_000 - 1 });
    health = await readMcpConnectionHealth(connection, userScope);
    assert.equal(health.consecutiveFailures, 3);
    assert.equal(health.incident, null, 'three failures before the five-minute grace period cannot create an incident');

    await recordMcpConnectionObservation(connection, userScope, { kind: 'failure', code: 'network_error' }, { now: now + 5 * 60_000 + 31_000 });
    health = await readMcpConnectionHealth(connection, userScope);
    assert.equal(health.incident?.kind, 'unreachable');
    const incidentId = health.incident?.id;
    assert.ok(incidentId);

    await recordMcpConnectionObservation(connection, userScope, { kind: 'failure', code: 'network_error' }, { now: now + 6 * 60_000 + 2_000 });
    assert.equal((await readMcpConnectionHealth(connection, userScope)).incident?.id, incidentId, 'one outage creates one durable incident');
    const readResults = await Promise.all(Array.from({ length: 12 }, () => (
      markMcpConnectionIncidentRead(connection, userScope, incidentId, now + 6 * 60_000 + 3_000)
    )));
    assert.equal(readResults.filter(Boolean).length, 1, 'marking an incident read is idempotently claimed once');
    assert.ok((await readMcpConnectionHealth(connection, userScope)).incident?.readAt);

    await recordMcpConnectionObservation(connection, userScope, { kind: 'authorized' }, { now: now + 6 * 60_000 + 4_000 });
    health = await readMcpConnectionHealth(connection, userScope);
    assert.equal(health.authStatus, 'authorized');
    assert.equal(health.incident?.id, incidentId, 'OAuth authorization alone must not clear a network outage incident');
    await recordMcpConnectionObservation(connection, userScope, { kind: 'success' }, { now: now + 6 * 60_000 + 5_000 });
    health = await readMcpConnectionHealth(connection, userScope);
    assert.equal(health.reachability, 'reachable');
    assert.equal(health.incident, null, 'a successful protocol operation resolves the incident');

    const healthFile = await readMcpTextFileIfExists(`connections/${connection.connectionId}/health.json`, userScope);
    assert.ok(healthFile.content);
    assert.doesNotMatch(healthFile.content!, /provider-secret|health-fixture\.invalid/iu, 'health persistence must contain only allowlisted status metadata');
    const durableChild = spawn(process.execPath, [
      '--import', 'tsx', '--conditions', 'react-server', path.resolve('scripts/mcp-connection-health-test.ts'), '--read-health',
    ], {
      env: { ...process.env, MCP_CONNECTION_HEALTH_TEST_USER: userScope.userId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const durableHealth = JSON.parse(await waitForChild(durableChild)) as { reachability?: string; lastSuccessfulRequestAt?: string | null };
    assert.equal(durableHealth.reachability, 'reachable', 'health state must reload from disk in a new Node process');
    assert.ok(durableHealth.lastSuccessfulRequestAt);

    const foreignBefore = await readMcpConnectionHealth(otherConnection, otherScope);
    await recordMcpConnectionObservation(connection, otherScope, { kind: 'failure', code: 'network_error' }, { now: now + 7 * 60_000 });
    const foreignAfter = await readMcpConnectionHealth(otherConnection, otherScope);
    assert.deepEqual(foreignAfter, foreignBefore, 'a foreign user cannot write health for another connection object');

    const generation = health.authGeneration;
    await invalidateMcpOAuthGeneration(connection.connectionId, userScope);
    await recordMcpConnectionObservation(connection, userScope, { kind: 'failure', code: 'network_error' }, { now: now + 7 * 60_000, generation });
    const generationCurrent = await readMcpConnectionHealth(connection, userScope);
    assert.equal(generationCurrent.authGeneration, generation + 1);
    assert.equal(generationCurrent.lastErrorCode, null, 'observations from a stale OAuth generation are ignored');

    const claimResults = await Promise.all(Array.from({ length: 24 }, () => claimMcpConnectionProbe(connection, userScope, now + 8 * 60_000)));
    assert.equal(claimResults.filter(Boolean).length, 1, 'concurrent monitor candidates may claim a probe once');

    const disabledConnection = await configure(userScope, false);
    await recordMcpConnectionObservation(disabledConnection, userScope, { kind: 'failure', code: 'network_error' }, { now: now + 9 * 60_000 });
    health = await readMcpConnectionHealth(disabledConnection, userScope);
    assert.equal(health.incident, null, 'disabled connections never create incidents');
    await recordMcpConnectionObservation(connection, userScope, { kind: 'disconnect' }, { now: now + 9 * 60_000 + 1 });
    health = await readMcpConnectionHealth(disabledConnection, userScope);
    assert.equal(health.incident, null, 'disconnect clears any connection incident');

    console.log('mcp-connection-health-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

if (process.argv.includes('--read-health')) {
  void readHealthWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
