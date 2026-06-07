import 'server-only';

import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import { db } from '@/app/lib/db';
import { user } from '@/app/lib/db/schema';
import {
  disconnectStoredEmailAccount,
  getEmailAccountForUser,
  listPublicEmailAccountsForUser,
  publicStoredEmailAccount,
  readStoredEmailAccountSecret,
  saveStoredEmailAccountOAuthSecret,
  setStoredEmailAccountStatus,
  updateStoredEmailPolicy,
  upsertOAuthEmailAccount,
  type StoredEmailAccount,
} from '@/app/lib/email/account-store';
import {
  assertEmailRecipientsAllowed,
  assertEmailSenderAllowed,
  isEmailAddressAllowed,
  normalizeEmailPolicyList as normalizePolicyList,
  type EmailPolicy,
} from '@/app/lib/email/policy';
import { readScopedEnvState } from '@/app/lib/integrations/env-config';
import { resolveSecretsDir } from '@/app/lib/runtime-data-paths';

export type EmailProvider = 'google' | 'microsoft';
export type { EmailPolicy } from '@/app/lib/email/policy';

export type EmailDraftInput = {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  is_HTML?: boolean;
};

type LegacyLocalEmailAccount = {
  id: string;
  provider: EmailProvider;
  providerAccountId?: string;
  emailAddress: string;
  displayName?: string | null;
  tokenType: string;
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresAt?: string;
  policy: EmailPolicy;
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
  updatedAt: string;
};

type LocalEmailState = {
  version: 1;
  accounts: LegacyLocalEmailAccount[];
};

type OAuthState = {
  state: string;
  userId: string;
  provider: EmailProvider;
  codeVerifier: string;
  redirectUri: string;
  returnUrl?: string;
  createdAt: string;
  expiresAt: string;
};

type OAuthConfig = {
  provider: EmailProvider;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

const googleScopes = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
];

const microsoftScopes = [
  'openid',
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
];

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function normalizeProvider(value: string | undefined): EmailProvider {
  const normalized = (value || 'google').trim().toLowerCase();
  if (normalized === 'google' || normalized === 'gmail') return 'google';
  if (normalized === 'microsoft' || normalized === 'outlook' || normalized === 'graph') return 'microsoft';
  throw new Error(`Unsupported email provider: ${value}`);
}

function emailRoot(): string {
  return path.join(resolveSecretsDir(), 'email-oauth');
}

function accountsPath(): string {
  return path.join(emailRoot(), 'accounts.json');
}

