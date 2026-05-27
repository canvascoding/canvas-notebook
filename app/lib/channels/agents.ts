import { db } from '@/app/lib/db';
import { agents } from '@/app/lib/db/schema';
import { DEFAULT_AGENT_ID } from './constants';

export async function ensureDefaultAgent(): Promise<void> {
  const now = new Date();
  await db.insert(agents).values({
    agentId: DEFAULT_AGENT_ID,
    name: 'Canvas Agent',
    type: 'main',
    removable: false,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}
