import 'server-only';

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';
import { IntegrationConnectionError, type IntegrationConnectionRevisions } from '@/app/lib/integration-tools/connections/contracts';

const PREFIX = 'cmp_account_';
const schema = z.object({ actorUserId: z.string(), workspaceId: z.string().nullable(), connectionRef: z.string(), profileId: z.string(),
  profileRevision: z.number().int().positive(), toolkit: z.string(), accountId: z.string(), credentialRevision: z.string(),
  metadataRevision: z.number().int().positive(), grantsRevision: z.number().int().positive(), bindingRevision: z.number().int().positive(),
  authorizationRevision: z.string(), expiresAt: z.number().int().positive() }).strict();
export type SharedComposioAccountReference = z.infer<typeof schema>;

const sealingKey = (purpose = 'canvas-composio-account-reference-v1') => createHmac('sha256', resolveAuthSecret()).update(purpose).digest();

function sealAccountReference(prefix: string, value: unknown, purpose?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(purpose), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `${prefix}${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}

function openAccountReference(value: string, prefix: string, purpose?: string): unknown {
  if (!value.startsWith(prefix) || value.length > 8192) throw new Error('invalid');
  const encoded = value.slice(prefix.length);
  const bytes = Buffer.from(encoded, 'base64url');
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || bytes.toString('base64url') !== encoded || bytes.length < 29) throw new Error('invalid');
  const decipher = createDecipheriv('aes-256-gcm', sealingKey(purpose), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}

export function createSharedComposioAccountReference(value: Omit<SharedComposioAccountReference, 'expiresAt'>): string {
  const payload = schema.parse({ ...value, expiresAt: Date.now() + 5 * 60_000 });
  return sealAccountReference(PREFIX, payload);
}

export function readSharedComposioAccountReference(value: string): SharedComposioAccountReference {
  try {
    const parsed = schema.parse(openAccountReference(value, PREFIX));
    if (parsed.expiresAt < Date.now()) throw new Error('expired');
    return parsed;
  } catch { throw new IntegrationConnectionError('binding_changed', 'The account selection expired or changed. Load the app accounts again.', 409); }
}

const PERSONAL_PREFIX = 'cmp_personal_account_';
const PERSONAL_PURPOSE = 'canvas-composio-personal-workflow-account-v1';
const bounded = z.string().min(1).max(256);
const personalSchema = z.object({ actorUserId: bounded, workspaceId: bounded.nullable(), organizationId: bounded.nullable(),
  providerRef: bounded, profileId: bounded, cacheRevision: bounded, toolkit: bounded, accountId: bounded,
  credentialRevision: bounded, expiresAt: z.number().int().positive() }).strict();
export type PersonalComposioAccountReference = z.infer<typeof personalSchema>;

export function createPersonalComposioAccountReference(value: Omit<PersonalComposioAccountReference, 'expiresAt'>): string {
  return sealAccountReference(PERSONAL_PREFIX, personalSchema.parse({ ...value, expiresAt: Date.now() + 5 * 60_000 }), PERSONAL_PURPOSE);
}

export function readPersonalComposioAccountReference(value: string): PersonalComposioAccountReference {
  try {
    const parsed = personalSchema.parse(openAccountReference(value, PERSONAL_PREFIX, PERSONAL_PURPOSE));
    if (parsed.expiresAt <= Date.now()) throw new Error('expired');
    return parsed;
  } catch { throw new IntegrationConnectionError('binding_changed', 'The account selection expired or changed. Load the app accounts again.', 409); }
}

export function sharedComposioExpectedRevisions(input: { expectedMetadataRevision: number; expectedGrantsRevision: number; expectedBindingRevision: number }): IntegrationConnectionRevisions {
  return { metadataRevision: input.expectedMetadataRevision, grantsRevision: input.expectedGrantsRevision, bindingRevision: input.expectedBindingRevision };
}
