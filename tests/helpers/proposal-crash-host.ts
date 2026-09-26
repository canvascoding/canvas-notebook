import { fork } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CrashPoint, CrashTarget } from '../../scripts/collaboration-proposal-crash-probe';
import type { PreparingCrashPoint } from '../../scripts/collaboration-proposal-preparing-crash-probe';

type Message = { type: string; point?: CrashPoint | PreparingCrashPoint; operationId?: string; documentId?: string;
  mutations?: number; acknowledged?: boolean; historyCaptured?: boolean; documentSequence?: number };

/** Owns one child only; a timeout never triggers another server or a replay. */
export async function startProposalCrashHost(logPath: string) {
  if (process.env.CANVAS_PROPOSAL_CRASH_TEST !== '1') throw new Error('Explicit crash-test opt-in is required.');
  const artifactRoot = await realpath(path.resolve('test-results'));
  const parent = await realpath(path.dirname(logPath));
  const relative = path.relative(artifactRoot, parent);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || !['initial-host.log', 'recovery-host.log', 'cleanup-recovery-host.log'].includes(path.basename(logPath))) {
    throw new Error('The crash log must be inside its dedicated Playwright artifact directory.');
  }
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
  await new Promise<void>((resolve, reject) => { log.once('open', () => resolve()); log.once('error', reject); });
  const child = fork(path.resolve('scripts/collaboration-proposal-crash-host.ts'), [], {
    cwd: process.cwd(), execArgv: ['--import', 'tsx'],
    env: { ...process.env, NODE_ENV: 'development', HOSTNAME: '127.0.0.1', PORT: '3000' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  const messages: Message[] = [];
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('message', value => { if (value && typeof value === 'object' && 'type' in value) messages.push(value as Message); });
  child.once('exit', (code, signal) => { exit = { code, signal }; log.end(); });
  const wait = async (predicate: () => boolean, timeout = 120_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (exit) throw new Error('Owned crash host exited before the expected milestone.');
      if (Date.now() >= deadline) throw new Error('Owned crash host observation timed out; no replacement was started.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const stop = async () => {
    if (!exit) child.kill('SIGTERM');
    await wait(() => exit !== null, 30_000);
  };
  try { await wait(() => messages.some(message => message.type === 'ready')); }
  catch (error) { await stop().catch(() => undefined); throw error; }
  return {
    pid: child.pid!, messages,
    isRunning: () => exit === null,
    async arm(target: CrashTarget, point: CrashPoint | PreparingCrashPoint, sessionId: string, agentId: string) {
      child.send({ type: 'arm', target, point, sessionId, agentId });
      await wait(() => messages.some(message => ['armed', 'refused'].includes(message.type)), 10_000);
      if (messages.some(message => message.type === 'refused')) throw new Error('Crash fixture scope was refused.');
    },
    async crashed() {
      await wait(() => exit !== null, 45_000);
      const boundary = messages.find(message => message.type === 'boundary');
      if (!boundary || exit!.signal !== 'SIGKILL') throw new Error('The expected crash boundary was not reached.');
      return { boundary, exit: exit! };
    },
    stop,
  };
}
