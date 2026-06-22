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

  if (!providerGate.ok) {
    checks.databaseProvider = 'error';
    status = 503;
  }

  try {
    connection = await openDb();
    connection.get('SELECT 1');
    checks.db = 'ok';
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
      timestamp: new Date().toISOString(),
    },
    { status }
  );
}
