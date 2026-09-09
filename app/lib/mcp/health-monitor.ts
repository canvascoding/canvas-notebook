import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveUsersDataRoot } from '@/app/lib/runtime-data-paths';
import { assertUserSeatAccess } from '@/app/lib/license/seat-limit';
import { assertUserOrganizationAdmin } from '@/app/lib/organization/permissions';
import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { claimMcpConnectionProbe, classifyMcpConnectionFailure, recordMcpConnectionObservation } from '@/app/lib/mcp/connection-health';
import { readMcpConnectionStatus } from '@/app/lib/mcp/connection-status';
import { probeMcpConnection } from '@/app/lib/mcp/manager';
import { MCP_SYSTEM_SCOPE } from '@/app/lib/mcp/scope';
import { readMcpTextFileIfExists, writeMcpTextFileAtomic } from '@/app/lib/mcp/storage';
import { withMcpStorageLock } from '@/app/lib/mcp/storage-lock';

const MONITOR_INTERVAL_MS = 60_000;
const MAX_USERS_PER_PASS = 100;
const MAX_PROBES_PER_PASS = 8;
const MAX_VISITS_PER_PASS = 64;
const MAX_PASS_MS = 45_000;
const LEASE_FILE = 'mcp-health-monitor.json';
type MonitorCursor = { nextRunAt: number; userOffset: number; connectionOffset: number; lease?: string };
type Candidate = { userId: string; serverName: string; connection: McpServerConfig & { connectionId: string } };

/** Current management policy; member definitions extend this guard in the access layer. */
async function mayProbeUser(userId: string): Promise<boolean> {
  try {
    await assertUserSeatAccess({ userId });
    await assertUserOrganizationAdmin(userId);
    return true;
  } catch {
    return false;
  }
}

export async function runMcpConnectionHealthChecks(now = Date.now()): Promise<number> {
  const startedAt = Date.now();
  const lease = crypto.randomUUID();
  const cursor = await withMcpStorageLock('health-monitor', MCP_SYSTEM_SCOPE, async () => {
    const raw = (await readMcpTextFileIfExists(LEASE_FILE, MCP_SYSTEM_SCOPE)).content;
    const previous = raw ? JSON.parse(raw) as MonitorCursor : { nextRunAt: 0, userOffset: 0, connectionOffset: 0 };
    if (previous.nextRunAt > now) return null;
    await writeMcpTextFileAtomic(LEASE_FILE, JSON.stringify({ ...previous, lease, nextRunAt: now + MONITOR_INTERVAL_MS }), MCP_SYSTEM_SCOPE);
    return previous;
  });
  if (!cursor) return 0;
  const users = (await fs.readdir(resolveUsersDataRoot(), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const candidates: Candidate[] = [];
  const scanLimit = Math.min(users.length, MAX_USERS_PER_PASS);
  let scanned = 0;
  for (; scanned < scanLimit && Date.now() - startedAt < 10_000; scanned += 1) {
    const userId = users[(cursor.userOffset + scanned) % users.length];
    if (!await fs.stat(path.join(resolveUsersDataRoot(), userId, 'mcp', 'config.json')).then((stat) => stat.isFile()).catch(() => false)) continue;
    if (!await mayProbeUser(userId)) continue;
    try {
      const config = await readMcpConfig({ userId });
      for (const [serverName, connection] of Object.entries(config.mcpServers)) {
        if (connection.connectionId && connection.enabled !== false && connection.url && !connection.command) {
          candidates.push({ userId, serverName, connection: connection as Candidate['connection'] });
        }
      }
    } catch {
      // Invalid or inaccessible user configuration never turns into a network probe.
    }
  }
  let checked = 0;
  let visited = 0;
  for (; visited < Math.min(candidates.length, MAX_VISITS_PER_PASS) && checked < MAX_PROBES_PER_PASS
    && Date.now() - startedAt < MAX_PASS_MS; visited += 1) {
    const candidate = candidates[(cursor.connectionOffset + visited) % candidates.length];
    const scope = { userId: candidate.userId };
    try {
      const health = await readMcpConnectionStatus(candidate.serverName, candidate.connection, scope, now);
      if ((candidate.connection.auth === 'oauth' || candidate.connection.oauth) && health.authStatus === 'not_authorized') continue;
      if (!await claimMcpConnectionProbe(candidate.connection, scope, now)) continue;
      checked += 1;
      const signal = AbortSignal.timeout(5000);
      try {
        await probeMcpConnection(candidate.serverName, scope, signal);
      } catch (error) {
        const code = signal.aborted ? 'network_error' : classifyMcpConnectionFailure(error);
        if (code) await recordMcpConnectionObservation(candidate.connection, scope, { kind: 'failure', code }, { generation: health.authGeneration });
      }
    } catch {
      // A missing key, concurrent edit or revoked user access is not a network outage.
    }
  }
  await withMcpStorageLock('health-monitor', MCP_SYSTEM_SCOPE, async () => {
    const raw = (await readMcpTextFileIfExists(LEASE_FILE, MCP_SYSTEM_SCOPE)).content;
    if (!raw || (JSON.parse(raw) as MonitorCursor).lease !== lease) return;
    await writeMcpTextFileAtomic(LEASE_FILE, JSON.stringify({
      nextRunAt: now + MONITOR_INTERVAL_MS,
      userOffset: users.length ? (cursor.userOffset + scanned) % users.length : 0,
      connectionOffset: candidates.length ? (cursor.connectionOffset + visited) % candidates.length : 0,
    } satisfies MonitorCursor), MCP_SYSTEM_SCOPE);
  });
  return checked;
}

const runtime = globalThis as typeof globalThis & { __canvasMcpHealthMonitor?: ReturnType<typeof setInterval>; __canvasMcpHealthBusy?: boolean };
export function initializeMcpConnectionHealthMonitor(): void {
  if (runtime.__canvasMcpHealthMonitor || process.env.NEXT_PHASE === 'phase-production-build' || process.env.MCP_HEALTH_CHECKS_ENABLED === 'false') return;
  const run = () => {
    if (runtime.__canvasMcpHealthBusy) return;
    runtime.__canvasMcpHealthBusy = true;
    void runMcpConnectionHealthChecks()
      .catch(() => console.warn('[MCP] Connection health pass could not complete.'))
      .finally(() => { runtime.__canvasMcpHealthBusy = false; });
  };
  setTimeout(run, 15_000).unref();
  runtime.__canvasMcpHealthMonitor = setInterval(run, MONITOR_INTERVAL_MS);
  runtime.__canvasMcpHealthMonitor.unref();
}