function statePath(state: string): string {
  return path.join(emailRoot(), '.state', `${state.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

async function ensurePrivateDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}

async function writeJsonPrivate(filePath: string, payload: unknown): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(tmpPath, 0o600).catch(() => undefined);
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function readLocalEmailState(): Promise<LocalEmailState> {
  return await readJsonIfExists<LocalEmailState>(accountsPath()) || { version: 1, accounts: [] };
}

const legacyMigrationCheckedForUser = new Set<string>();

function dateFromIso(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

async function singleWorkspaceUserId(): Promise<string | null> {
  const users = await db.select({ id: user.id }).from(user).limit(2);
  return users.length === 1 ? users[0].id : null;
}

async function backupOrRemoveLegacyAccountsFile(): Promise<void> {
  const legacyPath = accountsPath();
  const backupPath = path.join(emailRoot(), 'accounts.legacy.json');
  try {
    await fs.access(backupPath);
    await fs.rm(legacyPath, { force: true });
  } catch {
    await fs.rename(legacyPath, backupPath).catch(() => undefined);
  }
}

async function migrateLegacyEmailAccountsIfSafe(userId: string): Promise<void> {
  if (legacyMigrationCheckedForUser.has(userId)) return;

  const state = await readLocalEmailState();
  const activeAccounts = state.accounts.filter((account) => account.status === 'active');
  if (activeAccounts.length === 0) {
    legacyMigrationCheckedForUser.add(userId);
    return;
  }

  const onlyUserId = await singleWorkspaceUserId();
  if (onlyUserId !== userId) return;

  for (const account of activeAccounts) {
    await upsertOAuthEmailAccount({
      userId,
      accountId: account.id,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      emailAddress: account.emailAddress,
      displayName: account.displayName,
      policy: account.policy,
      createdAt: dateFromIso(account.createdAt),
      secret: {
        authType: 'oauth',
        tokenType: account.tokenType || 'Bearer',
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        scope: account.scope,
        expiresAt: account.expiresAt,
      },
    });
  }

  await backupOrRemoveLegacyAccountsFile();
  legacyMigrationCheckedForUser.add(userId);
}

async function integrationEnvMap(): Promise<Map<string, string>> {
  const state = await readScopedEnvState('integrations');
  return new Map(state.entries.map((entry) => [entry.key, entry.value]));
}

async function getOAuthConfig(provider: EmailProvider): Promise<OAuthConfig | null> {
  const env = await integrationEnvMap();
  if (provider === 'google') {
    const clientId = env.get('GOOGLE_OAUTH_CLIENT_ID')?.trim();
    const clientSecret = env.get('GOOGLE_OAUTH_CLIENT_SECRET')?.trim();
    if (!clientId || !clientSecret) return null;
    return {
      provider,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId,
      clientSecret,
      scopes: googleScopes,
    };
  }
  const clientId = env.get('MICROSOFT_OAUTH_CLIENT_ID')?.trim();
  const clientSecret = env.get('MICROSOFT_OAUTH_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    provider,
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientId,
    clientSecret,
    scopes: microsoftScopes,
  };
}

export async function hasLocalEmailOAuthCredentials(provider?: string): Promise<boolean> {
  if (provider) return Boolean(await getOAuthConfig(normalizeProvider(provider)));
  const [google, microsoft] = await Promise.all([getOAuthConfig('google'), getOAuthConfig('microsoft')]);
  return Boolean(google || microsoft);
}

function getOrigin(requestOrigin?: string | null): string {
  const configured = process.env.BASE_URL || process.env.APP_BASE_URL;
  return (configured || requestOrigin || 'http://localhost:3000').replace(/\/+$/u, '');
}

export async function startLocalEmailOAuth(params: {
  userId: string;
  provider?: string;
  requestOrigin?: string | null;
  returnUrl?: string;
}) {
  const provider = normalizeProvider(params.provider);
  const config = await getOAuthConfig(provider);
  if (!config) {
    throw new Error(`${provider === 'google' ? 'Google' : 'Microsoft'} OAuth Client ID and Client Secret are required before connecting.`);
  }

  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(32));
  const redirectUri = `${getOrigin(params.requestOrigin)}/api/email/oauth/callback`;
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

  await writeJsonPrivate(statePath(state), {
    state,
    userId: params.userId,
    provider,
    codeVerifier,
    redirectUri,
    returnUrl: params.returnUrl,
    createdAt: new Date().toISOString(),
    expiresAt,
  } satisfies OAuthState);

  const authorizationUrl = new URL(config.authorizationUrl);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', config.clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('scope', config.scopes.join(' '));
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  if (provider === 'google') {
    authorizationUrl.searchParams.set('access_type', 'offline');
    authorizationUrl.searchParams.set('prompt', 'consent');
  }

  return { provider, authorizationUrl: authorizationUrl.toString(), expiresAt };
}

async function exchangeToken(config: OAuthConfig, params: URLSearchParams): Promise<TokenResponse> {
  params.set('client_id', config.clientId);
  params.set('client_secret', config.clientSecret);
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const body = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok) {
    throw new Error(body.error_description || body.error || `OAuth token endpoint returned ${response.status}`);
  }
  return body;
}

async function googleProfile(accessToken: string) {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google profile request failed with ${response.status}`);
  const body = await response.json() as { sub?: string; email?: string; name?: string };
  if (!body.email) throw new Error('Google profile did not include an email address.');
  return { providerAccountId: body.sub || body.email, emailAddress: body.email.toLowerCase(), displayName: body.name || null };
}

