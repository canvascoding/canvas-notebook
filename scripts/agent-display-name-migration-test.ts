import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-bradley-display-name-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

async function main() {
  const {
    ensureCanvasAgent,
    MAIN_AGENT_DISPLAY_NAME,
  } = await import('../app/lib/agents/registry');

  const fresh = await ensureCanvasAgent();
  assert.equal(fresh.agentId, 'bradley');
  assert.equal(fresh.name, MAIN_AGENT_DISPLAY_NAME);
  assert.equal(fresh.name, 'Bradley');
  assert.equal(fresh.type, 'main');
  assert.equal(fresh.removable, false);

  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  const legacyRevision = 7;
  sqlite.prepare(`
    UPDATE agents
    SET name = 'Canvas Agent', revision = ?, updated_at = ?
    WHERE agent_id = 'bradley'
  `).run(legacyRevision, Date.now() - 10_000);

  const migrated = await ensureCanvasAgent();
  assert.equal(migrated.name, 'Bradley');
  assert.equal(migrated.revision, legacyRevision + 1);

  const repeated = await ensureCanvasAgent();
  assert.equal(repeated.name, 'Bradley');
  assert.equal(repeated.revision, migrated.revision);
  assert.equal(repeated.updatedAt, migrated.updatedAt);

  const customRevision = 19;
  const customUpdatedAt = Math.floor(Date.now() / 1_000) - 5;
  sqlite.prepare(`
    UPDATE agents
    SET name = 'Studio Companion', revision = ?, updated_at = ?
    WHERE agent_id = 'bradley'
  `).run(customRevision, customUpdatedAt);
  const beforePreservationCheck = sqlite.prepare(`
    SELECT updated_at AS updatedAt
    FROM agents
    WHERE agent_id = 'bradley'
  `).get() as { updatedAt: number };

  const preserved = await ensureCanvasAgent();
  assert.equal(preserved.name, 'Studio Companion');
  assert.equal(preserved.revision, customRevision);
  const afterPreservationCheck = sqlite.prepare(`
    SELECT updated_at AS updatedAt
    FROM agents
    WHERE agent_id = 'bradley'
  `).get() as { updatedAt: number };
  assert.equal(afterPreservationCheck.updatedAt, beforePreservationCheck.updatedAt);
  sqlite.close();

  console.log('agent-display-name-migration-test: ok');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
