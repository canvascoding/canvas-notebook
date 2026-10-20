import 'server-only';

import { execFile, spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';

import { acquireAgentRuntimeTempLease, assertAgentRuntimeTempQuota } from '@/app/lib/pi/agent-runtime-temp';
import { SkillScriptError, isSkillScriptError, type SkillScriptDeclaration, type SkillScriptRuntime } from './contracts';
import { attachSkillScriptBridge, encodeSkillScriptFrame, SkillScriptProtocolError } from './protocol';

const exec = promisify(execFile);
const SCRIPT_TIMEOUT_MS = 60_000;
const SCRIPT_LOG_BYTES = 256 * 1024;
const REVALIDATION_INTERVAL_MS = 500;

type RuntimeInstallation = { executable: string; version: string; read: string[]; execute: string[] };
export type SkillScriptRuntimeReadiness = {
  available: boolean;
  runtime: 'node' | 'python';
  version: string | null;
  sandboxMode: 'seatbelt' | 'landlock' | null;
  code?: string;
  message?: string;
};
export type SkillScriptProcessResult = {
  exitCode: number | null; stdout: string; stderr: string; scratchDirectory: string;
  sandboxMode: 'seatbelt' | 'landlock'; terminated: boolean;
};

function appRoot(): string { return path.resolve(process.env.CANVAS_APP_ROOT?.trim() || process.cwd()); }
function sdkRoot(): string { return path.join(appRoot(), 'app/lib/skills/script-runtime/sdk'); }
function launcher(): string { return path.join(appRoot(), 'scripts/runtime/skill-script-sandbox.py'); }

function versionParts(value: string): { numbers: bigint[]; prerelease: string[] } | null {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value);
  if (!match || value.length > 128 || match[4]?.split('.').some(part => /^0[0-9]+$/u.test(part))) return null;
  return { numbers: match.slice(1, 4).map(part => BigInt(part)), prerelease: match[4]?.split('.') ?? [] };
}
function versionAtLeast(actual: string, minimum?: string): boolean {
  if (!minimum) return true;
  const left = versionParts(actual), right = versionParts(minimum);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i];
  if (!left.prerelease.length || !right.prerelease.length) return !left.prerelease.length || Boolean(right.prerelease.length);
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const a = left.prerelease[i], b = right.prerelease[i];
    if (a === undefined || b === undefined) return a !== undefined;
    if (a === b) continue;
    const numericA = /^[0-9]+$/u.test(a), numericB = /^[0-9]+$/u.test(b);
    return numericA && numericB ? BigInt(a) > BigInt(b) : numericA !== numericB ? !numericA : a > b;
  }
  return true;
}

function cleanEnvironment(scratch?: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'production', OPENSSL_CONF: '/dev/null',
    ...(scratch ? { HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      XDG_CACHE_HOME: path.join(scratch, '.cache'), XDG_CONFIG_HOME: path.join(scratch, '.config'),
      XDG_DATA_HOME: path.join(scratch, '.local/share'), XDG_RUNTIME_DIR: path.join(scratch, '.run'),
      CANVAS_AGENT_TEMP_DIR: scratch, CANVAS_SKILL_SCRATCH_DIR: scratch,
      CANVAS_SKILL_BRIDGE_MODULE: path.join(sdkRoot(), 'node.cjs') } : {}),
  };
}

async function existingCanonical(values: string[]): Promise<string[]> {
  const entries = await Promise.all(values.map(async value => fs.realpath(value).catch(() => null)));
  return [...new Set(entries.filter((value): value is string => value !== null))];
}

