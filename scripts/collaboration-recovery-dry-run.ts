/** Explicit operator CLI: read-only PostgreSQL plus an immutable private evidence bundle. */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/checkpoint';
import { serializeCanonicalText, type PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { workspaceAbsoluteRoot } from '../app/lib/workspaces/contracts';
import { planCollaborationRecovery, recoveryHash, type CollaborationRecoveryEvidence } from '../app/lib/collaboration/recovery-plan';

function postgresFlag(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new Error('Invalid PostgreSQL flag in recovery evidence.');
}

function postgresInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/u.test(value))) {
    throw new Error('Invalid PostgreSQL integer in recovery evidence.');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error('Unsafe PostgreSQL integer in recovery evidence.');
  return number;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !path.isAbsolute(args[1])) {
    throw new Error('Usage: tsx --conditions react-server scripts/collaboration-recovery-dry-run.ts --output /absolute/new-directory');
  }
  if (!process.env.DATABASE_URL || !process.env.DATA) throw new Error('DATABASE_URL and DATA are required.');
  const output = args[1];
  // Exclusive creation: never replace a previous recovery bundle.
  await fs.mkdir(output, { mode: 0o700 });
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    application_name: 'canvas-collaboration-recovery-readonly', connectionTimeoutMillis: 10_000 });
  let transaction = false;
  const artifacts: Record<string, string> = {};
  const save = async (name: string, value: unknown) => {
    const content = JSON.stringify(value, (_key, item) => item?.type === 'Buffer' && Array.isArray(item.data)
      ? { encoding: 'base64', bytes: Buffer.from(item.data).toString('base64') } : item, 2) + '\n';
    await fs.writeFile(path.join(output, name), content, { flag: 'wx', mode: 0o600 });
    artifacts[name] = recoveryHash(content);
  };
  try {
    await client.connect();
    // Do not use openDb/ensureDatabaseReady: those may run application migrations.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    const states = (await client.query("SELECT * FROM collaboration_yjs_states WHERE status='active' ORDER BY document_id LIMIT 10001")).rows;
    if (states.length > 10_000) throw new Error('Recovery scope exceeds 10000 active states; split the investigation.');
    const registry = (await client.query(`SELECT * FROM collaboration_documents WHERE workspace_id IN
      (SELECT workspace_id FROM collaboration_yjs_states WHERE status='active') ORDER BY id`)).rows;
    const workspaces = (await client.query(`SELECT * FROM canvas_workspaces WHERE id IN
      (SELECT workspace_id FROM collaboration_yjs_states WHERE status='active') ORDER BY id`)).rows;
    const receipts = (await client.query(`SELECT * FROM collaboration_file_projections WHERE document_id IN
      (SELECT document_id FROM collaboration_yjs_states WHERE status='active') ORDER BY document_id`)).rows;
    const revisionIds = [...new Set([...registry.map((item) => item.snapshot_revision_id), ...receipts.map((item) => item.revision_id)].filter(Boolean))];
    const revisions = (await client.query('SELECT * FROM file_revisions WHERE id = ANY($1::text[]) ORDER BY id', [revisionIds])).rows;
    await save('postgres-evidence.json', { states, registry, workspaces, receipts, revisions });
    const evidence: CollaborationRecoveryEvidence = {
      states: states.map((row) => {
        const state: PersistedCollaborationState = { documentId: row.document_id, workspaceId: row.workspace_id,
          organizationId: row.organization_id, path: row.path, representation: row.representation,
          lifecycleGeneration: postgresInteger(row.lifecycle_generation, 1), schemaVersion: postgresInteger(row.schema_version, 1),
          yjsState: row.yjs_state, stateVector: row.state_vector, documentSequence: postgresInteger(row.document_sequence),
          checkpointSequence: postgresInteger(row.checkpoint_sequence), persistedAt: postgresInteger(row.persisted_at),
          checkpointedAt: row.checkpointed_at === null ? null : postgresInteger(row.checkpointed_at), canonicalHash: row.canonical_hash,
          serializedHash: row.serialized_hash, newlineStyle: row.newline_style, hasBom: postgresFlag(row.has_bom),
          degraded: postgresFlag(row.degraded), status: 'active' };
        let computedSerializedHash: string | null = null;
        let validationCode: string | null = null;
        try { computedSerializedHash = recoveryHash(serializeCanonicalText(authoritativeCollaborationSnapshot(state).canonicalContent, state)); }
        catch (error) { validationCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : 'snapshot_invalid'; }
        return { documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId, path: state.path,
          lifecycleGeneration: state.lifecycleGeneration, documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence,
          representation: state.representation, schemaVersion: state.schemaVersion, newlineStyle: state.newlineStyle, hasBom: state.hasBom,
          stateVector: Buffer.from(state.stateVector).toString('base64'), yjsHash: recoveryHash(state.yjsState),
          canonicalHash: state.canonicalHash, serializedHash: state.serializedHash, computedSerializedHash,
          validationCode, degraded: state.degraded };
      }),
      registry: registry.map((row) => ({ id: row.id, workspaceId: row.workspace_id, organizationId: row.organization_id,
        path: row.path, provider: row.provider, status: row.status, workspaceType: row.workspace_type,
        snapshotRevisionId: row.snapshot_revision_id })),
      workspaces: workspaces.map((row) => ({ id: row.id, organizationId: row.organization_id, type: row.type, status: row.status,
        rootRelativePath: row.root_relative_path })), files: [],
    };
    const candidates = planCollaborationRecovery(evidence).cases;
    for (const candidate of candidates) {
      const state = candidate.preconditions.orphan;
      if (evidence.files.some((item) => item.workspaceId === state.workspaceId && item.path === state.path)) continue;
      const fileEvidence = { workspaceId: state.workspaceId, path: state.path, hash: null as string | null, errorCode: null as string | null };
      try {
        const workspace = workspaces.find((row) => row.id === state.workspaceId);
        if (!workspace) throw new Error('workspace_missing');
        const root = await fs.realpath(workspaceAbsoluteRoot(workspace.root_relative_path));
        const target = path.resolve(root, state.path);
        if (!target.startsWith(root + path.sep) || state.path.includes('\0')) throw new Error('scope_invalid');
        const parent = await fs.realpath(path.dirname(target));
        if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('scope_invalid');
        const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size > 5 * 1024 * 1024) throw new Error('file_unsupported');
          const bytes = await handle.readFile();
          const after = await handle.stat();
          if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('file_changed');
          const name = `file-${recoveryHash(state.workspaceId + '\0' + state.path)}.bin`;
          await fs.writeFile(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 });
          artifacts[name] = recoveryHash(bytes); fileEvidence.hash = artifacts[name];
        } finally { await handle.close(); }
      } catch (error) {
        fileEvidence.errorCode = error && typeof error === 'object' && 'code' in error
          && typeof error.code === 'string' && /^(ENOENT|EACCES|ELOOP)$/u.test(error.code) ? error.code : 'file_unverified';
      }
      evidence.files.push(fileEvidence);
    }
    await client.query('COMMIT'); transaction = false;
    const plan = planCollaborationRecovery(evidence);
    await save('evidence.json', evidence); await save('plan.json', plan);
    await save('manifest.json', { version: 1, complete: true, capturedAt: new Date().toISOString(),
      activeStates: states.length, orphanCases: plan.cases.length, artifacts,
      consistency: 'PostgreSQL repeatable-read; files independently observed. Recheck under mutation lock before repair.' });
    // No filenames, document contents, connection strings or raw exceptions.
    console.log(JSON.stringify({ complete: true, activeStates: states.length, orphanCases: plan.cases.length,
      plannedRestores: plan.cases.filter((item) => item.proposedAction === 'restore_current_snapshot_after_approval').length, planId: plan.planId }));
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

main().catch(() => { console.error('Recovery dry-run failed; an incomplete bundle must not authorize repair.'); process.exitCode = 1; });
