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

  const { createEmailDraft, disconnectEmailAccount, getEmailOAuthStatus, listEmailAccounts, readEmailMessage, saveEmailSmtpAccount, searchEmail, sendEmailDraft, setEmailMainAccount, startEmailOAuth } = await import('../app/lib/email/service');
  const { upsertOAuthEmailAccount } = await import('../app/lib/email/account-store');
  const { setSmtpTransportFactoryForTests } = await import('../app/lib/email/smtp-service');
  const { setImapClientFactoryForTests } = await import('../app/lib/email/imap-service');

  await insertUser('owner-user', 'owner@example.test');
  await writeLegacyAccounts([legacyAccount()]);

  const ownerBefore = await listEmailAccounts('owner-user');
  assert.equal(ownerBefore.mode, 'local');
  assert.equal(ownerBefore.accounts.length, 1);
  assert.equal((ownerBefore.accounts[0] as { id: string }).id, 'local_google_test');
  assert.equal((ownerBefore.accounts[0] as { isPrimary?: boolean }).isPrimary, true);
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

  delete process.env.EMAIL_OAUTH_BASE_URL;
  delete process.env.OAUTH_BASE_URL;
  delete process.env.BASE_URL;
  delete process.env.APP_BASE_URL;
  delete process.env.BETTER_AUTH_BASE_URL;
  await fs.writeFile(integrationsEnvPath, 'GOOGLE_OAUTH_CLIENT_ID=local-client\nGOOGLE_OAUTH_CLIENT_SECRET=local-secret\n', 'utf8');
  const oauthStart = await startEmailOAuth('owner-user', { provider: 'google', requestOrigin: 'https://canvas.example.com' });
  assert.equal(oauthStart.provider, 'google');
  assert.match(oauthStart.authorizationUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/u);
  const oauthStartUrl = new URL(oauthStart.authorizationUrl);
  assert.equal(oauthStartUrl.searchParams.get('redirect_uri'), 'https://canvas.example.com/api/email/oauth/callback');
  const oauthStatus = await getEmailOAuthStatus({ requestOrigin: 'https://canvas.example.com' });
  assert.equal(oauthStatus.redirectUri, 'https://canvas.example.com/api/email/oauth/callback');
  assert.equal(oauthStatus.providers.google.configured, true);
  assert.equal(oauthStatus.providers.microsoft.configured, false);
  const stateFiles = await fs.readdir(stateDir);
  assert.equal(stateFiles.length, 1);
  const storedState = JSON.parse(await fs.readFile(path.join(stateDir, stateFiles[0]), 'utf8')) as { userId?: string; redirectUri?: string };
  assert.equal(storedState.userId, 'owner-user');
  assert.equal(storedState.redirectUri, 'https://canvas.example.com/api/email/oauth/callback');

  process.env.EMAIL_OAUTH_BASE_URL = 'https://oauth.example.com/custom/path';
  const overriddenOAuthStart = await startEmailOAuth('owner-user', { provider: 'google', requestOrigin: 'https://canvas.example.com' });
  const overriddenOAuthStartUrl = new URL(overriddenOAuthStart.authorizationUrl);
  assert.equal(overriddenOAuthStartUrl.searchParams.get('redirect_uri'), 'https://oauth.example.com/api/email/oauth/callback');

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
  assert.equal(smtpAccount.isPrimary, true);
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
  assert.equal(updatedSmtpAccount.isPrimary, true);
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

  let imapConnectCalls = 0;
  let imapLogoutCalls = 0;
  let imapReleaseCalls = 0;
  const allowedRaw = Buffer.from([
    'From: Allowed Sender <allowed@example.test>',
    'To: smtp-owner@example.test',
    'Subject: Allowed IMAP message',
    'Date: Tue, 02 Jan 2024 10:00:00 +0000',
    '',
    'Allowed body text from IMAP.',
  ].join('\r\n'));
  const blockedRaw = Buffer.from([
    'From: Blocked Sender <blocked@outside.test>',
    'To: smtp-owner@example.test',
    'Subject: Blocked IMAP message',
    'Date: Tue, 02 Jan 2024 09:00:00 +0000',
    '',
    'Blocked body text from IMAP.',
  ].join('\r\n'));
  const imapMessages = new Map<number, unknown>([
    [1001, {
      uid: 1001,
      threadId: 'blocked-thread',
      envelope: {
        subject: 'Blocked IMAP message',
        date: new Date('2024-01-02T09:00:00Z'),
        from: [{ name: 'Blocked Sender', address: 'blocked@outside.test' }],
        to: [{ address: 'smtp-owner@example.test' }],
      },
      internalDate: new Date('2024-01-02T09:00:00Z'),
      source: blockedRaw,
    }],
    [1002, {
      uid: 1002,
      threadId: 'allowed-thread',
      envelope: {
        subject: 'Allowed IMAP message',
        date: new Date('2024-01-02T10:00:00Z'),
        from: [{ name: 'Allowed Sender', address: 'allowed@example.test' }],
        to: [{ address: 'smtp-owner@example.test' }],
      },
      internalDate: new Date('2024-01-02T10:00:00Z'),
      source: allowedRaw,
    }],
  ]);
  setImapClientFactoryForTests(() => ({
    connect: async () => {
      imapConnectCalls += 1;
    },
    logout: async () => {
      imapLogoutCalls += 1;
    },
    close: () => undefined,
    getMailboxLock: async () => ({
      release: () => {
        imapReleaseCalls += 1;
      },
    }),
    search: async () => [1001, 1002],
    fetch: async function* (range: number[]) {
      for (const uid of range) {
        const message = imapMessages.get(uid);
        if (message) yield message as never;
      }
    },
    fetchOne: async (seq: number) => (imapMessages.get(seq) || false) as never,
  }) as never);

  const smtpImapAccount = await saveEmailSmtpAccount('owner-user', {
    emailAddress: 'smtp-imap-owner@example.test',
    displayName: 'SMTP IMAP Owner',
    smtpHost: 'smtp.example.test',
    smtpPort: 587,
    smtpSecure: false,
    smtpUsername: 'smtp-imap-owner',
    smtpPassword: 'smtp-secret',
    imapHost: 'imap.example.test',
    imapPort: 993,
    imapSecure: true,
    imapUsername: 'smtp-imap-owner',
    imapPassword: 'imap-secret',
    policy: { readFrom: ['@example.test'], sendTo: ['@example.test'] },
  }, { verify: true });
  assert.equal(imapConnectCalls, 1);
  assert.equal(imapLogoutCalls, 1);
  assert.equal(smtpImapAccount.isPrimary, false);
  assert.equal(smtpImapAccount.imapHost, 'imap.example.test');
  assert.equal(JSON.stringify(smtpImapAccount).includes('imap-secret'), false);

  await assert.rejects(() => setEmailMainAccount('other-user', smtpImapAccount.id), /not found/i);
  const mainAccount = await setEmailMainAccount('owner-user', smtpImapAccount.id);
  assert.equal(mainAccount.id, smtpImapAccount.id);
  assert.equal(mainAccount.isPrimary, true);
  const accountsAfterMainChange = await listEmailAccounts('owner-user');
  assert.equal((accountsAfterMainChange.accounts[0] as { id: string }).id, smtpImapAccount.id);
  assert.equal((accountsAfterMainChange.accounts[0] as { isPrimary?: boolean }).isPrimary, true);

  const defaultDraftResult = await createEmailDraft('owner-user', {
    to: ['default-recipient@example.test'],
    subject: 'Default main draft',
    body: 'Created from main email',
  });
  assert.equal((defaultDraftResult as { account?: { id?: string } }).account?.id, smtpImapAccount.id);

  const searchResult = await searchEmail('owner-user', { query: 'IMAP', limit: 5 });
  assert.equal((searchResult as { account?: { id?: string } }).account?.id, smtpImapAccount.id);
  const searchMessages = (searchResult as { messages?: Array<{ id: string; from: string; snippet: string }> }).messages || [];
  assert.equal(searchMessages.length, 1);
  assert.equal(searchMessages[0].id, '1002');
  assert.match(searchMessages[0].from, /allowed@example\.test/u);
  assert.match(searchMessages[0].snippet, /Allowed body text/u);
  assert.equal(imapReleaseCalls, 1);

  const readResult = await readEmailMessage('owner-user', smtpImapAccount.id, '1002');
  const readBody = (readResult as { message?: { body?: string } }).message?.body || '';
  assert.match(readBody, /Allowed body text from IMAP/u);
  await assert.rejects(() => readEmailMessage('owner-user', smtpImapAccount.id, '1001'), /sender is not allowed/i);

  setImapClientFactoryForTests(null);
  setSmtpTransportFactoryForTests(null);

  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('Email accounts service test passed.');
}

main().catch(async (error) => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
