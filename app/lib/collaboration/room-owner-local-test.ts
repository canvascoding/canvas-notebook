import 'server-only';

import { Client } from 'pg';
import { openDb } from '@/app/lib/db';
import { createCollaborationAdmissionService } from './room-admission';
import {
  createCollaborationRoomOwnerSession,
  type CollaborationRoomOwnerFence,
} from './room-owner';
import {
  recoverCollaborationRoomRelease,
  type CollaborationRoomReleaseSnapshot,
} from './room-owner-release';
import type { CollaborationRoomOwnerRuntimeOptions } from './room-owner-runtime';

const LOCAL_TEST_HOSTS = new Set(['127.0.0.1', 'localhost']);
const LOCAL_TEST_PORTS = new Set(['3101', '3102']);

function localTestDatabaseUrl(): URL {
  let parsed: URL;
  try { parsed = new URL(process.env.DATABASE_URL || ''); }
  catch { throw new Error('The collaboration owner acceptance harness requires a valid local DATABASE_URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !LOCAL_TEST_HOSTS.has(parsed.hostname)
    || parsed.port !== '55433'
    || parsed.pathname !== '/canvas_notebook') {
    throw new Error('The collaboration owner acceptance harness only accepts managed loopback PostgreSQL.');
  }
  return parsed;
}

function assertLocalTestRuntime(): URL {
  if (process.env.NODE_ENV !== 'development'
    || process.env.COLLABORATION_E2E !== '1'
    || process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST !== '1'
    || process.env.CANVAS_PROPOSAL_CRASH_TEST !== '1'
    || process.env.CANVAS_COLLABORATION_MULTIPROCESS_TEST !== '1'
    || process.env.CANVAS_DATABASE_PROVIDER !== 'postgres'
    || !LOCAL_TEST_HOSTS.has(process.env.HOSTNAME || '')
    || !LOCAL_TEST_PORTS.has(process.env.PORT || '')
    || process.env.BASE_URL !== 'http://127.0.0.1:3000') {
    throw new Error('The collaboration owner acceptance harness requires explicit local test opt-ins.');
  }
  return localTestDatabaseUrl();
}

async function createDedicatedClient(databaseUrl: URL, purpose: 'owner' | 'recovery'): Promise<Client> {
  const client = new Client({
    connectionString: databaseUrl.toString(),
    application_name: `canvas-collaboration-${purpose}-test-${process.pid}`,
    connectionTimeoutMillis: 3_000,
  });
  await client.connect();
  return client;
}

/**
 * Test-only wiring for the two-process crash/reconnect acceptance gate.
 * Production deliberately receives no environment-controlled owner rollout.
 */
export function resolveLocalCollaborationRoomOwnerOptions(): CollaborationRoomOwnerRuntimeOptions & {
  admission: {
    pendingDrains: (fences: readonly CollaborationRoomOwnerFence[]) => Promise<readonly import('./room-admission-drain').CollaborationAdmissionDrainTicket[]>;
    readDrain: (ticket: import('./room-admission-drain').CollaborationAdmissionDrainTicket) => Promise<Readonly<{
      ticket: import('./room-admission-drain').CollaborationAdmissionDrainTicket;
      status: 'draining' | 'released';
    }>>;
    pollMs: number;
  };
} | undefined {
  if (process.env.CANVAS_COLLABORATION_MULTIPROCESS_TEST !== '1') return undefined;
  const databaseUrl = assertLocalTestRuntime();
  const admission = createCollaborationAdmissionService({ openConnection: openDb });
  return {
    createSession: async (onInvalidated) => createCollaborationRoomOwnerSession(
      await createDedicatedClient(databaseUrl, 'owner'),
      onInvalidated,
    ),
    recoverRelease: (input: { fence: CollaborationRoomOwnerFence; snapshot: CollaborationRoomReleaseSnapshot }) => (
      recoverCollaborationRoomRelease({
        ...input,
        createClient: () => createDedicatedClient(databaseUrl, 'recovery'),
      })
    ),
    heartbeatMs: 100,
    admission: {
      pendingDrains: admission.pendingDrains,
      readDrain: admission.readDrain,
      pollMs: 100,
    },
  };
}
