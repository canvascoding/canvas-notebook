import assert from 'node:assert/strict';

const previous = {
  CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER,
  CANVAS_POSTGRES_VECTOR_ENABLED: process.env.CANVAS_POSTGRES_VECTOR_ENABLED,
  DATABASE_URL: process.env.DATABASE_URL,
};

async function main() {
  try {
    delete process.env.CANVAS_DATABASE_PROVIDER;
    process.env.DATABASE_URL = 'postgresql://canvas:test@postgres:5432/canvas';
    process.env.CANVAS_POSTGRES_VECTOR_ENABLED = 'true';
    const { getCommunityTeamRuntimeReadiness } = await import('../app/lib/license/team-runtime-readiness');
    const readiness = await getCommunityTeamRuntimeReadiness({
      postgresProbe: async () => ({
        databaseReachable: true,
        migrationsReady: true,
        pgvectorAvailable: true,
        pgvectorVersion: '0.8.3',
        organizationReady: true,
      }),
      storageProbe: async () => true,
    });
    assert.equal(readiness.databaseEngine, 'postgres');
    assert.equal(readiness.ready, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  console.log('team-runtime-postgres-inference-test: ok');
}

void main();
