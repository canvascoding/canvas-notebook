import { NextResponse } from 'next/server';
import { ensureAuthReady } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import {
  resolveDatabaseProviderGate,
  toPublicDatabaseProviderStatus,
} from '@/app/lib/db/provider';
import {
  areTeamFeaturesEnabled,
  getDeploymentMode,
} from '@/app/lib/organization/config';
import { getCollaborationRuntimeHealth, setCollaborationRuntimeHealth } from '@/app/lib/collaboration/health';
import { requireRuntimeCapability, requireTeamRuntimeLicense } from '@/app/lib/license/entitlements';
import { getDirectMcpReadiness } from '@/app/lib/mcp/server/readiness';
import type { DirectMcpReadiness } from '@/app/lib/mcp/server/readiness';
import { createCachedAsyncCheck, HealthCheckTimeoutError, withHealthCheckTimeout } from '@/app/lib/health/async-check';

const getCachedDirectMcpReadiness = createCachedAsyncCheck(getDirectMcpReadiness, 30_000);

function resolveHealthCheckTimeout(): number {
  const parsed = Number.parseInt(process.env.CANVAS_HEALTH_CHECK_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : 5_000;
}

async function performHealthChecks() {
  const checks: Record<string, 'ok' | 'error'> = {
    app: 'ok',
    databaseProvider: 'ok',
  };

  let status = 200;
  let connection: Awaited<ReturnType<typeof openDb>> | null = null;
  const deploymentMode = getDeploymentMode();
  const teamFeaturesEnabled = areTeamFeaturesEnabled(deploymentMode);
  const providerGate = resolveDatabaseProviderGate({ teamFeaturesEnabled });
  const collaboration = getCollaborationRuntimeHealth();
  try {
    await ensureAuthReady();
    checks.auth = 'ok';
  } catch {
    checks.auth = 'error';
    status = 503;
  }
  let mcpReadiness: DirectMcpReadiness;
  try {
    mcpReadiness = await getCachedDirectMcpReadiness();
  } catch {
    mcpReadiness = { status: 'failed', code: 'MCP_TRANSPORT_UNAVAILABLE' };
  }

  checks.mcp = mcpReadiness.status === 'failed' ? 'error' : 'ok';
  if (mcpReadiness.status === 'failed') status = 503;

  if (!providerGate.ok) {
    checks.databaseProvider = 'error';
    status = 503;
  }

  if (teamFeaturesEnabled) {
    try {
      await requireTeamRuntimeLicense();
      await requireRuntimeCapability('liveCollaboration');
      collaboration.capabilityReady = true;
    } catch {
      collaboration.capabilityReady = false;
    }
  }

  try {
    connection = await openDb();
    await connection.get('SELECT 1');
    checks.db = 'ok';
    if (teamFeaturesEnabled) {
      if (collaboration.capabilityReady) {
        try {
          await connection.get('SELECT 1 AS ok FROM collaboration_yjs_states LIMIT 1');
          await connection.get('SELECT 1 AS ok FROM collaboration_excalidraw_states LIMIT 1');
          await connection.get('SELECT 1 AS ok FROM collaboration_excalidraw_assets LIMIT 1');
          collaboration.persistenceReady = true;
          collaboration.scenePersistenceReady = true;
          collaboration.assetStoreReady = true;
        } catch {
          collaboration.persistenceReady = false;
          collaboration.scenePersistenceReady = false;
          collaboration.assetStoreReady = false;
        }
        checks.collaboration = collaboration.websocketReady
          && collaboration.persistenceReady
          && collaboration.excalidrawWebsocketReady
          && collaboration.scenePersistenceReady
          && collaboration.assetStoreReady
          ? 'ok'
          : 'error';
        if (checks.collaboration === 'error') status = 503;
      }
      setCollaborationRuntimeHealth({
        capabilityReady: collaboration.capabilityReady,
        persistenceReady: collaboration.persistenceReady,
        scenePersistenceReady: collaboration.scenePersistenceReady,
        assetStoreReady: collaboration.assetStoreReady,
      });
    }
  } catch {
    checks.db = 'error';
    status = 503;
  } finally {
    await connection?.close();
  }

  return {
    body: {
      status: status === 200 ? 'healthy' : 'unhealthy',
      checks,
      database: toPublicDatabaseProviderStatus(providerGate),
      deployment: {
        mode: deploymentMode,
        teamFeaturesEnabled,
      },
      collaboration: {
        enabled: teamFeaturesEnabled && checks.collaboration === 'ok' && getCollaborationRuntimeHealth().capabilityReady,
        ...getCollaborationRuntimeHealth(),
      },
      mcp: mcpReadiness,
      timestamp: new Date().toISOString(),
    },
    status,
  };
}

// An HTTP timeout does not cancel a query/acquisition. Keep the entire check
// in flight until its work and cleanup finish, so repeated polls cannot queue
// new leases. A zero TTL shares only in-flight work, not completed DB results.
const getInFlightHealthChecks = createCachedAsyncCheck(performHealthChecks, 0);

export async function GET() {
  const timeoutMillis = resolveHealthCheckTimeout();
  try {
    const result = await withHealthCheckTimeout('Application health check', getInFlightHealthChecks(), timeoutMillis);
    // Construct a fresh Response per request; never share a consumable body.
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'unhealthy',
        checks: { app: 'ok', healthCheck: 'error' },
        mcp: { status: 'failed', code: error instanceof HealthCheckTimeoutError ? 'MCP_READINESS_TIMEOUT' : 'MCP_TRANSPORT_UNAVAILABLE' },
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
