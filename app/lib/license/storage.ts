import 'server-only';

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { licenseCerts } from '@/app/lib/db/schema';
import { resolveSecretsDir } from '@/app/lib/runtime-data-paths';
import {
  TEAM_SEAT_INSTANCE_TOKEN_SCOPES,
  TEAM_SEAT_PROTOCOL_VERSION,
  type TeamSeatInstanceTokenScope,
} from './team-seat-contract';
import { getLicenseInstanceId } from './instance';
import { decodeLicenseJwt } from './jwt';
import type { LicenseCert, LicenseValidationErrorCode } from './types';

const COMMUNITY_INSTANCE_TOKEN_DIRECTORY = 'license';
const COMMUNITY_INSTANCE_TOKEN_FILE = 'community-instance-token.json';
const COMMUNITY_INSTANCE_TOKEN_SCHEMA_VERSION = 1;
const COMMUNITY_CLAIM_SESSION_FILE = 'community-claim-session.json';
const COMMUNITY_CLAIM_SESSION_SCHEMA_VERSION = 1;
const COMMUNITY_CONNECTION_RECOVERY_FILE = 'community-connection-recovery.json';
const COMMUNITY_CONNECTION_RECOVERY_SCHEMA_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class LicenseCertificateStorageError extends Error {
  constructor(
    public readonly code: Extract<LicenseValidationErrorCode, 'LICENSE_CERT_ROLLBACK'>,
    message: string,
  ) {
    super(message);
    this.name = 'LicenseCertificateStorageError';
  }
}

type StoredCommunityInstanceToken = {
  schemaVersion: typeof COMMUNITY_INSTANCE_TOKEN_SCHEMA_VERSION;
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  instanceId: string;
  tokenType: 'Bearer';
  token: string;
  scopes: TeamSeatInstanceTokenScope[];
  expiresAt: string | null;
  generation: number;
  createdAt: string;
  rotatedAt: string | null;
  updatedAt: string;
};

export type CommunityInstanceTokenSecret = {
  instanceId: string;
  tokenType: 'Bearer';
  instanceToken: string;
  scopes: TeamSeatInstanceTokenScope[];
  expiresAt: string | null;
  generation: number;
  createdAt: string;
  rotatedAt: string | null;
  updatedAt: string;
};

export type CommunityInstanceTokenStatus = {
  configured: boolean;
  instanceId: string | null;
  tokenPrefix: string | null;
  scopes: TeamSeatInstanceTokenScope[];
  expiresAt: string | null;
  expired: boolean;
  generation: number | null;
  createdAt: string | null;
  rotatedAt: string | null;
  updatedAt: string | null;
};

export type CommunityConnectionRecoveryReason =
  | 'expired'
  | 'revoked'
  | 'invalid'
  | 'lost'
  | 'rotation_failed';

type StoredCommunityConnectionRecoveryState = {
  schemaVersion: typeof COMMUNITY_CONNECTION_RECOVERY_SCHEMA_VERSION;
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  instanceId: string;
  reason: CommunityConnectionRecoveryReason;
  detectedAt: string;
};

export type CommunityConnectionRecoveryState = Omit<
  StoredCommunityConnectionRecoveryState,
  'schemaVersion' | 'protocolVersion'
>;

type StoredCommunityClaimSession = {
  schemaVersion: typeof COMMUNITY_CLAIM_SESSION_SCHEMA_VERSION;
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  claimId: string;
  instanceId: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  consecutiveFailures: number;
  nextPollAt: string;
  startedAt: string;
  lastPolledAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
};

export type CommunityClaimSessionSecret = Omit<
  StoredCommunityClaimSession,
  'schemaVersion' | 'protocolVersion'
>;

export class CommunityInstanceTokenStorageError extends Error {
  constructor(
    public readonly code:
      | 'TOKEN_INVALID'
      | 'TOKEN_ALREADY_STORED'
      | 'TOKEN_NOT_FOUND'
      | 'TOKEN_ROTATION_CONFLICT'
      | 'TOKEN_INSTANCE_MISMATCH'
      | 'TOKEN_STORAGE_UNSAFE'
      | 'TOKEN_STORAGE_CORRUPT',
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'CommunityInstanceTokenStorageError';
  }
}