async function microsoftProfile(accessToken: string) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Microsoft profile request failed with ${response.status}`);
  const body = await response.json() as { id?: string; displayName?: string; mail?: string; userPrincipalName?: string };
  const emailAddress = body.mail || body.userPrincipalName;
  if (!emailAddress) throw new Error('Microsoft profile did not include an email address.');
  return { providerAccountId: body.id || emailAddress, emailAddress: emailAddress.toLowerCase(), displayName: body.displayName || null };
}

export async function completeLocalEmailOAuth(userId: string, code: string, state: string) {
  const stored = await readJsonIfExists<OAuthState>(statePath(state));
  if (!stored || stored.state !== state || Date.parse(stored.expiresAt) <= Date.now()) {
    throw new Error('Invalid or expired email OAuth state.');
  }
  if (stored.userId !== userId) {
    throw new Error('Email OAuth state does not belong to the current user.');
  }
  const config = await getOAuthConfig(stored.provider);
  if (!config) throw new Error('Email OAuth credentials are no longer configured.');
  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('code', code);
  params.set('redirect_uri', stored.redirectUri);
  params.set('code_verifier', stored.codeVerifier);
  const token = await exchangeToken(config, params);
  if (!token.access_token) throw new Error('OAuth response did not include an access token.');
  const profile = stored.provider === 'google' ? await googleProfile(token.access_token) : await microsoftProfile(token.access_token);
  const account = await upsertOAuthEmailAccount({
    userId,
    providerAccountId: profile.providerAccountId,
    provider: stored.provider,
    emailAddress: profile.emailAddress,
    displayName: profile.displayName,
    secret: {
      authType: 'oauth',
      tokenType: token.token_type || 'Bearer',
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      scope: token.scope || config.scopes.join(' '),
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined,
    },
  });
  await fs.rm(statePath(state), { force: true }).catch(() => undefined);
  return { account: await publicLocalEmailAccount(account), returnUrl: stored.returnUrl };
}

export async function publicLocalEmailAccount(account: StoredEmailAccount) {
  const secret = await readStoredEmailAccountSecret(account).catch(() => null);
  return publicStoredEmailAccount(account, secret);
}

export async function listLocalEmailAccounts(userId: string) {
  await migrateLegacyEmailAccountsIfSafe(userId);
  return listPublicEmailAccountsForUser(userId);
}

async function findLocalEmailAccount(userId: string, accountId?: string): Promise<StoredEmailAccount> {
  await migrateLegacyEmailAccountsIfSafe(userId);
  return getEmailAccountForUser(userId, accountId);
}

async function validAccessToken(account: StoredEmailAccount): Promise<string> {
  const secret = await readStoredEmailAccountSecret(account);
  if (secret.authType !== 'oauth') throw new Error('Email account is not an OAuth account.');
  if (!secret.expiresAt || Date.parse(secret.expiresAt) > Date.now() + 60_000) return secret.accessToken;
  if (!secret.refreshToken) {
    await setStoredEmailAccountStatus(account, 'expired');
    throw new Error('Email account authorization expired. Reconnect the account.');
  }
  const config = await getOAuthConfig(account.provider as EmailProvider);
  if (!config) throw new Error('Email OAuth credentials are no longer configured.');
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', secret.refreshToken);
  const refreshed = await exchangeToken(config, params);
  if (!refreshed.access_token) throw new Error('OAuth refresh response did not include an access token.');
  await saveStoredEmailAccountOAuthSecret(account, {
    authType: 'oauth',
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || secret.refreshToken,
    tokenType: refreshed.token_type || secret.tokenType,
    scope: refreshed.scope || secret.scope,
    expiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : secret.expiresAt,
  });
  return refreshed.access_token;
}

export async function updateLocalEmailPolicy(userId: string, accountId: string, policy: Partial<EmailPolicy>) {
  return updateStoredEmailPolicy(userId, accountId, policy);
}

export async function disconnectLocalEmailAccount(userId: string, accountId: string) {
  return disconnectStoredEmailAccount(userId, accountId);
}

function policyForAccount(account: StoredEmailAccount): EmailPolicy {
  try {
    const parsed = JSON.parse(account.policyJson) as Partial<EmailPolicy>;
    return {
      readFrom: normalizePolicyList(parsed.readFrom),
      sendTo: normalizePolicyList(parsed.sendTo),
    };
  } catch {
    return { readFrom: [], sendTo: [] };
  }
}

function assertSenderAllowed(account: StoredEmailAccount, from: string) {
  assertEmailSenderAllowed(from, policyForAccount(account).readFrom);
}

function assertRecipientsAllowed(account: StoredEmailAccount, input: EmailDraftInput) {
  const recipients = [...input.to, ...(input.cc || []), ...(input.bcc || [])];
  assertEmailRecipientsAllowed(recipients, policyForAccount(account).sendTo);
}

function gmailHeader(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  const header = headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

async function gmailFetch(pathSuffix: string, token: string, init?: RequestInit) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pathSuffix}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(typeof body.error?.message === 'string' ? body.error.message : `Gmail request failed with ${response.status}`);
  return body as Record<string, unknown>;
}

async function microsoftFetch(pathSuffix: string, token: string, init?: RequestInit) {
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/${pathSuffix}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(typeof body.error?.message === 'string' ? body.error.message : `Microsoft Graph request failed with ${response.status}`);
  return body as Record<string, unknown>;
}

function decodeBase64Url(value: string) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function sanitizeEmailHeaderValue(value: string) {
  return value.replace(/[\r\n]+/gu, ' ').replace(/[ \t]+/gu, ' ').trim();
}

export function encodeMimeHeaderValue(value: string) {
  const sanitized = sanitizeEmailHeaderValue(value);
  if (/^[\x20-\x7e]*$/u.test(sanitized)) return sanitized;

  const encodedWords: string[] = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const char of sanitized) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (chunk && chunkBytes + charBytes > 45) {
      encodedWords.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += charBytes;
  }

  if (chunk) {
    encodedWords.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  }

  return encodedWords.join('\r\n ');
}

function gmailBodyText(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  const body = payload.body as Record<string, unknown> | undefined;
  if (typeof body?.data === 'string') return decodeBase64Url(body.data);
  const parts = Array.isArray(payload.parts) ? payload.parts as Record<string, unknown>[] : [];
  const plain = parts.find((part) => part.mimeType === 'text/plain');
  if (plain) return gmailBodyText(plain);
  return parts.map((part) => gmailBodyText(part)).filter(Boolean).join('\n\n');
}

function encodeRawEmail(input: EmailDraftInput) {
  const contentType = input.is_HTML ? 'text/html' : 'text/plain';
  const headers = [
    `To: ${input.to.map(sanitizeEmailHeaderValue).join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.map(sanitizeEmailHeaderValue).join(', ')}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.map(sanitizeEmailHeaderValue).join(', ')}`] : []),
    `Subject: ${encodeMimeHeaderValue(input.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}; charset=UTF-8`,
  ];
  return base64Url(Buffer.from(`${headers.join('\r\n')}\r\n\r\n${input.body}`, 'utf8'));
}

export async function searchLocalEmail(userId: string, input: { accountId?: string; query?: string; limit?: number }) {
  const account = await findLocalEmailAccount(userId, input.accountId);
  const token = await validAccessToken(account);
  const limit = Math.min(Math.max(input.limit || 10, 1), 25);
  let messages: Array<Record<string, unknown>> = [];
  if (account.provider === 'google') {
    const search = new URLSearchParams({ maxResults: String(limit), q: input.query || '' });
    const list = await gmailFetch(`messages?${search.toString()}`, token);
    const ids = Array.isArray(list.messages) ? list.messages.slice(0, limit) as Array<{ id?: string }> : [];
    const loaded = await Promise.all(ids.map((item) => gmailFetch(`messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token)));
    messages = loaded.map((message) => {
      const payload = message.payload as Record<string, unknown> | undefined;
      const headers = payload?.headers as Array<{ name?: string; value?: string }> | undefined;
      return {
        id: String(message.id || ''),
        threadId: String(message.threadId || ''),
        from: gmailHeader(headers, 'From'),
        subject: gmailHeader(headers, 'Subject'),
        date: gmailHeader(headers, 'Date'),
        snippet: String(message.snippet || ''),
      };
    });
  } else {
    const params = new URLSearchParams({
      '$top': String(limit),
      '$select': 'id,conversationId,from,subject,receivedDateTime,bodyPreview',
      '$orderby': 'receivedDateTime desc',
    });
    if (input.query?.trim()) {
      params.set('$search', `"${input.query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    }
    const result = await microsoftFetch(`messages?${params.toString()}`, token, input.query?.trim() ? { headers: { ConsistencyLevel: 'eventual' } } : undefined);
    const values = Array.isArray(result.value) ? result.value as Record<string, unknown>[] : [];
    messages = values.map((message) => {
      const from = message.from as { emailAddress?: { address?: string } } | undefined;
      return {
        id: String(message.id || ''),
        threadId: String(message.conversationId || ''),
        from: from?.emailAddress?.address || '',
        subject: String(message.subject || ''),
        date: String(message.receivedDateTime || ''),
        snippet: String(message.bodyPreview || ''),
      };
    });
  }
  const policy = policyForAccount(account);
  return {
    account: await publicLocalEmailAccount(account),
    messages: messages.filter((message) => isEmailAddressAllowed(String(message.from || ''), policy.readFrom)),
  };
}

export async function readLocalEmailMessage(userId: string, accountId: string, messageId: string) {
  const account = await findLocalEmailAccount(userId, accountId);
  const token = await validAccessToken(account);
  let message: Record<string, unknown>;
  if (account.provider === 'google') {
    const raw = await gmailFetch(`messages/${encodeURIComponent(messageId)}?format=full`, token);
    const payload = raw.payload as Record<string, unknown> | undefined;
    const headers = payload?.headers as Array<{ name?: string; value?: string }> | undefined;
    const from = gmailHeader(headers, 'From');
    assertSenderAllowed(account, from);
    message = {
      id: String(raw.id || ''),
      threadId: String(raw.threadId || ''),
      from,
      to: gmailHeader(headers, 'To'),
      cc: gmailHeader(headers, 'Cc'),
      subject: gmailHeader(headers, 'Subject'),
      date: gmailHeader(headers, 'Date'),
      body: gmailBodyText(payload),
      snippet: String(raw.snippet || ''),
    };
  } else {
    const raw = await microsoftFetch(`messages/${encodeURIComponent(messageId)}?$select=id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,body,bodyPreview`, token);
    const from = (raw.from as { emailAddress?: { address?: string } } | undefined)?.emailAddress?.address || '';
    assertSenderAllowed(account, from);
    message = {
      id: String(raw.id || ''),
      threadId: String(raw.conversationId || ''),
      from,
      to: raw.toRecipients || [],
      cc: raw.ccRecipients || [],
      subject: String(raw.subject || ''),
      date: String(raw.receivedDateTime || ''),
      body: String((raw.body as { content?: string } | undefined)?.content || ''),
      snippet: String(raw.bodyPreview || ''),
    };
  }
  return { account: await publicLocalEmailAccount(account), message };
}

export async function createLocalEmailDraft(userId: string, input: EmailDraftInput) {
  const account = await findLocalEmailAccount(userId, input.accountId);
  assertRecipientsAllowed(account, input);
  const token = await validAccessToken(account);
  let draft: Record<string, unknown>;
  if (account.provider === 'google') {
    const result = await gmailFetch('drafts', token, {
      method: 'POST',
      body: JSON.stringify({ message: { raw: encodeRawEmail(input) } }),
    });
    draft = { id: String(result.id || ''), providerDraft: result };
  } else {
    const result = await microsoftFetch('messages', token, {
      method: 'POST',
      body: JSON.stringify({
        subject: input.subject,
        body: { contentType: input.is_HTML ? 'HTML' : 'Text', content: input.body },
        toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: (input.cc || []).map((address) => ({ emailAddress: { address } })),
        bccRecipients: (input.bcc || []).map((address) => ({ emailAddress: { address } })),
      }),
    });
    draft = { id: String(result.id || ''), providerDraft: result };
  }
  return { account: await publicLocalEmailAccount(account), draft };
}

export async function updateLocalEmailDraft(userId: string, draftId: string, input: EmailDraftInput) {
  const account = await findLocalEmailAccount(userId, input.accountId);
  assertRecipientsAllowed(account, input);
  const token = await validAccessToken(account);
  if (account.provider === 'google') {
    await gmailFetch(`drafts/${encodeURIComponent(draftId)}`, token, {
      method: 'PUT',
      body: JSON.stringify({ id: draftId, message: { raw: encodeRawEmail(input) } }),
    });
  } else {
    await microsoftFetch(`messages/${encodeURIComponent(draftId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        subject: input.subject,
        body: { contentType: input.is_HTML ? 'HTML' : 'Text', content: input.body },
        toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: (input.cc || []).map((address) => ({ emailAddress: { address } })),
        bccRecipients: (input.bcc || []).map((address) => ({ emailAddress: { address } })),
      }),
    });
  }
  return { account: await publicLocalEmailAccount(account), draft: { id: draftId } };
}

