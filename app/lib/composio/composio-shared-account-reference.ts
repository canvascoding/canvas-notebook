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

const sealingKey = () => createHmac('sha256', resolveAuthSecret()).update('canvas-composio-account-reference-v1').digest();

export function createSharedComposioAccountReference(value: Omit<SharedComposioAccountReference, 'expiresAt'>): string {
  const payload = schema.parse({ ...value, expiresAt: Date.now() + 5 * 60_000 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}

export function readSharedComposioAccountReference(value: string): SharedComposioAccountReference {
  try {
    if (!value.startsWith(PREFIX) || value.length > 8192) throw new Error('invalid');
    const bytes = Buffer.from(value.slice(PREFIX.length), 'base64url');
    if (bytes.length < 29) throw new Error('invalid');
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    const parsed = schema.parse(JSON.parse(plain));
    if (parsed.expiresAt < Date.now()) throw new Error('expired');
    return parsed;
  } catch { throw new IntegrationConnectionError('binding_changed', 'The account selection expired or changed. Load the app accounts again.', 409); }
}

export function sharedComposioExpectedRevisions(input: { expectedMetadataRevision: number; expectedGrantsRevision: number; expectedBindingRevision: number }): IntegrationConnectionRevisions {
  return { metadataRevision: input.expectedMetadataRevision, grantsRevision: input.expectedGrantsRevision, bindingRevision: input.expectedBindingRevision };
}