export class CommunityClaimSessionStorageError extends Error {
  constructor(
    public readonly code:
      | 'CLAIM_SESSION_INVALID'
      | 'CLAIM_SESSION_CONFLICT'
      | 'CLAIM_SESSION_NOT_FOUND'
      | 'CLAIM_SESSION_STORAGE_CORRUPT',
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'CommunityClaimSessionStorageError';
  }
}

let tokenMutationQueue: Promise<void> = Promise.resolve();
let claimSessionMutationQueue: Promise<void> = Promise.resolve();

function normalizeInstanceId(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 8
    || normalized.length > 128
    || /[\s\0]/u.test(normalized)
  ) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_INVALID',
      'A valid Community license instance ID is required.',
      400,
    );
  }
  return normalized;
}

function requireLocalInstanceId(value?: string): string {
  const localInstanceId = normalizeInstanceId(getLicenseInstanceId());
  if (value !== undefined && normalizeInstanceId(value) !== localInstanceId) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_INSTANCE_MISMATCH',
      'Community instance token identity does not match this Notebook instance.',
      409,
    );
  }
  return localInstanceId;
}

function normalizeToken(value: string): string {
  const normalized = value.trim();
  if (
    normalized !== value
    || normalized.length < 32
    || normalized.length > 512
    || !/^[A-Za-z0-9._~-]+$/u.test(normalized)
  ) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_INVALID',
      'The Community instance token has an invalid format.',
      400,
    );
  }
  return normalized;
}

function normalizeScopes(value: readonly TeamSeatInstanceTokenScope[]): TeamSeatInstanceTokenScope[] {
  const validScopes = new Set<string>(TEAM_SEAT_INSTANCE_TOKEN_SCOPES);
  const normalized = [...new Set(value)];
  if (
    normalized.length === 0
    || normalized.some((scope) => !validScopes.has(scope))
  ) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_INVALID',
      'The Community instance token contains unsupported or missing scopes.',
      400,
    );
  }
  return normalized.sort();
}

function normalizeTimestamp(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_INVALID',
      `The Community instance token ${field} timestamp is invalid.`,
      400,
    );
  }
  return new Date(timestamp).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_STORAGE_CORRUPT',
      `Stored Community instance token ${field} is invalid.`,
      500,
    );
  }
  return Number(value);
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CommunityClaimSessionStorageError(
      'CLAIM_SESSION_STORAGE_CORRUPT',
      `Stored Community claim session ${field} is invalid.`,
      500,
    );
  }
  return Number(value);
}

function parseStoredCommunityInstanceToken(value: unknown): StoredCommunityInstanceToken {
  if (!isRecord(value)) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_STORAGE_CORRUPT',
      'Stored Community instance token is not a JSON object.',
      500,
    );
  }
  if (
    value.schemaVersion !== COMMUNITY_INSTANCE_TOKEN_SCHEMA_VERSION
    || value.protocolVersion !== TEAM_SEAT_PROTOCOL_VERSION
    || value.tokenType !== 'Bearer'
    || typeof value.instanceId !== 'string'
    || typeof value.token !== 'string'
    || !Array.isArray(value.scopes)
    || !value.scopes.every((scope) => typeof scope === 'string')
    || (value.expiresAt !== null && typeof value.expiresAt !== 'string')
    || typeof value.createdAt !== 'string'
    || (value.rotatedAt !== null && typeof value.rotatedAt !== 'string')
    || typeof value.updatedAt !== 'string'
  ) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_STORAGE_CORRUPT',
      'Stored Community instance token has an unsupported schema.',
      500,
    );
  }
  return {
    schemaVersion: COMMUNITY_INSTANCE_TOKEN_SCHEMA_VERSION,
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    instanceId: normalizeInstanceId(value.instanceId),
    tokenType: 'Bearer',
    token: normalizeToken(value.token),
    scopes: normalizeScopes(value.scopes as TeamSeatInstanceTokenScope[]),
    expiresAt: normalizeTimestamp(value.expiresAt, 'expiry'),
    generation: parsePositiveInteger(value.generation, 'generation'),
    createdAt: normalizeTimestamp(value.createdAt, 'createdAt')!,
    rotatedAt: normalizeTimestamp(value.rotatedAt, 'rotatedAt'),
    updatedAt: normalizeTimestamp(value.updatedAt, 'updatedAt')!,
  };
}

