import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NextRequest } from 'next/server';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const rollback = gate(), releaseRollback = gate();
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  let child: ChildProcess | undefined;
  let childClosed: Promise<void> | undefined;
  const originalRm = fs.rm;
  const originalPythonPath = process.env.CANVAS_PYTHON_PATH;
  try {
    const management = await import('../app/lib/agents/management-actions');
    const registry = await import('../app/lib/agents/registry');
    const dataPaths = await import('../app/lib/runtime-data-paths');
    const actor = { ...fixture.owner, source: 'api' as const };
    const id = `creation-lease-${randomUUID().slice(0, 8)}`;
    const extensions: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed',
      selections: [], workflow: null, standalone: [] };
    let firstRolledBack = false, insertCount = 0, secondSettled = false;
    const events: string[] = [];
    fixture.setAfterQuery(async (query, parameters) => {
      if (/INSERT INTO agents\s*\(/u.test(query) && parameters.includes(id)) {
        insertCount++; events.push(`insert-${insertCount}`);
      }
      if (query === 'ROLLBACK' && !firstRolledBack) {
        firstRolledBack = true; events.push('first-sql-rolled-back'); rollback.release();
        await releaseRollback.promise;
      }
    });
    first = management.createManagedAgent(actor, { name: id.replace(/-/gu, ' ').toUpperCase(),
      scopeType: 'organization', extensions, files: { 'AGENTS.md': 'First partial definition.', 'MEMORY.md': 'x'.repeat(6_145) } })
      .then(() => { throw new Error('The actual oversized MEMORY.md must fail.'); }, error => {
        assert.match(String(error), /MEMORY\.md is too large/u); events.push('first-cleanup-complete');
      });
    await Promise.race([rollback.promise, delay(20_000, undefined, { ref: false }).then(() => { throw new Error('Actual first rollback was not reached.'); })]);
    assert.equal(await registry.getAgentProfile(id), null, 'Actual SQL rollback has already removed the first profile.');
    // Inspect storage through the real scoped reader, without a committed agent.
    const storage = await import('../app/lib/agents/storage');
    const scope = { organizationId: fixture.organizationId, agentScopeType: 'organization' as const, userId: actor.userId };
    assert.equal(await storage.readManagedAgentFile('AGENTS.md', id, scope), 'First partial definition.\n');
    const childAttempt = gate(), childAcquire = gate();
    let childAcquired = false, childError: unknown;
    child = fork(path.join(process.cwd(), 'scripts/helpers/agent-creation-lease-child.ts'), [id], {
      execArgv: ['--import', 'tsx', '--conditions', 'react-server'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env },
    });
    childClosed = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('exit', code => {
      if (code === 0) resolve(); else reject(new Error(`Creation lease child exited ${code}.`));
    }); });
    // Attach a rejection observer before awaiting the controlled process gates.
    void childClosed.catch(error => { childError = error; childAttempt.release(); childAcquire.release(); });
    child.on('message', message => {
      if (message === 'attempting') childAttempt.release();
      else if (message === 'acquired') { childAcquired = true; childAcquire.release(); }
      else if (message && typeof message === 'object' && 'error' in message) {
        childError = message.error; childAttempt.release(); childAcquire.release();
      }
    });
    await Promise.race([childAttempt.promise, delay(20_000, undefined, { ref: false }).then(() => { throw new Error('Child did not attempt the actual lease.'); })]);
    assert.equal(childError, undefined);
    second = management.createManagedAgent(actor, { name: 'Second successful create', agentId: id,
      scopeType: 'organization', extensions, files: { 'AGENTS.md': 'Second durable definition.', 'MEMORY.md': 'Second runtime memory.' } })
      .then(value => { secondSettled = true; events.push('second-committed'); return value; }, error => {
        secondSettled = true; throw error;
      });
    // Deterministically keep the first action after SQL rollback and before file
    // cleanup, the exact former race window. No database lock can protect it.
    await delay(150);
    assert.equal(childAcquired, false, 'An independent Node process cannot enter the held Create lifecycle; actual kernel flock is required.');
    assert.equal(secondSettled, false, 'Second public Create waits for the storage lifecycle, even after SQL rollback.');
    assert.equal(insertCount, 1, 'Second Create has not inserted a new target before first cleanup.');
    releaseRollback.release();
    await first;
    await Promise.race([childAcquire.promise, delay(20_000, undefined, { ref: false }).then(() => { throw new Error('Child did not acquire the released lease.'); })]);
    assert.equal(childError, undefined); assert.equal(childAcquired, true);
    await childClosed;
    const created = await second as Awaited<ReturnType<typeof management.createManagedAgent>>;
    assert.equal(created.agent.agentId, id);
    assert.equal((await registry.getAgentProfile(id))?.name, 'Second successful create');
    assert.equal(await storage.readManagedAgentFile('AGENTS.md', id, scope), 'Second durable definition.\n');
    assert.equal(await storage.readManagedAgentFile('MEMORY.md', id, { ...scope, agentScopeType: 'user', ownerUserId: actor.userId }), 'Second runtime memory.\n');
    assert.deepEqual(events, ['insert-1', 'first-sql-rolled-back', 'first-cleanup-complete', 'insert-2', 'second-committed']);

    const preview = await management.previewManagedAgentDeletion(actor, id);
    const deletionReached = gate(), releaseDeletion = gate();
    const definitionDirectory = path.join(dataPaths.resolveOrganizationAgentsDir(fixture.organizationId), id);
    let heldDelete = false, recreateSettled = false;
    // Only schedule the owned real rm call; SQL, permissions, token verification
    // and the eventual filesystem mutation all remain the production methods.
    fs.rm = async (target, options) => {
      if (!heldDelete && target === definitionDirectory) {
        heldDelete = true; deletionReached.release(); await releaseDeletion.promise;
      }
      return originalRm(target, options);
    };
    const deletion = management.deleteManagedAgent({ actor, agentId: id, expectedRevision: preview.agent.revision,
      confirmationToken: preview.confirmationToken });
    try {
      await Promise.race([deletionReached.promise, delay(20_000, undefined, { ref: false }).then(() => { throw new Error('Actual Delete file cleanup was not reached.'); })]);
      assert.equal(await registry.getAgentProfile(id), null);
      second = management.createManagedAgent(actor, { name: 'Successful recreate', agentId: id, scopeType: 'organization',
        extensions, files: { 'AGENTS.md': 'Recreated durable instructions.' } }).then(value => { recreateSettled = true; return value; });
      await delay(150);
      assert.equal(recreateSettled, false, 'Recreate waits for real old Delete cleanup after the old SQL row disappears.');
      releaseDeletion.release(); await deletion;
      const recreated = await second as Awaited<ReturnType<typeof management.createManagedAgent>>;
      assert.notEqual(recreated.agent.id, preview.agent.id);
      assert.equal(recreated.agent.revision, preview.agent.revision, 'Revisions may restart for a new incarnation.');
      assert.equal(await storage.readManagedAgentFile('AGENTS.md', id, scope), 'Recreated durable instructions.\n');
      await assert.rejects(management.deleteManagedAgent({ actor, agentId: id, expectedRevision: recreated.agent.revision,
        confirmationToken: preview.confirmationToken }), { code: 'AGENT_DELETE_CONFIRMATION_STALE', status: 409 });
      assert.equal((await registry.getAgentProfile(id))?.id, recreated.agent.id);
    } finally { releaseDeletion.release(); await Promise.allSettled([deletion]); fs.rm = originalRm; }

    const uncertainId = `${id}-commit`;
    let lostResponse = false;
    fixture.setAfterQuery(async query => {
      if (query === 'COMMIT' && !lostResponse) {
        lostResponse = true; throw new Error('Owned transport fixture: response lost after actual COMMIT.');
      }
    });
    await assert.rejects(management.createManagedAgent(actor, { name: 'Actually committed', agentId: uncertainId, scopeType: 'organization',
      extensions, files: { 'AGENTS.md': 'Committed definition survives.', 'MEMORY.md': 'Committed memory survives.' } }),
    { code: 'AGENT_CREATE_OUTCOME_UNKNOWN', status: 409 });
    fixture.setAfterQuery(undefined);
    assert.equal(lostResponse, true);
    assert.equal((await registry.getAgentProfile(uncertainId))?.name, 'Actually committed');
    assert.equal(await storage.readManagedAgentFile('AGENTS.md', uncertainId, scope), 'Committed definition survives.\n');
    assert.equal(await storage.readManagedAgentFile('MEMORY.md', uncertainId, { ...scope, agentScopeType: 'user', ownerUserId: actor.userId }), 'Committed memory survives.\n');

    const uncertainBeforeCommitId = `${id}-unconfirmed-abort`;
    let rollbackResponseLost = false;
    fixture.setAfterQuery(async query => {
      if (query === 'ROLLBACK' && !rollbackResponseLost) {
        rollbackResponseLost = true; throw new Error('Owned transport fixture: abort acknowledgement was lost.');
      }
    });
    await assert.rejects(management.createManagedAgent(actor, { name: 'Abort not confirmed', agentId: uncertainBeforeCommitId,
      scopeType: 'organization', extensions, files: { 'AGENTS.md': 'Uncertain partial definition.', 'MEMORY.md': 'x'.repeat(6_145) } }),
    { code: 'AGENT_CREATE_OUTCOME_UNKNOWN', status: 409 });
    fixture.setAfterQuery(undefined);
    assert.equal(rollbackResponseLost, true); assert.equal(await registry.getAgentProfile(uncertainBeforeCommitId), null);
    assert.equal(await storage.readManagedAgentFile('AGENTS.md', uncertainBeforeCommitId, scope), 'Uncertain partial definition.\n',
      'Even fresh row absence is insufficient without confirmation from the original SQL abort.');

    const casId = `${id}-delete-cas`;
    const cas = await management.createManagedAgent(actor, { name: 'Delete CAS target', agentId: casId, scopeType: 'organization', extensions,
      files: { 'AGENTS.md': 'Live definition must survive a lost delete CAS.' } });
    const casSessionId = `${casId}-session`;
    await fixture.sql.run(`INSERT INTO pi_sessions (session_id,user_id,agent_id,provider,model,created_at,updated_at,organization_id,workspace_id)
      VALUES ($1,$2,$3,'fixture','fixture',1,1,$4,$5)`, [casSessionId, actor.userId, casId, fixture.organizationId, actor.workspaceId]);
    const casPreview = await management.previewManagedAgentDeletion(actor, casId);
    const queryable = fixture.database.getPostgresRuntimeQueryable();
    const originalQuery = Reflect.get(queryable, 'query') as (...args: unknown[]) => Promise<unknown>;
    let updateWon = false;
    Reflect.set(queryable, 'query', async (...args: unknown[]) => {
      const first = args[0] as { text?: string; values?: unknown[] } | string;
      const statement = typeof first === 'string' ? first : first.text ?? '';
      const values = Array.isArray(args[1]) ? args[1] : typeof first === 'object' ? first.values ?? [] : [];
      if (!updateWon && /^delete from "agents"(?:\s|$)/iu.test(statement) && values.includes(casId)) {
        updateWon = true;
        await registry.updateAgentProfile({ agentId: casId, expectedRevision: cas.agent.revision, name: 'Concurrent update won' });
      }
      return Reflect.apply(originalQuery, queryable, args);
    });
    try {
      await assert.rejects(management.deleteManagedAgent({ actor, agentId: casId, expectedRevision: casPreview.agent.revision,
        confirmationToken: casPreview.confirmationToken }), { code: 'AGENT_REVISION_CONFLICT' });
      assert.equal(updateWon, true);
      assert.equal((await registry.getAgentProfile(casId))?.revision, cas.agent.revision + 1);
      assert.ok(await fixture.sql.get('SELECT id FROM pi_sessions WHERE session_id=$1', [casSessionId]), 'A lost delete CAS preserves its actual session too.');
      assert.equal(await storage.readManagedAgentFile('AGENTS.md', casId, scope), 'Live definition must survive a lost delete CAS.\n');
    } finally { Reflect.set(queryable, 'query', originalQuery); }

    process.env.CANVAS_PYTHON_PATH = path.join(fixture.root, 'does-not-exist-python');
    const route = await import('../app/api/agents/route');
    const lockId = `${id}-lock`;
    const failedLock = await route.POST(new NextRequest(`http://localhost:3001/api/agents?workspaceId=${actor.workspaceId}`, {
      method: 'POST', headers: fixture.headers(actor.userId), body: JSON.stringify({ name: 'Real unavailable lock', agentId: lockId, extensions }),
    }));
    assert.equal(failedLock.status, 503, JSON.stringify(await failedLock.clone().json()));
    const lockReply = await failedLock.json();
    assert.equal(lockReply.code, 'FILE_MUTATION_LOCK_UNAVAILABLE'); assert.equal(lockReply.retryable, false);
    assert.equal(JSON.stringify(lockReply).includes(fixture.root), false, 'Public error never exposes helper stderr or private paths.');
    assert.equal(await registry.getAgentProfile(lockId), null);
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} Agent lifecycle: normalized Create collision, real kernel flock in second process, confirmed SQL abort cleanup, uncertain COMMIT/abort retains files, Delete/recreate and actual delete-CAS fencing, incarnation-bound confirmation, real lock-unavailable HTTP503; provider IO zero.`);
  } finally {
    fs.rm = originalRm;
    if (originalPythonPath === undefined) delete process.env.CANVAS_PYTHON_PATH; else process.env.CANVAS_PYTHON_PATH = originalPythonPath;
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (childClosed) await Promise.allSettled([childClosed]);
    releaseRollback.release(); fixture.setAfterQuery(undefined);
    await Promise.allSettled([first, second].filter((value): value is Promise<unknown> => Boolean(value)));
    await fixture.close();
    await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
