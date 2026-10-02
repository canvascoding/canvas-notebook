/** Explicit operator CLI: read-only PostgreSQL plus an immutable private evidence bundle. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { planCollaborationRecovery, recoveryHash, type CollaborationRecoveryEvidence } from '../app/lib/collaboration/recovery-plan';
import { buildCollaborationRecoveryEvidence, loadCollaborationRecoveryRows, observeRecoveryFile } from '../app/lib/collaboration/recovery-evidence';
import { exportHistoricalCollaborationIdentities } from '../app/lib/collaboration/recovery-legacy-evidence';

async function main() {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  while (args.length) { const key = args.shift()!; const value = args.shift();
    if (!['--output', '--legacy-sqlite', '--legacy-document-ids'].includes(key) || !value || flags.has(key)) throw new Error('Invalid capture arguments.');
    flags.set(key, value); }
  const output = flags.get('--output');
  if (!output || !path.isAbsolute(output) || (flags.has('--legacy-sqlite') !== flags.has('--legacy-document-ids'))) {
    throw new Error('Usage: --output /absolute/new-directory [--legacy-sqlite /closed/read-only.sqlite --legacy-document-ids ID,ID]');
  }
  if (!process.env.DATABASE_URL || !process.env.DATA) throw new Error('DATABASE_URL and DATA are required.');
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
    const rows = await loadCollaborationRecoveryRows({ all: async (sql, values) => (await client.query(sql, values)).rows });
    const { states } = rows;
    await save('postgres-evidence.json', rows);
    const evidence: CollaborationRecoveryEvidence = buildCollaborationRecoveryEvidence(rows);
    if (flags.has('--legacy-sqlite')) {
      const sqlitePath = flags.get('--legacy-sqlite')!; if (!path.isAbsolute(sqlitePath)) throw new Error('Absolute SQLite evidence path required.');
      const ids = flags.get('--legacy-document-ids')!.split(',');
      if (ids.some(id => !evidence.states.some(state => state.documentId === id))) throw new Error('Legacy identity must refer to captured state.');
      await save('legacy-identities.json', exportHistoricalCollaborationIdentities(sqlitePath, ids));
    }
    for (const state of evidence.states) {
      if (evidence.files.some((item) => item.workspaceId === state.workspaceId && item.path === state.path)) continue;
      const fileEvidence = { workspaceId: state.workspaceId, path: state.path, hash: null as string | null, errorCode: null as string | null };
      try {
        const workspace = evidence.workspaces.find((row) => row.id === state.workspaceId);
        if (!workspace) throw new Error('workspace_missing');
        const observed = await observeRecoveryFile(workspace.rootRelativePath, state.path);
        const name = `file-${recoveryHash(state.workspaceId + '\0' + state.path)}.bin`;
        await fs.writeFile(path.join(output, name), observed.bytes, { flag: 'wx', mode: 0o600 });
        artifacts[name] = observed.hash; fileEvidence.hash = observed.hash;
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