function normalizeClaimText(
  value: unknown,
  field: string,
  options: { min: number; max: number; pattern?: RegExp },
): string {
  if (typeof value !== 'string') {
    throw new CommunityClaimSessionStorageError(
      'CLAIM_SESSION_STORAGE_CORRUPT',
      `Stored Community claim session ${field} is invalid.`,
      500,
    );
  }
  const normalized = value.trim();
  if (
    normalized !== value
    || normalized.length < options.min
    || normalized.length > options.max
    || (options.pattern && !options.pattern.test(normalized))
  ) {
    throw new CommunityClaimSessionStorageError(
      'CLAIM_SESSION_STORAGE_CORRUPT',
      `Stored Community claim session ${field} is invalid.`,
      500,
    );
  }
  return normalized;
}

function normalizeClaimTimestamp(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CommunityClaimSessionStorageError(
      'CLAIM_SESSION_STORAGE_CORRUPT',
      `Stored Community claim session ${field} timestamp is invalid.`,
      500,
    );
  }
  return new Date(value).toISOString();
}

function parseStoredCommunityClaimSession(value: unknown): StoredCommunityClaimSession {
  if (
    !isRecord(value)
    || value.schemaVersion !== COMMUNITY_CLAIM_SESSION_SCHEMA_VERSION
    || value.protocolVersion !== TEAM_SEAT_PROTOCOL_VERSION
  ) {
    throw new CommunityClaimSessionStorageError(
      'CLAIM_SESSION_STORAGE_CORRUPT',
      'Stored Community claim session has an unsupported schema.',
      500,
    );
  }
  const verificationUrl = normalizeClaimText(value.verificationUrl, 'verificationUrl', {
    min: 8,
    max: 2048,
  });
  try {
    const parsedUrl = new URL(verificationUrl);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') throw new Error('unsupported');
  } catch {
    throw new CommunityClaimSessionStorageError(
      'CLAIM_SESSION_STORAGE_CORRUPT',
      'Stored Community claim session verificationUrl is invalid.',
      500,
    );
  }
  const pollIntervalSeconds = parsePositiveInteger(value.pollIntervalSeconds, 'pollIntervalSeconds');
  if (pollIntervalSeconds > 300) {
    throw new CommunityClaimSessionStorageError(
      'CLAIM_SESSION_STORAGE_CORRUPT',
      'Stored Community claim session pollIntervalSeconds is invalid.',
      500,
    );
  }
  return {
    schemaVersion: COMMUNITY_CLAIM_SESSION_SCHEMA_VERSION,
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    claimId: normalizeClaimText(value.claimId, 'claimId', {
      min: 32,
      max: 128,
      pattern: /^community-claim-[A-Za-z0-9-]+$/u,
    }),
    instanceId: normalizeInstanceId(String(value.instanceId ?? '')),
    deviceCode: normalizeClaimText(value.deviceCode, 'deviceCode', {
      min: 32,
      max: 128,
      pattern: /^[A-Za-z0-9._~-]+$/u,
    }),
    userCode: normalizeClaimText(value.userCode, 'userCode', {
      min: 8,
      max: 16,
      pattern: /^[A-Za-z0-9-]+$/u,
    }),
    verificationUrl,
    expiresAt: normalizeClaimTimestamp(value.expiresAt, 'expiresAt')!,
    pollIntervalSeconds,
    consecutiveFailures: parseNonNegativeInteger(value.consecutiveFailures, 'consecutiveFailures'),
    nextPollAt: normalizeClaimTimestamp(value.nextPollAt, 'nextPollAt')!,
    startedAt: normalizeClaimTimestamp(value.startedAt, 'startedAt')!,
    lastPolledAt: normalizeClaimTimestamp(value.lastPolledAt, 'lastPolledAt', true),
    lastErrorCode: value.lastErrorCode === null
      ? null
      : normalizeClaimText(value.lastErrorCode, 'lastErrorCode', { min: 1, max: 128 }),
    updatedAt: normalizeClaimTimestamp(value.updatedAt, 'updatedAt')!,
  };
}

