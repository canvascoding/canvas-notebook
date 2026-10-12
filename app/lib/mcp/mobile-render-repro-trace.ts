import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

type Phase = 'initial-source' | 'resource-read' | 'host-bundle' | 'final-source' | 'ticket';
type Trace = { run<T>(phase: Phase, operation: () => Promise<T>): Promise<T>; finish(error?: unknown): Promise<void> };
type Subphase = 'managed-acquire' | 'managed-current' | 'managed-health' | 'managed-failure-health' | 'managed-close'
  | 'tools-list' | 'resource-rpc' | 'dispatch-guard' | 'source-auth' | 'source-current-chat' | 'source-pi-session'
  | 'source-saved-receipt' | 'source-shared-access' | 'source-mcp-access' | 'source-environment' | 'source-final-auth';
const phases = new Set<Phase>(['initial-source', 'resource-read', 'host-bundle', 'final-source', 'ticket']);
const subphases = new Set<Subphase>(['managed-acquire', 'managed-current', 'managed-health', 'managed-failure-health', 'managed-close',
  'tools-list', 'resource-rpc', 'dispatch-guard', 'source-auth', 'source-current-chat', 'source-pi-session', 'source-saved-receipt',
  'source-shared-access', 'source-mcp-access', 'source-environment', 'source-final-auth']);
const errorNames = new Set(['Error', 'AssertionError', 'TypeError', 'AbortError', 'TimeoutError', 'McpAccessError',
  'McpStorageLockError', 'IntegrationConnectionError', 'IntegrationContractError', 'DatabaseUnavailableError']);
type OwnedSink = { file: string; device: number; inode: number; owner: number; deadline: number };
type Outcome = 'start' | 'completed' | 'failed';
type Span = { subphase: Subphase; span: number; parentSpan: number | null };
type SpanContext = { phase: Phase; depth: number; parentSpan: number | null; nextSpan: { value: number }; lease: { active: boolean };
  sourceIdentity: string; emit: (phase: Phase, outcome: Outcome, error?: unknown, span?: Span) => Promise<void> };
const runtimeKey = Symbol.for('canvas.mobile.mcp.render-repro.trace.v1');
type DiagnosticRuntime = { storage: AsyncLocalStorage<SpanContext>; requests: number; rows: number;
  sourceIdentity?: string; context?: Promise<OwnedSink | null> };
const shared = globalThis as typeof globalThis & { [runtimeKey]?: DiagnosticRuntime };
const runtime: DiagnosticRuntime = shared[runtimeKey] ??= { storage: new AsyncLocalStorage<SpanContext>(), requests: 0, rows: 0 };

function mobileRenderReproSourceIdentity(): string | null {
  if (process.env.CANVAS_AGENT_SETTINGS_BROWSER_RUN !== '1' || process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN !== '1'
    || process.env.CANVAS_SHARED_MCP_APPS_BROWSER_RUN !== '1' || process.env.CANVAS_MOBILE_MCP_RENDER_REPRO_RUN !== '1'
    || process.env.BASE_URL !== 'http://127.0.0.1:3001' || process.env.__NEXT_PROCESSED_ENV !== 'true') return null;
  // Only compare this private digest in memory; neither it nor its source values enter a row or authority context.
  return createHash('sha256').update(JSON.stringify([process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE, process.env.DATA,
    process.env.CANVAS_DATA_ROOT, process.env.TMPDIR, process.env.DATABASE_URL, process.pid])).digest('hex');
}

/** Error messages, stack frames, caller fields and arbitrary error names never enter the diagnostic. */
export function mobileRenderReproErrorName(error: unknown): string {
  try {
    const name = error instanceof Error ? error.name : '';
    return errorNames.has(name) ? name : 'OtherError';
  } catch { return 'OtherError'; }
}

