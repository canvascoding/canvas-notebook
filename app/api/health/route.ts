import { NextResponse } from 'next/server';
import { openDb } from '@/app/lib/db';
import {
  resolveDatabaseProviderGate,
  toPublicDatabaseProviderStatus,
} from '@/app/lib/db/provider';
import {
  areTeamFeaturesEnabled,
  getDeploymentMode,
} from '@/app/lib/organization/bootstrap';
import { getCollaborationRuntimeHealth, setCollaborationRuntimeHealth } from '@/app/lib/collaboration/health';
import { requireRuntimeCapability, requireTeamRuntimeLicense } from '@/app/lib/license/entitlements';
import { getDirectMcpReadiness } from '@/app/lib/mcp/server/readiness';

export async function GET() {
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
  const mcpReadiness = await getDirectMcpReadiness();

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
    connection?.close();
  }

  return NextResponse.json(
    {
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
    { status }
  );
}