function parseStoredCommunityConnectionRecoveryState(
  value: unknown,
): StoredCommunityConnectionRecoveryState {
  if (
    !isRecord(value)
    || value.schemaVersion !== COMMUNITY_CONNECTION_RECOVERY_SCHEMA_VERSION
    || value.protocolVersion !== TEAM_SEAT_PROTOCOL_VERSION
    || typeof value.instanceId !== 'string'
    || !['expired', 'revoked', 'invalid', 'lost', 'rotation_failed'].includes(String(value.reason))
    || typeof value.detectedAt !== 'string'
  ) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_STORAGE_CORRUPT',
      'Stored Community connection recovery state has an unsupported schema.',
      500,
    );
  }
  return {
    schemaVersion: COMMUNITY_CONNECTION_RECOVERY_SCHEMA_VERSION,
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    instanceId: normalizeInstanceId(value.instanceId),
    reason: value.reason as CommunityConnectionRecoveryReason,
    detectedAt: normalizeTimestamp(value.detectedAt, 'detectedAt')!,
  };
}

function toSecret(stored: StoredCommunityInstanceToken): CommunityInstanceTokenSecret {
  return {
    instanceId: stored.instanceId,
    tokenType: 'Bearer',
    instanceToken: stored.token,
    scopes: [...stored.scopes],
    expiresAt: stored.expiresAt,
    generation: stored.generation,
    createdAt: stored.createdAt,
    rotatedAt: stored.rotatedAt,
    updatedAt: stored.updatedAt,
  };
}

function tokensEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

async function withTokenMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = tokenMutationQueue;
  let release = () => {};
  tokenMutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function withClaimSessionMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = claimSessionMutationQueue;
  let release = () => {};
  claimSessionMutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function communityInstanceTokenDirectory(): string {
  return path.join(resolveSecretsDir(), COMMUNITY_INSTANCE_TOKEN_DIRECTORY);
}

export function resolveCommunityInstanceTokenPath(): string {
  return path.join(communityInstanceTokenDirectory(), COMMUNITY_INSTANCE_TOKEN_FILE);
}

export function resolveCommunityClaimSessionPath(): string {
  return path.join(communityInstanceTokenDirectory(), COMMUNITY_CLAIM_SESSION_FILE);
}

export function resolveCommunityConnectionRecoveryPath(): string {
  return path.join(communityInstanceTokenDirectory(), COMMUNITY_CONNECTION_RECOVERY_FILE);
}

async function assertOwnedNonSymlink(targetPath: string, expectedType: 'directory' | 'file'): Promise<void> {
  let stats;
  try {
    stats = await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const typeMatches = expectedType === 'directory' ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink() || !typeMatches) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_STORAGE_UNSAFE',
      `Community instance token ${expectedType} is not a regular ${expectedType}.`,
      500,
    );
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_STORAGE_UNSAFE',
      `Community instance token ${expectedType} is owned by another operating-system user.`,
      500,
    );
  }
}

