import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';
import { getUnifiedEnvFilePath, readUnifiedEnvState, mutateUnifiedSecretValue } from '@/app/lib/secrets/unified-env-store';
import { withFileMutationLock } from '@/app/lib/secrets/file-mutation-lock';
import type { SecretDataStorageScope } from '@/app/lib/runtime-data-paths';
import { deleteEmailAccountSecret } from '@/app/lib/email/secret-store';
import { resolveRestoreTarget, assertRestoreAncestors } from './restore-plan';
import { saveRestoreJournal, type RestoreJournal } from './restore-files';

/** Use the canonical adapters; connection tombstones prevent legacy token revival. */
export async function resetMigrationSecrets(client: Client, dataRoot: string, journal: RestoreJournal): Promise<void> {
  const scopes: SecretDataStorageScope[] = [{ secretScope: 'system' }];
  for (const [directory, kind] of [['users', 'user'], ['organizations', 'organization']] as const) {
    const entries = await fs.readdir(path.join(dataRoot, directory), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    for (const entry of entries) if (entry.isDirectory()) scopes.push(kind === 'user'
      ? { secretScope: kind, userId: entry.name } : { secretScope: kind, organizationId: entry.name });
  }
  // Include DB owners even if their filesystem has not been initialized yet.
  for (const row of (await client.query<{ id: string }>('SELECT id FROM "user"')).rows) {
    if (!scopes.some(scope => scope.userId === row.id)) scopes.push({ secretScope: 'user', userId: row.id });
  }
  const emails = (await client.query<{ user_id: string; secret_ref: string }>("SELECT user_id,secret_ref FROM email_accounts WHERE auth_type='oauth'")).rows;
  journal.secretFiles ??= [];
  for (const scope of scopes) {
    const state = await readUnifiedEnvState(scope);
    if (!state.readable) throw new Error('OAuth reset requires readable target Secrets. See /settings?tab=secrets.');
    const keys = state.entries.filter(entry => entry.key === 'CANVAS_CREDENTIAL_PI_OAUTH'
      || /^CANVAS_CREDENTIAL_MCP_[a-f0-9]{64}$/u.test(entry.key)).map(entry => entry.key);
    const accounts = emails.filter(email => scope.secretScope === 'system' ? email.secret_ref.startsWith('workspace/') : email.user_id === scope.userId);
    if (!keys.length && !accounts.length) continue;
    const backup = `.restore-backups/migration-${journal.id}/secrets/${journal.secretFiles.length}`;
    const destination = resolveRestoreTarget(dataRoot, backup);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    // readUnifiedEnvState materializes legacy sources before this snapshot.
    const raw = await fs.readFile(getUnifiedEnvFilePath(scope)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0); throw error;
    });
    await fs.writeFile(destination, raw, { mode: 0o600, flag: 'wx' });
    journal.secretFiles.push({ scope, backup }); await saveRestoreJournal(journal);
    for (const key of keys) await mutateUnifiedSecretValue(key, async () => null, scope);
    for (const account of accounts) await deleteEmailAccountSecret(account.secret_ref);
  }
}

export async function restoreMigrationSecrets(dataRoot: string, journal: RestoreJournal): Promise<void> {
  for (const record of [...(journal.secretFiles ?? [])].reverse()) {
    await assertRestoreAncestors(dataRoot, record.backup);
    const raw = await fs.readFile(resolveRestoreTarget(dataRoot, record.backup));
    const filename = getUnifiedEnvFilePath(record.scope);
    await withFileMutationLock(filename, async () => {
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = filename + '.restore-' + journal.id;
      await fs.writeFile(temporary, raw, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
    });
  }
}
