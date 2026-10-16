import { z } from 'zod';
import { chatBodyV1Schema } from '@/app/lib/chat/chat-body-contracts';

const kind = z.enum(['plugin', 'skill']);
const locale = z.enum(['de', 'en']).optional();
export const capabilityPackageCreatorChatIntentSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), kind, locale }).strict(),
  z.object({ operation: z.literal('resume'), draftRef: z.string().regex(/^canvas-package-draft:[a-f0-9-]{36}$/u), locale }).strict(),
]);
export type CreatorChatIntent = z.infer<typeof capabilityPackageCreatorChatIntentSchema>;
const ownership = z.object({ type: z.literal('organization'), organizationId: z.string().min(1).max(256) }).strict();
export const capabilityPackageCreatorOptionsSchema = z.object({ schemaVersion: z.literal(1), workspaceId: z.string().min(1),
  canCreate: z.boolean(), ownership: ownership.nullable(),
  creators: z.array(z.object({ kind, available: z.boolean() }).strict()).length(2),
}).strict();
export type CapabilityPackageCreatorOptions = z.infer<typeof capabilityPackageCreatorOptionsSchema>;
export const capabilityPackageCreatorChatSchema = z.object({ schemaVersion: z.literal(1), workspaceId: z.string().min(1),
  agentId: z.string().min(1), kind, mode: z.literal('compose'), body: chatBodyV1Schema, prompt: z.string(),
  draftRef: z.string().regex(/^canvas-package-draft:[a-f0-9-]{36}$/u).optional(),
}).strict();
export type CapabilityPackageCreatorChat = z.infer<typeof capabilityPackageCreatorChatSchema>;