/** Only runtime libraries are inspected; no package/user supplied command is passed to ldd/otool. */
async function sharedLibraries(executable: string): Promise<string[]> {
  if (process.platform === 'linux') {
    const result = await exec('/usr/bin/ldd', [executable], { env: cleanEnvironment(), timeout: 5_000, maxBuffer: 128 * 1024 });
    return existingCanonical([...result.stdout.matchAll(/(?:=>\s*)?(\/[\w/+.@-]+)\s*\(/gu)].map(match => match[1]));
  }
  const roots = await existingCanonical(['/usr/lib', '/System/Library', '/usr/share/zoneinfo/UTC']);
  const pending = [executable], checked = new Set<string>(), libraries = new Set<string>(roots);
  while (pending.length) {
    const file = pending.pop()!;
    if (checked.has(file)) continue;
    checked.add(file);
    if (checked.size > 128) throw new Error('Runtime dependency limit');
    const result = await exec('/usr/bin/otool', ['-L', file], { env: cleanEnvironment(), timeout: 5_000, maxBuffer: 128 * 1024 });
    for (const match of result.stdout.matchAll(/^\s+([^\n]+?)\s+\(compatibility/gmu)) {
      const item = match[1];
      if (item.startsWith('@rpath/') && file.endsWith(`/${item.slice(7)}`)) continue; // LC_ID_DYLIB, not a dependency.
      const candidates = item.startsWith('@rpath/') ? [path.join(path.dirname(executable), '../lib', item.slice(7)), path.join(path.dirname(file), item.slice(7))]
        : [item.replace('@executable_path/', `${path.dirname(executable)}/`).replace('@loader_path/', `${path.dirname(file)}/`)];
      const canonical = (await existingCanonical(candidates))[0];
      if (canonical) {
        const alias = candidates.find(value => path.isAbsolute(value));
        if (alias) libraries.add(path.resolve(alias));
        if (!libraries.has(canonical)) { libraries.add(canonical); pending.push(canonical); }
      }
      // System libraries live in Apple's dyld cache and need not exist as files.
      else if (!canonical && !item.startsWith('/usr/lib/') && !item.startsWith('/System/Library/')) throw new Error('Required runtime library is missing');
    }
  }
  return [...libraries];
}

async function runtimeInstallation(runtime: SkillScriptRuntime): Promise<RuntimeInstallation> {
  if (runtime.kind === 'node') {
    const executable = await fs.realpath(process.execPath);
    await fs.access(executable, constants.X_OK);
    const { stdout } = await exec(executable, ['--version'], { env: cleanEnvironment(), timeout: 5_000, maxBuffer: 16 * 1024 });
    const version = stdout.trim().replace(/^v/u, '');
    if (!versionParts(version) || !versionAtLeast(version, runtime.minimumVersion)) throw new Error('Required Node version is unavailable');
    // Node's CommonJS resolver reads this public build manifest before resolving
    // an absolute SDK import. Grant only the checked file, never its directory.
    const manifest = await exactPackageFile(await fs.realpath(appRoot()), 'package.json');
    const libraries = await sharedLibraries(executable);
    return { executable, version, read: [manifest, ...libraries],
      execute: [executable, ...libraries.filter(value => /\/ld-(?:linux|musl)|\/ld\.so/u.test(value))] };
  }
  const result = await exec('/usr/bin/python3', ['-I', '-B', '-S', '-c',
    ['import json,sys,ctypes', 'executable=sys.executable',
      'if sys.platform=="darwin":',
      ' size=ctypes.c_uint32(4096); buffer=ctypes.create_string_buffer(size.value)',
      ' if ctypes.CDLL(None)._NSGetExecutablePath(buffer,ctypes.byref(size))!=0: raise RuntimeError("Runtime executable unavailable")',
      ' executable=buffer.value.decode("utf-8")',
      'v=sys.version_info',
      'print(json.dumps({"executable":executable,"version":"%d.%d.%d"%v[:3]+("" if v.releaselevel=="final" else "-"+v.releaselevel+"."+str(v.serial)),"paths":sys.path}))',
    ].join('\n')],
  { env: cleanEnvironment(), timeout: 5_000, maxBuffer: 32 * 1024 });
  const installation = JSON.parse(result.stdout) as { executable: string; version: string; paths: string[] };
  const executable = await fs.realpath(installation.executable);
  if (!versionParts(installation.version) || !versionAtLeast(installation.version, runtime.minimumVersion)) throw new Error('Required Python version is unavailable');
  const libraries = await sharedLibraries(executable);
  return { executable, version: installation.version,
    read: [...libraries, ...await existingCanonical(installation.paths)],
    execute: [executable, ...libraries.filter(value => /\/ld-(?:linux|musl)|\/ld\.so/u.test(value))] };
}

/** No paths/secret values are returned by readiness. The actual launch still enforces the policy again. */
export async function probeSkillScriptRuntime(input: { runtime: SkillScriptRuntime }): Promise<SkillScriptRuntimeReadiness> {
  const sandboxMode = process.platform === 'darwin' ? 'seatbelt' : process.platform === 'linux' ? 'landlock' : null;
  let installation: RuntimeInstallation;
  try { installation = await runtimeInstallation(input.runtime); }
  catch { return { available: false, runtime: input.runtime.kind, version: null, sandboxMode,
    code: 'SCRIPT_RUNTIME_UNAVAILABLE', message: 'The declared script runtime or minimum version is unavailable.' }; }
  try {
    if (!sandboxMode) throw new Error('Unsupported platform');
    if (sandboxMode === 'landlock') {
      const result = await exec('/usr/bin/python3', ['-I', '-B', '-S', launcher(), '--probe'], { env: cleanEnvironment(), timeout: 5_000, maxBuffer: 16 * 1024 });
      if (JSON.parse(result.stdout).confined !== true) throw new Error('Unavailable confinement');
    } else {
      const profile = buildSeatbeltProfile({ packageRoot: sdkRoot(), scratch: `/private/tmp/canvas-skill-probe-no-writes-${process.pid}`, installation });
      await exec('/usr/bin/sandbox-exec', ['-p', profile, installation.executable, '--version'], { cwd: sdkRoot(), env: cleanEnvironment(), timeout: 5_000, maxBuffer: 16 * 1024 });
    }
    return { available: true, runtime: input.runtime.kind, version: installation.version, sandboxMode };
  } catch { return { available: false, runtime: input.runtime.kind, version: installation.version, sandboxMode,
    code: 'SCRIPT_SANDBOX_UNAVAILABLE', message: 'The required script isolation is unavailable.' }; }
}

function buildSeatbeltProfile(input: { packageRoot: string; scratch: string; installation: RuntimeInstallation }): string {
  const reads = [...new Set([input.packageRoot, input.scratch, sdkRoot(), path.dirname(input.installation.executable), ...input.installation.read, ...input.installation.execute])];
  return ['(version 1)', '(allow default)', '(deny network*)', '(deny mach-lookup)',
    '(deny process-fork)', '(deny process-info*)', '(allow process-info* (target self))', '(deny process-exec)',
    `(allow process-exec ${input.installation.execute.map(value => `(literal ${JSON.stringify(value)})`).join(' ')})`,
    // Metadata is needed for canonical loader traversal, as on Landlock. It
    // grants neither file bytes nor directory enumeration outside these roots.
    '(deny file-read*)', '(allow file-read-metadata)', `(allow file-read* ${reads.map(value => `(subpath ${JSON.stringify(value)})`).join(' ')} (literal "/") (literal "/dev/null") (literal "/dev/urandom"))`,
    '(deny file-write*)', `(allow file-write* (subpath ${JSON.stringify(input.scratch)}))`,
    '(allow file-write-data (literal "/dev/null"))', '(deny file-issue-extension)',
  ].join('\n');
}

async function exactPackageFile(root: string, relative: string): Promise<string> {
  if (!relative || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new SkillScriptError('SCRIPT_PACKAGE_CHANGED', 'The declared script path is unavailable.', 409);
  }
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw new SkillScriptError('SCRIPT_PACKAGE_CHANGED', 'The declared script path is unavailable.', 409);
  }
  if (!(await fs.lstat(current)).isFile() || await fs.realpath(current) !== current) throw new SkillScriptError('SCRIPT_PACKAGE_CHANGED', 'The declared script path is unavailable.', 409);
  return current;
}

/** Runs only a server-authorized immutable child package. Caller owns successful scratch cleanup after output import. */
export async function executeSkillScriptProcess(input: {
  declaration: SkillScriptDeclaration; packageRoot: string; entryPath: string; scratchParent: string;
  arguments: Record<string, unknown>; signal?: AbortSignal; onRequest: (raw: unknown) => Promise<unknown>;
  revalidate: () => Promise<void>;
  onStop?: (reason: string) => void;
}): Promise<SkillScriptProcessResult> {
  if (input.signal?.aborted) throw new SkillScriptError('SCRIPT_ABORTED', 'The script run was cancelled.');
  const declaration = structuredClone(input.declaration);
  let argumentsFrame: Buffer;
  try { argumentsFrame = encodeSkillScriptFrame(input.arguments); }
  catch { throw new SkillScriptError('SCRIPT_LIMIT_EXCEEDED', 'Script arguments exceed their transport limit.'); }
  const revalidate = async () => {
    try { await input.revalidate(); }
    catch (error) { throw isSkillScriptError(error) ? error : new SkillScriptError('SCRIPT_ACCESS_DENIED', 'The script run is no longer permitted.', 403); }
  };
  await revalidate();
  let installation: RuntimeInstallation;
  try { installation = await runtimeInstallation(declaration.runtime); }
  catch { throw new SkillScriptError('SCRIPT_RUNTIME_UNAVAILABLE', 'The declared script runtime or minimum version is unavailable.', 503); }
  const sandboxMode = process.platform === 'darwin' ? 'seatbelt' : process.platform === 'linux' ? 'landlock' : null;
  if (!sandboxMode) throw new SkillScriptError('SCRIPT_SANDBOX_UNAVAILABLE', 'The required script isolation is unavailable.', 503);
  const packageRoot = await fs.realpath(input.packageRoot), parent = await fs.realpath(input.scratchParent);
  if ((await fs.lstat(input.packageRoot)).isSymbolicLink() || !(await fs.lstat(parent)).isDirectory()) throw new SkillScriptError('SCRIPT_PACKAGE_CHANGED', 'The script package or scratch is unavailable.', 409);
  const entry = await exactPackageFile(packageRoot, declaration.path);
  if (await fs.realpath(input.entryPath) !== entry) throw new SkillScriptError('SCRIPT_PACKAGE_CHANGED', 'The script entrypoint changed.', 409);
  const dependencies = await Promise.all((declaration.dependencies ?? []).map(dependency => exactPackageFile(packageRoot, dependency.path)));
  await assertAgentRuntimeTempQuota(parent);
  const releaseLease = acquireAgentRuntimeTempLease(parent);
  let scratch: string;
  try { scratch = await fs.mkdtemp(path.join(parent, 'skill-script-')); }
  catch { releaseLease(); throw new SkillScriptError('SCRIPT_EXECUTION_FAILED', 'The script scratch could not be prepared.'); }
  const identity = await fs.lstat(scratch);
  const cleanup = async () => {
    const current = await fs.lstat(scratch).catch(() => null);
    if (path.dirname(scratch) !== parent || !path.basename(scratch).startsWith('skill-script-')
      || !current?.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return;
    await fs.rm(scratch, { recursive: true, force: true });
  };
  try {
    await fs.chmod(scratch, 0o700);
    await fs.mkdir(path.join(scratch, '.run'), { mode: 0o700 });
    const args = declaration.runtime.kind === 'node' ? [entry] : ['-I', '-B', '-S', path.join(sdkRoot(), 'python/bootstrap.py'),
      path.join(sdkRoot(), 'python'), packageRoot, entry, JSON.stringify([...new Set(dependencies.map(value => path.dirname(value)))])];
    const policy = { read: [packageRoot, sdkRoot(), ...installation.read], execute: installation.execute, scratch,
      devices: await existingCanonical(['/dev/null', '/dev/urandom']) };
    const executable = sandboxMode === 'seatbelt' ? '/usr/bin/sandbox-exec' : '/usr/bin/python3';
    const launchArgs = sandboxMode === 'seatbelt' ? ['-p', buildSeatbeltProfile({ packageRoot, scratch, installation }), installation.executable, ...args]
      : ['-I', '-B', '-S', launcher(), JSON.stringify(policy), installation.executable, ...args];
    await revalidate();
    if (input.signal?.aborted) throw new SkillScriptError('SCRIPT_ABORTED', 'The script run was cancelled.');
    const child = spawn(executable, launchArgs, { cwd: scratch, env: cleanEnvironment(scratch), detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    let failure: Error | null = null, terminated = false, running = true, groupStopped = false, stdout = '', stderr = '', outBytes = 0, errorBytes = 0;
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      if (!child.pid || groupStopped) return;
      groupStopped = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const stop = (error?: Error, reason?: string) => {
      if (terminated || !running) return;
      if (error && !failure) failure = error;
      terminated = true;
      try { input.onStop?.(reason ?? (isSkillScriptError(error) ? error.code : 'SCRIPT_PROTOCOL_INVALID')); }
      catch { failure ??= new SkillScriptError('SCRIPT_EXECUTION_FAILED', 'The script run could not be stopped cleanly.'); }
      finally { killGroup(); }
    };
    const abort = () => stop(new SkillScriptError('SCRIPT_ABORTED', 'The script run was cancelled.'));
    input.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => stop(new SkillScriptError('SCRIPT_TIMEOUT', 'The script run exceeded its time limit.')), SCRIPT_TIMEOUT_MS);
    const watch = async () => {
      try {
        await revalidate();
        if (!running || terminated) return;
        await assertAgentRuntimeTempQuota(parent);
      } catch (error) {
        if (running && !terminated) stop(isSkillScriptError(error) ? error : new SkillScriptError('SCRIPT_ACCESS_DENIED', 'The script run is no longer permitted.', 403));
      }
      if (running && !terminated) watchTimer = setTimeout(() => { void watch(); }, REVALIDATION_INTERVAL_MS);
    };
    watchTimer = setTimeout(() => { void watch(); }, REVALIDATION_INTERVAL_MS);
    const bridge = attachSkillScriptBridge({ requests: child.stdio[3] as Readable, responses: child.stdio[4] as Writable,
      onRequest: async raw => { await revalidate(); if (terminated || !running) throw new SkillScriptProtocolError(); return input.onRequest(raw); },
      terminate: error => {
        if (error.message === 'The script tool bridge stopped this run.') stop(undefined, 'SCRIPT_OUTCOME_UNKNOWN');
        else stop(isSkillScriptError(error) ? error : new SkillScriptError('SCRIPT_PROTOCOL_INVALID', 'The script tool bridge protocol is invalid.'));
      } });
    child.stdout!.on('data', (bytes: Buffer) => {
      outBytes += bytes.length; if (outBytes > SCRIPT_LOG_BYTES) stop(new SkillScriptError('SCRIPT_LIMIT_EXCEEDED', 'Script output exceeded its limit.'));
      else stdout += bytes.toString('utf8');
    });
    child.stderr!.on('data', (bytes: Buffer) => {
      errorBytes += bytes.length; if (errorBytes > SCRIPT_LOG_BYTES) stop(new SkillScriptError('SCRIPT_LIMIT_EXCEEDED', 'Script output exceeded its limit.'));
      else stderr += bytes.toString('utf8');
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(argumentsFrame);
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', () => { running = false; killGroup(); reject(new SkillScriptError('SCRIPT_SANDBOX_UNAVAILABLE', 'The required script isolation is unavailable.', 503)); });
        child.once('exit', () => {
          if (bridge.inFlight && !terminated) stop(new SkillScriptError('SCRIPT_EXECUTION_FAILED', 'The script exited during a tool request.'));
          running = false;
          killGroup();
        });
        child.once('close', code => resolve(code));
      });
      await bridge.drain();
    } finally {
      running = false; clearTimeout(timeout); if (watchTimer) clearTimeout(watchTimer);
      input.signal?.removeEventListener('abort', abort); bridge.close(); killGroup();
    }
    if (failure) throw failure;
    if (exitCode === 126 && stderr.includes('SKILL_SCRIPT_SANDBOX_UNAVAILABLE')) throw new SkillScriptError('SCRIPT_SANDBOX_UNAVAILABLE', 'The required script isolation is unavailable.', 503);
    await revalidate();
    await assertAgentRuntimeTempQuota(parent);
    return { exitCode, stdout, stderr, scratchDirectory: scratch, sandboxMode, terminated };
  } catch (error) {
    await cleanup();
    if (isSkillScriptError(error)) throw error;
    if (error instanceof SkillScriptProtocolError) throw new SkillScriptError('SCRIPT_PROTOCOL_INVALID', 'The script tool bridge protocol is invalid.');
    throw new SkillScriptError('SCRIPT_EXECUTION_FAILED', 'The script could not complete.');
  } finally { releaseLease(); }
}
