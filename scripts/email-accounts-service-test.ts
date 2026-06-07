import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') {
    return {};
  }
  return originalLoad(request, parent, isMain);
};

let tmpRoot = '';
let secretsDir = '';
let integrationsEnvPath = '';
let accountsPath = '';
let stateDir = '';

async function writeLegacyAccounts(accounts: unknown[]) {
  await fs.mkdir(path.dirname(accountsPath), { recursive: true });
  await fs.writeFile(accountsPath, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, 'utf8');
}

function legacyAccount(status: 'active' | 'expired' | 'revoked' = 'active') {
  const now = new Date().toISOString();
  return {
    id: 'local_google_test',
    provider: 'google',
    providerAccountId: 'google-user-1',
    emailAddress: 'owner@example.test',
    displayName: 'Owner Example',
    tokenType: 'Bearer',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scope: 'email profile',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    policy: { readFrom: [], sendTo: ['owner@example.test'] },
    status,
    createdAt: now,
    updatedAt: now,
  };
}

async function insertUser(userId: string, email: string) {
  const { db } = await import('../app/lib/db');
  const { user } = await import('../app/lib/db/schema');
  const now = new Date();
  await db.insert(user).values({
    id: userId,
    name: userId,
    email,
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function main() {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-email-accounts-'));
  secretsDir = path.join(tmpRoot, 'secrets');
  integrationsEnvPath = path.join(secretsDir, 'Canvas-Integrations.env');
  accountsPath = path.join(secretsDir, 'email-oauth', 'accounts.json');
  stateDir = path.join(secretsDir, 'email-oauth', '.state');

  process.env.DATA = tmpRoot;
  process.env.CANVAS_DATA_ROOT = tmpRoot;
  process.env.INTEGRATIONS_ENV_PATH = integrationsEnvPath;
  await fs.mkdir(secretsDir, { recursive: true });
  await fs.writeFile(integrationsEnvPath, '', 'utf8');

  const { createEmailDraft, disconnectEmailAccount, listEmailAccounts, saveEmailSmtpAccount, sendEmailDraft, startEmailOAuth } = await import('../app/lib/email/service');
  const { upsertOAuthEmailAccount } = await import('../app/lib/email/account-store');
  const { setSmtpTransportFactoryForTests } = await import('../app/lib/email/smtp-service');

  await insertUser('owner-user', 'owner@example.test');
  await writeLegacyAccounts([legacyAccount()]);

  const ownerBefore = await listEmailAccounts('owner-user');
  assert.equal(ownerBefore.mode, 'local');
  assert.equal(ownerBefore.accounts.length, 1);
  assert.equal((ownerBefore.accounts[0] as { id: string }).id, 'local_google_test');
  await assert.rejects(() => fs.access(accountsPath));
  await fs.access(path.join(secretsDir, 'email-oauth', 'accounts.legacy.json'));

  const otherBefore = await listEmailAccounts('other-user');
  assert.equal(otherBefore.accounts.length, 0);

  await insertUser('other-user', 'other@example.test');
  await upsertOAuthEmailAccount({
    userId: 'other-user',
    provider: 'google',
    providerAccountId: 'google-user-2',
    emailAddress: 'other@example.test',
    displayName: 'Other User',
    secret: {
      authType: 'oauth',
      tokenType: 'Bearer',
      accessToken: 'other-access',
      refreshToken: 'other-refresh',
      scope: 'email profile',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  const ownerAccounts = await listEmailAccounts('owner-user');
  const otherAccounts = await listEmailAccounts('other-user');
  assert.deepEqual(ownerAccounts.accounts.map((account) => (account as { emailAddress: string }).emailAddress), ['owner@example.test']);
  assert.deepEqual(otherAccounts.accounts.map((account) => (account as { emailAddress: string }).emailAddress), ['other@example.test']);
  await assert.rejects(() => disconnectEmailAccount('other-user', 'local_google_test'), /not found/i);

  await disconnectEmailAccount('owner-user', 'local_google_test');
  const ownerAfterDisconnect = await listEmailAccounts('owner-user');
  assert.equal(ownerAfterDisconnect.accounts.length, 0);
  assert.equal((await listEmailAccounts('other-user')).accounts.length, 1);

  await fs.writeFile(integrationsEnvPath, 'GOOGLE_OAUTH_CLIENT_ID=local-client\nGOOGLE_OAUTH_CLIENT_SECRET=local-secret\n', 'utf8');
  const oauthStart = await startEmailOAuth('owner-user', { provider: 'google', requestOrigin: 'http://localhost:3000' });
  assert.equal(oauthStart.provider, 'google');
  assert.match(oauthStart.authorizationUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/u);
  const stateFiles = await fs.readdir(stateDir);
  assert.equal(stateFiles.length, 1);
  const storedState = JSON.parse(await fs.readFile(path.join(stateDir, stateFiles[0]), 'utf8')) as { userId?: string };
  assert.equal(storedState.userId, 'owner-user');

  let verifyCalls = 0;
  const sentMessages: unknown[] = [];
  setSmtpTransportFactoryForTests((options) => ({
    options,
    verify: async () => {
      verifyCalls += 1;
      return true;
    },
    sendMail: async (message: unknown) => {
      sentMessages.push(message);
      return { messageId: 'smtp-test-message' };
    },
    close: () => undefined,
  }) as never);

  const smtpAccount = await saveEmailSmtpAccount('owner-user', {
    emailAddress: 'smtp-owner@example.test',
    displayName: 'SMTP Owner',
    smtpHost: 'smtp.example.test',
    smtpPort: 587,
    smtpSecure: false,
    smtpUsername: 'smtp-owner',
    smtpPassword: 'smtp-secret',
    policy: { sendTo: ['@example.test'] },
  }, { verify: true });
  assert.equal(verifyCalls, 1);
  assert.equal(smtpAccount.provider, 'smtp_imap');
  assert.equal(smtpAccount.authType, 'smtp_imap');
  assert.equal(smtpAccount.smtpHost, 'smtp.example.test');
  assert.equal(JSON.stringify(smtpAccount).includes('smtp-secret'), false);

  const updatedSmtpAccount = await saveEmailSmtpAccount('owner-user', {
    emailAddress: 'smtp-owner@example.test',
    displayName: null,
    smtpHost: 'smtp.example.test',
    smtpPort: 587,
    smtpSecure: false,
    smtpUsername: 'smtp-owner',
    smtpPassword: 'smtp-secret-rotated',
  });
  assert.equal(verifyCalls, 1);
  assert.equal(updatedSmtpAccount.id, smtpAccount.id);
  assert.equal(updatedSmtpAccount.displayName, null);
  assert.deepEqual(updatedSmtpAccount.policy.sendTo, ['@example.test']);

  const draftResult = await createEmailDraft('owner-user', {
    accountId: smtpAccount.id,
    to: ['recipient@example.test'],
    subject: 'SMTP draft',
    body: '<p>Hello</p>',
    is_HTML: true,
  });
  const draftId = (draftResult as { draft?: { id?: string } }).draft?.id;
  assert.ok(draftId);
  const sendResult = await sendEmailDraft('owner-user', smtpAccount.id, draftId);
  assert.equal((sendResult as { sent?: boolean }).sent, true);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual((sentMessages[0] as { to?: string[] }).to, ['recipient@example.test']);
  assert.equal((sentMessages[0] as { html?: string }).html, '<p>Hello</p>');
  await assert.rejects(() => createEmailDraft('owner-user', {
    accountId: smtpAccount.id,
    to: ['blocked@outside.test'],
    subject: 'Blocked',
    body: 'Blocked',
  }), /not allowed/i);

  setSmtpTransportFactoryForTests(null);

  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('Email accounts service test passed.');
}

main().catch(async (error) => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
