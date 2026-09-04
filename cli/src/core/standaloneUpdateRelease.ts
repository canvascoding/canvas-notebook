import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import {
  canonicalizeSystemUpdateReleaseManifest,
  validateSystemUpdateSignedReleaseManifest,
  type SystemUpdateArchitecture,
  type SystemUpdateReleaseChannel,
  type SystemUpdateSignedReleaseManifest,
} from './systemUpdateContract';

const DEFAULT_MANIFEST_URL = 'https://github.com/canvascoding/canvas-notebook/releases/latest/download/canvas-notebook-update-{channel}.json';
const DEFAULT_TRUST_STORE = '/etc/canvas-notebook/update-trust.json';
const DEFAULT_IMAGE_REPOSITORY = 'ghcr.io/canvascoding/canvas-notebook';
const MAX_MANIFEST_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

interface TrustedUpdateKey {
  keyId: string;
  algorithm: 'ed25519';
  publicKey: string;
  notBefore?: string;
  notAfter?: string;
}

interface UpdateTrustStore {
  version: 1;
  keys: TrustedUpdateKey[];
}

export interface StandaloneReleaseResolverOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  platformArchitecture?: NodeJS.Architecture;
}

export interface VerifiedStandaloneRelease {
  signed: SystemUpdateSignedReleaseManifest;
  architecture: SystemUpdateArchitecture;
  cliArtifact: SystemUpdateSignedReleaseManifest['manifest']['cliArtifacts'][number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Update trust key ${field} is invalid.`);
  }
  return value;
}

function parseTrustStore(input: unknown): UpdateTrustStore {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 8) {
    throw new Error('Update trust store is invalid.');
  }
  const keys = input.keys.map((entry) => {
    if (!isRecord(entry) || typeof entry.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(entry.keyId) ||
      entry.algorithm !== 'ed25519' || typeof entry.publicKey !== 'string' || entry.publicKey.length > 8192) {
      throw new Error('Update trust key is invalid.');
    }
    return {
      keyId: entry.keyId,
      algorithm: entry.algorithm,
      publicKey: entry.publicKey,
      notBefore: parseTimestamp(entry.notBefore, 'notBefore'),
      notAfter: parseTimestamp(entry.notAfter, 'notAfter'),
    } satisfies TrustedUpdateKey;
  });
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    throw new Error('Update trust key IDs must be unique.');
  }
  return { version: 1, keys };
}

async function readTrustStore(filePath: string): Promise<UpdateTrustStore> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`Update trust store is not installed: ${filePath}`);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Update trust store path is unsafe.');
  if ((stat.mode & 0o022) !== 0) throw new Error('Update trust store must not be group- or world-writable.');
  const content = await fs.readFile(filePath, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > 64 * 1024) throw new Error('Update trust store is too large.');
  try {
    return parseTrustStore(JSON.parse(content) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Update trust store is not valid JSON.');
    throw error;
  }
}

function resolveArchitecture(architecture: NodeJS.Architecture): SystemUpdateArchitecture {
  if (architecture === 'x64') return 'amd64';
  if (architecture === 'arm64') return 'arm64';
  throw new Error(`Unsupported update architecture: ${architecture}`);
}

function manifestUrl(channel: SystemUpdateReleaseChannel, env: NodeJS.ProcessEnv): string {
  const template = String(env.CANVAS_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL).trim();
  const value = template.replaceAll('{channel}', channel);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Update manifest URL is invalid.');
  }
  if (parsed.protocol !== 'https:') throw new Error('Update manifest URL must use HTTPS.');
  return parsed.toString();
}

async function responseJsonWithinLimit(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Update release is unavailable (HTTP ${response.status}).`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_MANIFEST_BYTES) throw new Error('Update manifest is too large.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Update manifest is too large.');
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Update manifest is not valid JSON.');
  }
}

function assertTrustedImage(imageRef: string, env: NodeJS.ProcessEnv): void {
  const repository = String(env.CANVAS_UPDATE_IMAGE_REPOSITORY || DEFAULT_IMAGE_REPOSITORY).trim();
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(repository)) {
    throw new Error('Configured update image repository is invalid.');
  }
  if (!imageRef.startsWith(`${repository}@sha256:`) && !imageRef.startsWith(`${repository}:`)) {
    throw new Error('Update manifest references an untrusted image repository.');
  }
}

function verifySignature(
  envelope: SystemUpdateSignedReleaseManifest,
  trustStore: UpdateTrustStore,
  now: Date,
): void {
  const key = trustStore.keys.find((candidate) => candidate.keyId === envelope.signature.keyId);
  if (!key) throw new Error('Update manifest was signed by an unknown key.');
  if (key.notBefore && now.getTime() < Date.parse(key.notBefore)) throw new Error('Update signing key is not active yet.');
  if (key.notAfter && now.getTime() > Date.parse(key.notAfter)) throw new Error('Update signing key has expired.');
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(key.publicKey);
  } catch {
    throw new Error('Update signing public key is invalid.');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Update signing key must use Ed25519.');
  const valid = crypto.verify(
    null,
    Buffer.from(canonicalizeSystemUpdateReleaseManifest(envelope.manifest), 'utf8'),
    publicKey,
    Buffer.from(envelope.signature.value, 'base64'),
  );
  if (!valid) throw new Error('Update manifest signature is invalid.');
}

export class StandaloneReleaseResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private readonly architecture: SystemUpdateArchitecture;

  constructor(options: StandaloneReleaseResolverOptions = {}) {
    this.env = options.env || process.env;
    this.fetchImplementation = options.fetch || fetch;
    this.now = options.now || (() => new Date());
    this.architecture = resolveArchitecture(options.platformArchitecture || process.arch);
  }

  async resolve(channel: SystemUpdateReleaseChannel): Promise<VerifiedStandaloneRelease> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    timeout.unref();
    let response: Response;
    try {
      response = await this.fetchImplementation(manifestUrl(channel, this.env), {
        headers: { accept: 'application/json' },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error('Update manifest request timed out.');
      throw new Error('Update release information could not be loaded.');
    } finally {
      clearTimeout(timeout);
    }
    if (new URL(response.url || manifestUrl(channel, this.env)).protocol !== 'https:') {
      throw new Error('Update manifest redirect must use HTTPS.');
    }
    const parsed = validateSystemUpdateSignedReleaseManifest(await responseJsonWithinLimit(response));
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.value.manifest.channel !== channel) throw new Error('Update manifest channel does not match the request.');
    const now = this.now();
    if (Date.parse(parsed.value.manifest.publishedAt) > now.getTime() + 5 * 60 * 1000) {
      throw new Error('Update manifest publication time is in the future.');
    }
    assertTrustedImage(parsed.value.manifest.imageRef, this.env);
    const trustStore = await readTrustStore(String(this.env.CANVAS_UPDATE_TRUST_STORE || DEFAULT_TRUST_STORE));
    verifySignature(parsed.value, trustStore, now);
    const cliArtifact = parsed.value.manifest.cliArtifacts.find((artifact) => artifact.architecture === this.architecture);
    if (!cliArtifact) throw new Error(`Update release has no CLI artifact for ${this.architecture}.`);
    return { signed: parsed.value, architecture: this.architecture, cliArtifact };
  }
}

export function compareCanvasVersions(left: string, right: string): number {
  const parse = (value: string): number[] | null => {
    if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u.test(value)) return null;
    return value.split('.').map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) throw new Error('Canvas version cannot be compared.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}
