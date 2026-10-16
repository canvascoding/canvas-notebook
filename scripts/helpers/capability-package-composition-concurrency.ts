import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { SqlConnection } from '../../app/lib/db';

type Packages = typeof import('../../app/lib/capabilities/packages/actions');
type Raw = Pick<SqlConnection, 'get' | 'all' | 'run'>;
type Actor = { userId: string; workspaceId: string };
type Timeouts = { lockTimeout: string; statementTimeout: string };

/** The isolated native fixture has one held raw lease; configure every remaining pool session too. */
async function withBoundedNativeQueries<T>(pool: Pool, raw: Raw, callback: () => Promise<T>): Promise<T> {
  const maximum = pool.options.max;
  assert(typeof maximum === 'number' && maximum >= 4, 'Concurrent package actions need independent native PostgreSQL leases.');
  assert.equal(pool.totalCount - pool.idleCount, 1, 'Only this isolated fixture raw connection may be held at the boundary.');
  const previous = new Map<PoolClient, Timeouts>();
  const rawSettings = await raw.get("SELECT current_setting('lock_timeout') AS \"lockTimeout\", current_setting('statement_timeout') AS \"statementTimeout\"") as Timeouts;
  const configure = async (client: PoolClient) => {
    const settings = (await client.query<Timeouts>("SELECT current_setting('lock_timeout') AS \"lockTimeout\", current_setting('statement_timeout') AS \"statementTimeout\"")).rows[0];
    previous.set(client, settings);
    await client.query("SELECT set_config('lock_timeout','45s',false),set_config('statement_timeout','60s',false)");
  };
  let clients: PoolClient[] = [];
  try {
    clients = await Promise.all(Array.from({ length: maximum - 1 }, () => pool.connect()));
    for (const client of clients) await configure(client);
    for (const client of clients) client.release();
    clients = [];
    await raw.run("SELECT set_config('lock_timeout','45s',false),set_config('statement_timeout','60s',false)");
    return await callback();
  } finally {
    if (!clients.length) clients = await Promise.all(Array.from({ length: maximum - 1 }, () => pool.connect()));
    try {
      for (const client of clients) {
        const settings = previous.get(client);
        if (settings) await client.query("SELECT set_config('lock_timeout',$1,false),set_config('statement_timeout',$2,false)",
          [settings.lockTimeout, settings.statementTimeout]);
      }
      await raw.run("SELECT set_config('lock_timeout',$1,false),set_config('statement_timeout',$2,false)",
        [rawSettings.lockTimeout, rawSettings.statementTimeout]);
    } finally { for (const client of clients) client.release(); }
  }
}