export async function sendLocalEmailDraft(userId: string, accountId: string, draftId: string) {
  const account = await findLocalEmailAccount(userId, accountId);
  const token = await validAccessToken(account);
  if (account.provider === 'google') {
    const draft = await gmailFetch(`drafts/${encodeURIComponent(draftId)}?format=full`, token);
    const message = draft.message as Record<string, unknown> | undefined;
    const payload = message?.payload as Record<string, unknown> | undefined;
    const headers = payload?.headers as Array<{ name?: string; value?: string }> | undefined;
    const recipients = [gmailHeader(headers, 'To'), gmailHeader(headers, 'Cc'), gmailHeader(headers, 'Bcc')]
      .flatMap((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean));
    assertRecipientsAllowed(account, { accountId, to: recipients, subject: '', body: '' });
    await gmailFetch('drafts/send', token, { method: 'POST', body: JSON.stringify({ id: draftId }) });
  } else {
    const raw = await microsoftFetch(`messages/${encodeURIComponent(draftId)}?$select=toRecipients,ccRecipients,bccRecipients`, token);
    const recipients = ['toRecipients', 'ccRecipients', 'bccRecipients'].flatMap((key) => {
      const values = Array.isArray(raw[key]) ? raw[key] as Array<{ emailAddress?: { address?: string } }> : [];
      return values.map((item) => item.emailAddress?.address || '').filter(Boolean);
    });
    assertRecipientsAllowed(account, { accountId, to: recipients, subject: '', body: '' });
    await microsoftFetch(`messages/${encodeURIComponent(draftId)}/send`, token, { method: 'POST' });
  }
  return { account: await publicLocalEmailAccount(account), sent: true, draftId };
}