async function ensurePrivateTokenDirectory(): Promise<string> {
  const secretsRoot = resolveSecretsDir();
  const directory = communityInstanceTokenDirectory();
  await fs.mkdir(secretsRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertOwnedNonSymlink(secretsRoot, 'directory');
  await fs.chmod(secretsRoot, PRIVATE_DIRECTORY_MODE);
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertOwnedNonSymlink(directory, 'directory');
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
  return directory;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

async function writePrivateLicenseFileAtomic(fileName: string, value: unknown): Promise<void> {
  const directory = await ensurePrivateTokenDirectory();
  const filePath = path.join(directory, fileName);
  await assertOwnedNonSymlink(filePath, 'file');
  const temporaryPath = path.join(
    directory,
    `.${fileName}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeStoredTokenAtomic(stored: StoredCommunityInstanceToken): Promise<void> {
  await writePrivateLicenseFileAtomic(COMMUNITY_INSTANCE_TOKEN_FILE, stored);
}

async function writeCommunityConnectionRecoveryStateAtomic(
  state: StoredCommunityConnectionRecoveryState,
): Promise<void> {
  await writePrivateLicenseFileAtomic(COMMUNITY_CONNECTION_RECOVERY_FILE, state);
}

async function readStoredTokenIfExists(): Promise<StoredCommunityInstanceToken | null> {
  const filePath = resolveCommunityInstanceTokenPath();
  try {
    await assertOwnedNonSymlink(filePath, 'file');
    const content = await fs.readFile(filePath, 'utf8');
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
    return parseStoredCommunityInstanceToken(JSON.parse(content) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_STORAGE_CORRUPT',
        'Stored Community instance token contains invalid JSON.',
        500,
      );
    }
    throw error;
  }
}

async function readCommunityConnectionRecoveryStateIfExists():
Promise<StoredCommunityConnectionRecoveryState | null> {
  const filePath = resolveCommunityConnectionRecoveryPath();
  try {
    await assertOwnedNonSymlink(filePath, 'file');
    const content = await fs.readFile(filePath, 'utf8');
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
    return parseStoredCommunityConnectionRecoveryState(JSON.parse(content) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_STORAGE_CORRUPT',
        'Stored Community connection recovery state contains invalid JSON.',
        500,
      );
    }
    throw error;
  }
}

async function removeCommunityConnectionRecoveryStateFile(): Promise<void> {
  await fs.rm(resolveCommunityConnectionRecoveryPath(), { force: true });
}

async function readStoredClaimSessionIfExists(): Promise<StoredCommunityClaimSession | null> {
  const filePath = resolveCommunityClaimSessionPath();
  try {
    await assertOwnedNonSymlink(filePath, 'file');
    const content = await fs.readFile(filePath, 'utf8');
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
    return parseStoredCommunityClaimSession(JSON.parse(content) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new CommunityClaimSessionStorageError(
        'CLAIM_SESSION_STORAGE_CORRUPT',
        'Stored Community claim session contains invalid JSON.',
        500,
      );
    }
    throw error;
  }
}

function statusFromStored(stored: StoredCommunityInstanceToken | null): CommunityInstanceTokenStatus {
  return {
    configured: Boolean(stored),
    instanceId: stored?.instanceId ?? null,
    tokenPrefix: stored ? communityInstanceTokenPrefix(stored.token) : null,
    scopes: stored ? [...stored.scopes] : [],
    expiresAt: stored?.expiresAt ?? null,
    expired: Boolean(stored?.expiresAt && Date.parse(stored.expiresAt) <= Date.now()),
    generation: stored?.generation ?? null,
    createdAt: stored?.createdAt ?? null,
    rotatedAt: stored?.rotatedAt ?? null,
    updatedAt: stored?.updatedAt ?? null,
  };
}

export function communityInstanceTokenPrefix(token: string): string {
  const normalized = normalizeToken(token);
  return `${normalized.slice(0, 12)}…`;
}

export async function loadCommunityInstanceToken(
  expectedInstanceId?: string,
): Promise<CommunityInstanceTokenSecret | null> {
  const localInstanceId = requireLocalInstanceId(expectedInstanceId);
  const stored = await readStoredTokenIfExists();
  if (!stored) return null;
  if (stored.instanceId !== localInstanceId) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_INSTANCE_MISMATCH',
      'Stored Community instance token belongs to another instance.',
      409,
    );
  }
  return toSecret(stored);
}

export async function getCommunityInstanceTokenStatus(
  expectedInstanceId?: string,
): Promise<CommunityInstanceTokenStatus> {
  const stored = await loadCommunityInstanceToken(expectedInstanceId);
  if (!stored) return statusFromStored(null);
  return {
    configured: true,
    instanceId: stored.instanceId,
    tokenPrefix: communityInstanceTokenPrefix(stored.instanceToken),
    scopes: [...stored.scopes],
    expiresAt: stored.expiresAt,
    expired: Boolean(stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()),
    generation: stored.generation,
    createdAt: stored.createdAt,
    rotatedAt: stored.rotatedAt,
    updatedAt: stored.updatedAt,
  };
}

export async function loadCommunityConnectionRecoveryState(
  expectedInstanceId?: string,
): Promise<CommunityConnectionRecoveryState | null> {
  const localInstanceId = requireLocalInstanceId(expectedInstanceId);
  const state = await readCommunityConnectionRecoveryStateIfExists();
  if (!state) return null;
  if (state.instanceId !== localInstanceId) {
    throw new CommunityInstanceTokenStorageError(
      'TOKEN_INSTANCE_MISMATCH',
      'Stored Community connection recovery state belongs to another instance.',
      409,
    );
  }
  return {
    instanceId: state.instanceId,
    reason: state.reason,
    detectedAt: state.detectedAt,
  };
}

export async function markCommunityConnectionReconnectRequired(input: {
  instanceId: string;
  reason: CommunityConnectionRecoveryReason;
  expectedToken?: string;
  now?: Date;
}): Promise<CommunityConnectionRecoveryState> {
  return withTokenMutationLock(async () => {
    const instanceId = requireLocalInstanceId(input.instanceId);
    const existing = await readStoredTokenIfExists();
    if (
      existing
      && input.expectedToken !== undefined
      && !tokensEqual(existing.token, normalizeToken(input.expectedToken))
    ) {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_ROTATION_CONFLICT',
        'The stored Community instance token changed before recovery was recorded.',
      );
    }
    if (existing) await fs.rm(resolveCommunityInstanceTokenPath(), { force: true });
    const state: StoredCommunityConnectionRecoveryState = {
      schemaVersion: COMMUNITY_CONNECTION_RECOVERY_SCHEMA_VERSION,
      protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
      instanceId,
      reason: input.reason,
      detectedAt: (input.now ?? new Date()).toISOString(),
    };
    await writeCommunityConnectionRecoveryStateAtomic(state);
    await syncDirectory(communityInstanceTokenDirectory());
    return {
      instanceId: state.instanceId,
      reason: state.reason,
      detectedAt: state.detectedAt,
    };
  });
}

export async function saveCommunityInstanceToken(input: {
  instanceId: string;
  instanceToken: string;
  tokenType: 'Bearer';
  scopes: TeamSeatInstanceTokenScope[];
  expiresAt: string | null;
  now?: Date;
}): Promise<CommunityInstanceTokenStatus> {
  return withTokenMutationLock(async () => {
    if (input.tokenType !== 'Bearer') {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_INVALID',
        'Only Bearer Community instance tokens are supported.',
        400,
      );
    }
    const instanceId = requireLocalInstanceId(input.instanceId);
    const token = normalizeToken(input.instanceToken);
    const scopes = normalizeScopes(input.scopes);
    const expiresAt = normalizeTimestamp(input.expiresAt, 'expiry');
    const existing = await readStoredTokenIfExists();
    if (existing) {
      if (
        existing.instanceId === instanceId
        && tokensEqual(existing.token, token)
        && existing.expiresAt === expiresAt
        && JSON.stringify(existing.scopes) === JSON.stringify(scopes)
      ) {
        return statusFromStored(existing);
      }
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_ALREADY_STORED',
        'A Community instance token already exists. Use the rotation operation to replace it.',
      );
    }
    const now = (input.now ?? new Date()).toISOString();
    const stored: StoredCommunityInstanceToken = {
      schemaVersion: COMMUNITY_INSTANCE_TOKEN_SCHEMA_VERSION,
      protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
      instanceId,
      tokenType: 'Bearer',
      token,
      scopes,
      expiresAt,
      generation: 1,
      createdAt: now,
      rotatedAt: null,
      updatedAt: now,
    };
    await writeStoredTokenAtomic(stored);
    await removeCommunityConnectionRecoveryStateFile();
    return statusFromStored(stored);
  });
}

export async function rotateCommunityInstanceToken(input: {
  instanceId: string;
  previousToken: string;
  instanceToken: string;
  tokenType: 'Bearer';
  scopes: TeamSeatInstanceTokenScope[];
  expiresAt: string | null;
  now?: Date;
}): Promise<CommunityInstanceTokenStatus> {
  return withTokenMutationLock(async () => {
    if (input.tokenType !== 'Bearer') {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_INVALID',
        'Only Bearer Community instance tokens are supported.',
        400,
      );
    }
    const existing = await readStoredTokenIfExists();
    if (!existing) {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_NOT_FOUND',
        'No Community instance token is stored.',
        404,
      );
    }
    const instanceId = requireLocalInstanceId(input.instanceId);
    const previousToken = normalizeToken(input.previousToken);
    const nextToken = normalizeToken(input.instanceToken);
    if (existing.instanceId !== instanceId) {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_INSTANCE_MISMATCH',
        'Stored Community instance token belongs to another instance.',
      );
    }
    if (!tokensEqual(existing.token, previousToken)) {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_ROTATION_CONFLICT',
        'The stored Community instance token changed before rotation completed.',
      );
    }
    if (tokensEqual(existing.token, nextToken)) {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_ROTATION_CONFLICT',
        'Community instance token rotation must provide a new token.',
      );
    }
    const now = (input.now ?? new Date()).toISOString();
    const rotated: StoredCommunityInstanceToken = {
      ...existing,
      token: nextToken,
      scopes: normalizeScopes(input.scopes),
      expiresAt: normalizeTimestamp(input.expiresAt, 'expiry'),
      generation: existing.generation + 1,
      rotatedAt: now,
      updatedAt: now,
    };
    await writeStoredTokenAtomic(rotated);
    await removeCommunityConnectionRecoveryStateFile();
    return statusFromStored(rotated);
  });
}

export async function removeCommunityInstanceToken(input: {
  instanceId: string;
  expectedToken?: string;
}): Promise<boolean> {
  return withTokenMutationLock(async () => {
    const existing = await readStoredTokenIfExists();
    if (!existing) return false;
    if (existing.instanceId !== requireLocalInstanceId(input.instanceId)) {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_INSTANCE_MISMATCH',
        'Stored Community instance token belongs to another instance.',
      );
    }
    if (
      input.expectedToken !== undefined
      && !tokensEqual(existing.token, normalizeToken(input.expectedToken))
    ) {
      throw new CommunityInstanceTokenStorageError(
        'TOKEN_ROTATION_CONFLICT',
        'The stored Community instance token changed before deletion completed.',
      );
    }
    await fs.rm(resolveCommunityInstanceTokenPath(), { force: true });
    await syncDirectory(communityInstanceTokenDirectory());
    return true;
  });
}

export async function loadCommunityClaimSession(
  expectedInstanceId?: string,
): Promise<CommunityClaimSessionSecret | null> {
  const localInstanceId = requireLocalInstanceId(expectedInstanceId);
  const stored = await readStoredClaimSessionIfExists();
  if (!stored) return null;
  if (stored.instanceId !== localInstanceId) {
    throw new CommunityClaimSessionStorageError(
      'CLAIM_SESSION_CONFLICT',
      'Stored Community claim session belongs to another Notebook instance.',
    );
  }
  const {
    schemaVersion: _schemaVersion,
    protocolVersion: _protocolVersion,
    ...session
  } = stored;
  return session;
}

function storedClaimSession(input: CommunityClaimSessionSecret): StoredCommunityClaimSession {
  const parsed = parseStoredCommunityClaimSession({
    ...input,
    schemaVersion: COMMUNITY_CLAIM_SESSION_SCHEMA_VERSION,
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
  });
  requireLocalInstanceId(parsed.instanceId);
  return parsed;
}

export async function saveCommunityClaimSession(
  input: CommunityClaimSessionSecret,
): Promise<CommunityClaimSessionSecret> {
  return withClaimSessionMutationLock(async () => {
    const next = storedClaimSession(input);
    const existing = await readStoredClaimSessionIfExists();
    if (existing && existing.claimId !== next.claimId && Date.parse(existing.expiresAt) > Date.now()) {
      throw new CommunityClaimSessionStorageError(
        'CLAIM_SESSION_CONFLICT',
        'Another Community claim session is already active.',
      );
    }
    await writePrivateLicenseFileAtomic(COMMUNITY_CLAIM_SESSION_FILE, next);
    return loadCommunityClaimSession(next.instanceId) as Promise<CommunityClaimSessionSecret>;
  });
}

export async function updateCommunityClaimSession(
  expectedClaimId: string,
  input: CommunityClaimSessionSecret,
): Promise<CommunityClaimSessionSecret> {
  return withClaimSessionMutationLock(async () => {
    const existing = await readStoredClaimSessionIfExists();
    if (!existing) {
      throw new CommunityClaimSessionStorageError(
        'CLAIM_SESSION_NOT_FOUND',
        'No Community claim session is active.',
        404,
      );
    }
    if (existing.claimId !== expectedClaimId || input.claimId !== expectedClaimId) {
      throw new CommunityClaimSessionStorageError(
        'CLAIM_SESSION_CONFLICT',
        'The Community claim session changed before it could be updated.',
      );
    }
    const next = storedClaimSession(input);
    await writePrivateLicenseFileAtomic(COMMUNITY_CLAIM_SESSION_FILE, next);
    return loadCommunityClaimSession(next.instanceId) as Promise<CommunityClaimSessionSecret>;
  });
}

export async function removeCommunityClaimSession(expectedClaimId?: string): Promise<boolean> {
  return withClaimSessionMutationLock(async () => {
    const existing = await readStoredClaimSessionIfExists();
    if (!existing) return false;
    if (expectedClaimId && existing.claimId !== expectedClaimId) {
      throw new CommunityClaimSessionStorageError(
        'CLAIM_SESSION_CONFLICT',
        'The Community claim session changed before it could be removed.',
      );
    }
    requireLocalInstanceId(existing.instanceId);
    await fs.rm(resolveCommunityClaimSessionPath(), { force: true });
    await syncDirectory(communityInstanceTokenDirectory());
    return true;
  });
}

export async function loadStoredLicenseCert(instanceId: string): Promise<string | null> {
  const rows = await db
    .select({ cert: licenseCerts.cert })
    .from(licenseCerts)
    .where(eq(licenseCerts.instanceId, instanceId));
  return rows
    .map((row) => {
      const decoded = decodeLicenseJwt(row.cert);
      return decoded?.sub === instanceId ? certificateRevision(row.cert, decoded) : null;
    })
    .filter((revision): revision is CertificateRevision => revision !== null)
    .sort((left, right) => compareCertificateRevision(right, left))[0]?.cert ?? null;
}

type CertificateRevision = {
  entitlementsVersion: number;
  issuedAt: number;
  expiresAt: number;
  cert: string;
};

let licenseCertificateMutationQueue: Promise<unknown> = Promise.resolve();

function certificateRevision(cert: string, payload: LicenseCert): CertificateRevision {
  return {
    entitlementsVersion: typeof payload.entitlementsVersion === 'number'
      && Number.isSafeInteger(payload.entitlementsVersion)
      && payload.entitlementsVersion >= 0
      ? payload.entitlementsVersion
      : 0,
    issuedAt: typeof payload.iat === 'number' && Number.isSafeInteger(payload.iat) ? payload.iat : 0,
    expiresAt: typeof payload.exp === 'number' && Number.isSafeInteger(payload.exp) ? payload.exp : 0,
    cert,
  };
}

function compareCertificateRevision(left: CertificateRevision, right: CertificateRevision): number {
  if (left.entitlementsVersion !== right.entitlementsVersion) {
    return left.entitlementsVersion - right.entitlementsVersion;
  }
  if (left.issuedAt !== right.issuedAt) return left.issuedAt - right.issuedAt;
  if (left.expiresAt !== right.expiresAt) return left.expiresAt - right.expiresAt;
  return 0;
}

async function saveLicenseCertLocked(cert: string, payload: LicenseCert): Promise<void> {
  const existingRows = await db
    .select({ cert: licenseCerts.cert })
    .from(licenseCerts)
    .where(eq(licenseCerts.instanceId, payload.sub));
  const current = existingRows
    .map((row) => {
      const decoded = decodeLicenseJwt(row.cert);
      return decoded?.sub === payload.sub ? certificateRevision(row.cert, decoded) : null;
    })
    .filter((revision): revision is CertificateRevision => revision !== null)
    .sort((left, right) => compareCertificateRevision(right, left))[0];
  const next = certificateRevision(cert, payload);

  if (current?.cert === cert) return;
  if (current && compareCertificateRevision(next, current) <= 0) {
    throw new LicenseCertificateStorageError(
      'LICENSE_CERT_ROLLBACK',
      'License certificate would replace a newer entitlement state.',
    );
  }

  const now = new Date();
  await db.insert(licenseCerts).values({
    cert,
    plan: payload.plan,
    instanceId: payload.sub,
    expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function saveLicenseCert(cert: string, payload: LicenseCert): Promise<void> {
  const mutation = licenseCertificateMutationQueue.then(
    () => saveLicenseCertLocked(cert, payload),
    () => saveLicenseCertLocked(cert, payload),
  );
  licenseCertificateMutationQueue = mutation.catch(() => undefined);
  await mutation;
}