async function readTraceContext(): Promise<OwnedSink | null> {
  if (!mobileRenderReproSourceIdentity()) return null;
  try {
    const receiptPath = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE ?? '';
    if (!path.isAbsolute(receiptPath) || path.basename(receiptPath) !== 'recovery.json') return null;
    const root = path.dirname(receiptPath), rootStat = await fs.lstat(/* turbopackIgnore: true */ root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.()
      || (rootStat.mode & 0o777) !== 0o700 || await fs.realpath(/* turbopackIgnore: true */ root) !== root) return null;
    const handle = await fs.open(/* turbopackIgnore: true */ receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== rootStat.uid || (stat.mode & 0o777) !== 0o600 || stat.size > 65536) return null;
      value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
    } finally { await handle.close(); }
    const deadline = Number(value.mobileRenderReproDeadline);
    const database = new URL(process.env.DATABASE_URL ?? '');
    if (value.version !== 1 || value.fixtureRoot !== root || value.mobileRenderRepro !== true || value.phase !== 'browser'
      || value.createAcknowledged !== true || value.listenerVerified !== true || value.uncertain !== false
      || value.serverPid !== process.pid || value.rootDevice !== String(rootStat.dev) || value.rootInode !== String(rootStat.ino)
      || !/^[a-f0-9]{32}$/u.test(String(value.nonce)) || value.databaseName !== `canvas_connection_test_${value.nonce}`
      || !['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1' || database.port !== '55433'
      || database.pathname !== `/${value.databaseName}` || database.search || database.hash
      || process.env.DATA !== path.join(/* turbopackIgnore: true */ root, 'data') || process.env.CANVAS_DATA_ROOT !== process.env.DATA
      || process.env.TMPDIR !== path.join(/* turbopackIgnore: true */ root, 'tmp') || !Number.isSafeInteger(deadline) || deadline <= Date.now()
      || deadline > Date.now() + 30 * 60_000) return null;
    const marker = await fs.open(path.join(/* turbopackIgnore: true */ root, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await marker.stat();
      if (!stat.isFile() || stat.uid !== rootStat.uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 1024
        || await marker.readFile('utf8') !== value.ownerMarker) return null;
    } finally { await marker.close(); }
    const file = path.join(/* turbopackIgnore: true */ root, 'render-repro-phases.jsonl');
    const output = await fs.open(/* turbopackIgnore: true */ file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { const stat = await output.stat(); return { file, device: stat.dev, inode: stat.ino, owner: stat.uid, deadline }; }
    finally { await output.close(); }
  } catch { return null; } // A diagnostic failure cannot change execution or public error behavior.
}

/** Fixed fixture-only sink, bounded independently of request count; no public endpoint or authority is added. */
export async function startMobileRenderReproTrace(): Promise<Trace | null> {
  const sourceIdentity = mobileRenderReproSourceIdentity();
  if (!sourceIdentity || runtime.sourceIdentity && runtime.sourceIdentity !== sourceIdentity) return null;
  runtime.sourceIdentity ??= sourceIdentity;
  const owned = await (runtime.context ??= readTraceContext());
  if (!owned || sourceIdentity !== mobileRenderReproSourceIdentity() || runtime.requests >= 32 || Date.now() >= owned.deadline) return null;
  const request = ++runtime.requests, start = performance.now(), lease = { active: true }, nextSpan = { value: 0 };
  const emit = async (phase: Phase, outcome: Outcome, error?: unknown, span?: Span) => {
    if (!lease.active || sourceIdentity !== mobileRenderReproSourceIdentity() || !phases.has(phase) || runtime.rows >= 512 || Date.now() >= owned.deadline) return;
    const ordinal = ++runtime.rows;
    const line = JSON.stringify({ version: 1, ordinal, request, phase, outcome,
      elapsedMs: Math.min(1_800_000, Math.max(0, Math.round(performance.now() - start))),
      ...(span ? span : {}), ...(ordinal === 512 ? { rowLimitReached: true } : {}),
      ...(outcome === 'failed' ? { errorClass: mobileRenderReproErrorName(error) } : {}) }) + '\n';
    try {
      const file = await fs.open(/* turbopackIgnore: true */ owned.file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owned.owner || (stat.mode & 0o777) !== 0o600
          || stat.dev !== owned.device || stat.ino !== owned.inode || stat.size > 512 * 1024) return;
        await file.write(line);
      } finally { await file.close(); }
    } catch { /* Never expose file paths or replace the original operation outcome. */ }
  };
  return {
    async run<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
      await emit(phase, 'start');
      try {
        const result = ['initial-source', 'resource-read', 'final-source'].includes(phase)
          ? await runtime.storage.run({ phase, depth: 0, parentSpan: null, nextSpan, lease, sourceIdentity, emit }, operation)
          : await operation();
        await emit(phase, 'completed'); return result;
      }
      catch (error) { await emit(phase, 'failed', error); throw error; }
    },
    async finish(error?: unknown) {
      const completion = emit('ticket', error === undefined ? 'completed' : 'failed', error);
      lease.active = false; // Suppress inherited background contexts immediately, even while the final sink write awaits.
      await completion;
    },
  };
}

/** Pure observation of one existing operation; no context means no sink, timer, authority or behavior change. */
export async function runMobileRenderReproSubphase<T>(subphase: Subphase, operation: () => Promise<T>): Promise<T> {
  const parent = runtime.storage.getStore();
  if (!parent || !parent.lease.active || !subphases.has(subphase) || parent.sourceIdentity !== mobileRenderReproSourceIdentity()
    || parent.depth >= 32 || parent.nextSpan.value >= 256) return operation();
  const span: Span = { subphase, span: ++parent.nextSpan.value, parentSpan: parent.parentSpan };
  await parent.emit(parent.phase, 'start', undefined, span);
  try {
    const result = await runtime.storage.run({ ...parent, depth: parent.depth + 1, parentSpan: span.span }, operation);
    await parent.emit(parent.phase, 'completed', undefined, span); return result;
  } catch (error) { await parent.emit(parent.phase, 'failed', error, span); throw error; }
}