/** Real PostgreSQL overlap: neither source acquisition can continue until both native sessions are waiting. */
export async function verifyCapabilityPackageCompositionConcurrency(input: { packages: Packages; raw: Raw; owner: Actor; pool: unknown }): Promise<void> {
  assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1', 'This concurrency proof must run only against native PostgreSQL.');
  const pool = input.pool;
  assert(pool instanceof Pool, 'PGlite or a serial SQL replacement cannot prove resource-lock concurrency.');
  const { packages, raw, owner } = input;
  const engine = await raw.get('SELECT version() AS version,current_database() AS "databaseName"') as { version: string; databaseName: string };
  assert.match(engine.version, /^PostgreSQL /u);
  assert.doesNotMatch(engine.version, /pglite/iu);
  assert.match(engine.databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u, 'The raw lease must belong to the owned nonce fixture database.');
  const identityLease = await pool.connect();
  try {
    const identity = (await identityLease.query<{ databaseName: string }>('SELECT current_database() AS "databaseName"')).rows[0];
    assert.equal(identity.databaseName, engine.databaseName, 'The explicit pool and raw connection must use the same owned fixture database before mutation.');
  } finally { identityLease.release(); }
  const composition = await import('../../app/lib/capabilities/packages/composition');
  const artifacts = await import('../../app/lib/capabilities/packages/artifacts');
  const store = await import('../../app/lib/capabilities/packages/store');
  const io = await import('../../app/lib/capabilities/packages/io');
  const prepared = [];
  for (const suffix of ['a', 'b']) {
    const name = `composition-concurrency-${suffix}`, skillName = `concurrent-${suffix}-context`;
    let draft = await packages.createCapabilityPackageDraftAction(owner, { operation: 'create', kind: 'plugin', targetName: name, requestId: randomUUID() });
    const files = {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Native concurrent composition fixture', skills: 'skills' }),
      [`skills/${skillName}/SKILL.md`]: `---\nname: ${skillName}\ndescription: Native concurrent composition context\nmetadata:\n  version: "1.0.0"\n---\nConcurrent source ${suffix}.\n`,
      [`skills/${skillName}/scripts/context.js`]: `process.stdout.write("immutable-${suffix}");\n`,
    };
    for (const [file, content] of Object.entries(files)) {
      ({ draft } = await packages.writeCapabilityPackageDraftFileAction(owner, draft.draftRef, {
        expectedDraftRevision: draft.draftRevision, path: file, encoding: 'base64', content: Buffer.from(content).toString('base64'),
      }));
    }
    const published = await packages.publishCapabilityPackageDraftAction(owner, { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, expectedPackageRevision: 0, expectedPublishedRevisionRef: null, requestId: randomUUID() });
    const descriptor = await packages.inspectCapabilityPackage(owner, draft.resourceRef);
    const edit = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef: draft.resourceRef,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: published.state.packageRevision, expectedPublishedRevisionRef: published.published.revisionRef });
    const record = await store.getCapabilityPackageDraftRecord(owner, edit.draftRef);
    const location = io.resolveCapabilityPackageDraftLocation({ ...edit, owner: record.targetOwnership });
    const generationsRoot = path.dirname(path.dirname(location.rootPath));
    const source = await artifacts.resolveCapabilityPackageArtifact(owner, draft.resourceRef);
    prepared.push({ name, skillName, files, edit, published, source, location, generationsRoot,
      generations: await fs.readdir(generationsRoot), inventory: await io.readExactPackageInventory(location.rootPath) });
  }
  assert.equal(prepared.length, 2);
  const [left, right] = prepared;
  const resourceLocks = prepared.map(value => `capability-resource:${value.source.storage.resourceId}`).sort();
  assert.notEqual(resourceLocks[0], resourceLocks[1]);
  const results = await withBoundedNativeQueries(pool, raw, async () => {
    for (const key of resourceLocks) await raw.get('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof composition.composeCapabilityPackageSkillsAction>>>[]> | undefined;
    let barrierFailure: { waiting: number; activities: unknown[] } | undefined;
    try {
      const compose = (target: typeof left, source: typeof right) => composition.composeCapabilityPackageSkillsAction(owner, target.edit.draftRef, {
        expectedDraftRevision: target.edit.draftRevision,
        skills: [{ source: { resourceRef: source.edit.resourceRef, revisionRef: source.published.published.revisionRef,
          expectedChecksum: source.published.published.checksum, childRelativeRoot: `skills/${source.skillName}` } }],
      });
      pending = Promise.allSettled([compose(left, right), compose(right, left)]);
      const deadline = Date.now() + 30_000;
      let waiting = 0;
      do {
        const observation = await raw.get(`SELECT COUNT(*)::integer AS count FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND wait_event='advisory'
            AND query LIKE '%pg_advisory_xact_lock%'`) as { count: number };
        waiting = observation.count;
        if (waiting >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      if (waiting < 2) {
        const activities = await raw.all(`SELECT pid,state,wait_event_type AS "waitEventType",wait_event AS "waitEvent",
          pg_blocking_pids(pid) AS blockers,
          CASE WHEN query LIKE '%pg_advisory_xact_lock%' THEN 'resource-lock'
            WHEN query LIKE '%capability_package_drafts%' THEN 'draft-query'
            WHEN query LIKE '%capability_resources%' THEN 'resource-query'
            ELSE 'other' END AS "queryCategory"
          FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY pid`);
        barrierFailure = { waiting, activities };
      }
    } finally {
      for (const key of [...resourceLocks].reverse()) {
        const unlocked = await raw.get('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [key]) as { unlocked: boolean };
        assert.equal(unlocked.unlocked, true);
      }
      // Drain both native actions even on a failed barrier; timeouts bound failure and teardown.
      if (pending) await pending;
    }
    assert(pending);
    const outcomes = await pending;
    if (barrierFailure) {
      throw new Error('Both real composition transactions must overlap on the held source locks before release.', { cause: {
        ...barrierFailure, actions: outcomes.map(outcome => {
          if (outcome.status === 'fulfilled') return { status: outcome.status, draftRevision: outcome.value.draft.draftRevision };
          const error = outcome.reason as { name?: unknown; code?: unknown; status?: unknown } | null;
          return { status: outcome.status, errorName: typeof error?.name === 'string' ? error.name : 'UnknownError',
            errorCode: typeof error?.code === 'string' ? error.code : null, httpStatus: typeof error?.status === 'number' ? error.status : null };
        }),
      } });
    }
    return outcomes;
  });
  for (const outcome of results) assert.equal(outcome.status, 'fulfilled', outcome.status === 'rejected'
    ? String(outcome.reason?.stack ?? outcome.reason) : 'Both native composition actions must complete successfully.');
  const completed = results.map(outcome => { assert(outcome.status === 'fulfilled'); return outcome.value; });
  for (const [index, target] of prepared.entries()) {
    const source: (typeof prepared)[number] = prepared[1 - index];
    const result = completed[index];
    assert.equal(result.draft.draftRevision, target.edit.draftRevision + 1, 'Each mutually composed edit commits exactly one SQL generation.');
    const row = await raw.get('SELECT draft_revision FROM capability_package_drafts WHERE draft_ref=$1', [target.edit.draftRef]) as { draft_revision: number };
    assert.equal(row.draft_revision, target.edit.draftRevision + 1);
    assert.deepEqual((await fs.readdir(target.generationsRoot)).sort(), [...target.generations, String(target.edit.draftRevision + 1)].sort(),
      'Each action creates exactly one COW generation, without retries or abandoned partial generations.');
    assert.equal((await io.readExactPackageInventory(target.location.rootPath)).checksum, target.inventory.checksum, 'The earlier private generation remains immutable.');
    const copied = await packages.readCapabilityPackageDraftFileAction(owner, target.edit.draftRef, { path: `skills/${source.skillName}/scripts/context.js` });
    assert.equal(Buffer.from(copied.file.content, 'base64').toString(), source.files[`skills/${source.skillName}/scripts/context.js`]);
    const unchanged = await packages.inspectCapabilityPackage(owner, target.edit.resourceRef);
    assert.equal(unchanged.state?.currentPublishedRevisionRef, target.published.published.revisionRef);
    assert.equal(unchanged.sourceStamp.checksum, target.published.published.checksum, 'Mutual copying never modifies either published source.');
    assert.equal((await packages.listCapabilityPackageVersionsAction(owner, target.edit.resourceRef)).versions.length, 1);
    assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_source_captures WHERE draft_ref=$1', [target.edit.draftRef]) as { count: number }).count, 1);
  }
  console.log('PASS native PostgreSQL mutually concurrent plugin composition: observed overlapping source locks, no deadlock/retry, exactly one SQL/COW generation each and unchanged immutable sources.');
}
