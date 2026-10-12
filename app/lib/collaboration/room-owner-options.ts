import 'server-only';

import { Client } from 'pg';
import { openDb } from '@/app/lib/db';
import { createCollaborationRoomOwnerSession } from './room-owner';
import { recoverCollaborationRoomRelease } from './room-owner-release';
import { createCollaborationAdmissionService } from './room-admission';
import { createCollaborationAdmissionHandoffService } from './room-admission-handoff';
import { captureCollaborationAdmissionRequest } from './room-admission-contract';
import type { CollaborationRoomOwnerRuntimeOptions } from './room-owner-runtime';

async function connectOwnerClient(purpose: string) {
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    application_name: `canvas-collaboration-${purpose}-${process.pid}`, connectionTimeoutMillis: 5_000 });
  try { await client.connect(); return client; }
  catch (error) { await client.end().catch(() => {}); throw error; }
}

/** The regular custom server uses the same fenced owner/drain machinery as acceptance. */
export function createCollaborationRoomOwnerOptions(): CollaborationRoomOwnerRuntimeOptions & {
  admission: {
    pendingDrains: ReturnType<typeof createCollaborationAdmissionService>['pendingDrains'];
    readDrain: (ticket: Parameters<ReturnType<typeof createCollaborationAdmissionService>['readDrain']>[0]) => Promise<{
      ticket: Parameters<ReturnType<typeof createCollaborationAdmissionService>['readDrain']>[0];
      status: 'draining' | 'released'; blockActiveClients: boolean;
    }>;
    pollMs: number;
  };
} {
  const admission = createCollaborationAdmissionService({ openConnection: openDb });
  const history = createCollaborationAdmissionHandoffService({ openConnection: openDb,
    withMutationLocks: async (_workspaceIds, operation) => operation() });
  return {
    createSession: async onInvalidated => createCollaborationRoomOwnerSession(await connectOwnerClient('owner'), onInvalidated),
    recoverRelease: input => recoverCollaborationRoomRelease({ ...input, createClient: () => connectOwnerClient('release-recovery') }),
    heartbeatMs: 5_000,
    admission: { pendingDrains: async fences => {
      const database = await openDb();
      try {
        await database.run("SET statement_timeout = '3s'");
        await database.get('SELECT (SELECT count(*) FROM collaboration_admission_requests WHERE false) AS requests, (SELECT count(*) FROM collaboration_admission_targets WHERE false) AS targets, (SELECT count(*) FROM collaboration_room_release_receipts WHERE false) AS receipts');
      } finally { await database.close(new Error('Discarding bounded migration readiness probe session.')); }
      return admission.pendingDrains(fences);
    }, pollMs: 250,
      readDrain: async ticket => {
        const verified = await admission.readDrain(ticket);
        const request = await history.loadRequest(ticket.requestId);
        if (!request || captureCollaborationAdmissionRequest(request).requestDigest !== ticket.requestDigest) {
          throw new Error('The drain request identity changed.');
        }
        return { ...verified, blockActiveClients: request.action === 'representation_change' };
      },
    },
  };
}
