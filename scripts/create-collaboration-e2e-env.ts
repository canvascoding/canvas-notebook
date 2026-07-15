import crypto from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : '';
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function publicKeyFingerprint(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function signLicense(privateKey: crypto.KeyObject, payload: Record<string, unknown>): string {
  const encodedHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    privateKey,
  );
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

function envLine(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}

function main(): void {
  const outputPath = path.resolve(argument('--output'));
  const dataDir = path.resolve(argument('--data-dir'));
  const databaseUrl = argument('--database-url');
  const localEnvPath = path.resolve(process.cwd(), '.env.local');
  const localEnv = dotenv.parse(readFileSync(localEnvPath, 'utf8'));
  const adminEmail = localEnv.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const adminPassword = localEnv.BOOTSTRAP_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required in .env.local.');
  }

  const instanceId = 'self_collaboration_e2e';
  const organizationId = '00000000-0000-4000-8000-00000000e248';
  const now = Math.floor(Date.now() / 1000);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const license = signLicense(privateKey, {
    sub: instanceId,
    iss: 'canvas-control-plane',
    aud: 'canvas-notebook',
    plan: 'managed',
    status: 'active',
    deploymentMode: 'managed-team',
    databaseProvider: 'postgres',
    vectorProvider: 'none',
    postgresRequired: true,
    organizationId,
    entitlementsVersion: 1,
    capabilities: {
      teamWorkspace: true,
      multiUser: true,
      vectorSearch: false,
      liveCollaboration: true,
    },
    features: {
      teamWorkspace: true,
      multiUser: true,
      liveCollaboration: true,
    },
    quotas: { users: 10 },
    iat: now,
    exp: now + 60 * 60,
  });
  const authSecret = localEnv.BETTER_AUTH_SECRET || localEnv.AUTH_SECRET || crypto.randomBytes(32).toString('base64url');
  const values: Record<string, string> = {
    NODE_ENV: 'development',
    PORT: '3000',
    HOSTNAME: 'localhost',
    BASE_URL: 'http://localhost:3000',
    BETTER_AUTH_BASE_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: authSecret,
    AUTH_SECRET: authSecret,
    AUTH_COOKIE_SECURE: 'false',
    DATA: dataDir,
    CANVAS_DATA_ROOT: dataDir,
    DATABASE_URL: databaseUrl,
    CANVAS_DATABASE_PROVIDER: 'postgres',
    CANVAS_DEPLOYMENT_MODE: 'managed-team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_ORGANIZATION_ID: organizationId,
    CANVAS_INSTANCE_ID: instanceId,
    CANVAS_LICENSE_PUBLIC_KEY: publicKeyPem,
    CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: publicKeyFingerprint(publicKeyPem),
    CANVAS_LICENSE_CERT: license,
    CANVAS_COLLABORATION_TICKET_SECRET: crypto.randomBytes(48).toString('base64url'),
    BOOTSTRAP_ADMIN_EMAIL: adminEmail,
    BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
    BOOTSTRAP_ADMIN_NAME: localEnv.BOOTSTRAP_ADMIN_NAME || 'Collaboration E2E Admin',
    ONBOARDING: 'false',
  };

  mkdirSync(path.dirname(outputPath), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(outputPath, `${Object.entries(values).map(([key, value]) => envLine(key, value)).join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(outputPath, 0o600);
  console.log(`Created collaboration E2E environment at ${outputPath}`);
}

main();
