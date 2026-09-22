import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';

let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
const secrets = new Map<string, unknown>();
let writes = 0;
const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') return database;
  if (request === '@/app/lib/pi/session-workspace-context') return {};
  if (request === '@/app/lib/email/secret-store') return {
    emailAccountSecretRef: (userId: string, id: string) => `${userId}/${id}`,
    writeEmailAccountSecret: async (ref: string, value: unknown) => { writes++; secrets.set(ref, value); },
    readEmailAccountSecret: async (ref: string) => secrets.get(ref),
    deleteEmailAccountSecret: async (ref: string) => { secrets.delete(ref); },
  };
  return originalLoad(request, parent, isMain);
};

async function main() {
  database = await createPiTestDatabase();
  const { emailAccounts, user } = await import('../app/lib/db/schema');
  const store = await import('../app/lib/email/account-store');
  const smtp = await import('../app/lib/email/smtp-service');
  await database.db.insert(user).values([{ id: 'owner', name: 'Owner', email: 'owner@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() }, { id: 'other', name: 'Other', email: 'other@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() }]);
  const secret = { authType: 'smtp_imap' as const, smtp: { host: 'smtp.example.test', port: 465, secure: true, username: 'mail', password: 'fixture' } };
  const personal = await store.upsertSmtpEmailAccount({ userId: 'owner', emailAddress: 'personal@example.test', secret });
  const backup = await store.upsertSmtpEmailAccount({ userId: 'owner', emailAddress: 'backup@example.test', secret });
  await database.db.update(emailAccounts).set({ isPrimary: false }).where(eq(emailAccounts.id, personal.id));
  await database.db.update(emailAccounts).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(emailAccounts.id, personal.id));
  await database.db.insert(emailAccounts).values({ id: 'business', userId: 'owner', provider: 'smtp_imap', authType: 'smtp_imap', emailAddress: 'business@example.test', secretRef: 'business-secret', accountScope: 'workspace', status: 'active', policyJson: '{}', createdAt: new Date(), updatedAt: new Date(), isPrimary: true });
  secrets.set('business-secret', secret);
  await database.db.insert(emailAccounts).values({ id: 'business-google', userId: 'owner', provider: 'google', authType: 'oauth', emailAddress: 'business-google@example.test', secretRef: 'business-google-secret', accountScope: 'workspace', status: 'active', policyJson: '{}', createdAt: new Date(), updatedAt: new Date() });
  const initialWrites = writes;
  await assert.rejects(() => store.setPrimaryStoredEmailAccount('owner', 'business'), /Personal email account not found/);
  await assert.rejects(() => store.updateStoredEmailPolicy('owner', 'business', { sendTo: ['*'] }), /Personal email account not found/);
  await assert.rejects(() => store.disconnectStoredEmailAccount('owner', 'business'), /Personal email account not found/);
  await assert.rejects(() => smtp.testStoredSmtpEmailAccount('owner', 'business'), /Personal email account not found/);
  await assert.rejects(() => smtp.testSmtpConnection('owner', { accountId: 'business' }), /Personal email account not found/);
  await assert.rejects(() => store.upsertSmtpEmailAccount({ userId: 'owner', emailAddress: 'business@example.test', secret }), /shared Business mailbox/);
  await assert.rejects(() => store.upsertSmtpEmailAccount({ userId: 'owner', accountId: 'business', emailAddress: 'changed@example.test', secret }), /cannot be changed/);
  await assert.rejects(() => store.upsertSmtpEmailAccount({ userId: 'other', accountId: personal.id, emailAddress: 'other@example.test', secret }), /cannot be changed/);
  await assert.rejects(() => store.upsertOAuthEmailAccount({ userId: 'owner', provider: 'google', emailAddress: 'business-google@example.test', secret: { authType: 'oauth', accessToken: 'fixture', tokenType: 'Bearer' } }), /shared Business mailbox/);
  await assert.rejects(() => store.upsertOAuthEmailAccount({ userId: 'owner', provider: 'google', accountId: 'business', emailAddress: 'new@example.test', secret: { authType: 'oauth', accessToken: 'fixture', tokenType: 'Bearer' } }), /cannot be changed/);
  assert.equal(writes, initialWrites, 'Rejected management and collisions must not write secrets');
  assert.equal(await store.getEmailAccountForUser('owner', 'business').then(a => a.id), 'business', 'Explicit owner-aware transport lookup remains supported');
  assert.equal(await store.getEmailAccountForUser('owner').then(a => a.id), personal.id);
  assert.equal((await database.db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, 'business') }))?.isPrimary, false);
  await store.setStoredEmailAccountStatus(personal, 'expired');
  assert.equal(await store.getEmailAccountForUser('owner').then(a => a.id), backup.id, 'Inactive primary is cleared before promoting the fallback');
  await store.setStoredEmailAccountStatus(personal, 'active');
  await store.setPrimaryStoredEmailAccount('owner', personal.id);
  await store.disconnectStoredEmailAccount('owner', personal.id);
  assert.equal(await store.getEmailAccountForUser('owner').then(a => a.id), backup.id, 'Only a personal account is promoted');
  await store.setStoredEmailAccountStatus(backup, 'expired');
  assert.equal((await store.getPersonalEmailAccountForUser('owner', backup.id)).status, 'expired');
  await assert.rejects(() => store.getEmailAccountForUser('owner', backup.id), /not found/);
  await assert.rejects(() => store.setPrimaryStoredEmailAccount('owner', backup.id), /Reconnect/);
  await store.updateStoredEmailPolicy('owner', backup.id, { sendTo: ['fixed@example.test'] });
  await database.db.update(emailAccounts).set({ status: 'expired' }).where(eq(emailAccounts.id, 'business'));
  const repairable = await store.listInactivePersonalEmailAccounts('owner');
  assert.deepEqual(repairable.map(account => account.id), [backup.id], 'Repair view excludes inactive business accounts');
  assert.equal(repairable[0].status, 'expired');
  assert.equal('secretRef' in repairable[0], false);
  assert.equal('password' in repairable[0], false);
  assert.deepEqual(await store.listInactivePersonalEmailAccounts('other'), [], 'Repair view remains owner-only');
  assert.deepEqual(await store.listEmailAccountRecordsForUser('owner'), [], 'Normal list continues to exclude expired accounts');
  await store.disconnectStoredEmailAccount('owner', backup.id);
  await assert.rejects(() => store.getEmailAccountForUser('owner'), /No active email account/);
  assert.equal((await database.db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, 'business') }))?.isPrimary, false);
  assert.deepEqual(await store.listEmailAccountRecordsForUser('other'), []);
  console.log('Personal email account boundaries passed (isolated PostgreSQL schema; no provider calls).');
}
let failed = false;
main().catch(error => { console.error(error); failed = true; }).finally(async () => { internals._load = originalLoad; await database?.close(); if (failed) process.exitCode = 1; });
