import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type ManagedReviewCommand = {
  name: string;
  executable: string;
  args: readonly string[];
};

export type ManagedReviewExecution = {
  exitCode: number;
  output: string;
};

export type ManagedReviewRunRecord = {
  command: string;
  pass: 1 | 2;
  status: 'passed';
};

export type ManagedReviewRunnerOptions = {
  commands: readonly ManagedReviewCommand[];
  environment: NodeJS.ProcessEnv;
  preflight: () => Promise<{ serverMarker?: string } | void>;
  prepareExecution?: (command: ManagedReviewCommand, pass: 1 | 2) => Promise<void>;
  execute?: (command: ManagedReviewCommand, environment: NodeJS.ProcessEnv) => Promise<ManagedReviewExecution>;
  report?: (message: string) => void;
};

const FAILURE_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  { code: 'LOGIN_RATE_LIMITED', pattern: /(?:http(?: status)?\s*)?429|too many requests|login rate.?limit(?:ed|ing)/iu },
  { code: 'MANDATORY_TEST_SKIPPED', pattern: /\b(?:[1-9]\d*)\s+skipped\b|\bskipped\s+(?:[1-9]\d*)\b/iu },
];

function validateCommand(command: ManagedReviewCommand): void {
  if (!command.name.trim() || !command.executable.trim()) throw new Error('Managed review command name and executable are required.');
  if (command.args.some((argument) => argument.includes('\0'))) throw new Error(`Managed review command ${command.name} contains an invalid argument.`);
  const workerArguments = command.args.filter((argument) => argument === '--workers=1' || argument.startsWith('--workers='));
  if (workerArguments.length !== 1 || workerArguments[0] !== '--workers=1') {
    throw new Error(`Managed review command ${command.name} must use exactly --workers=1.`);
  }
}

function validateEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.E2E_EXTERNAL_SERVER !== '1') throw new Error('Managed review runner requires E2E_EXTERNAL_SERVER=1.');
  for (const key of ['BASE_URL', 'AUTH_ORIGIN', 'DATA', 'DATABASE_URL', 'FVRC_FIXTURE_ID', 'FVRC_WORKSPACE_ID', 'FVRC_BUILD_MARKER']) {
    if (!environment[key]?.trim()) throw new Error(`Managed review runner requires ${key}.`);
  }
  for (const key of ['BASE_URL', 'AUTH_ORIGIN']) {
    let value: URL;
    try { value = new URL(environment[key]!); } catch { throw new Error(`Managed review runner requires a valid ${key}.`); }
    if (!['http:', 'https:'].includes(value.protocol)) throw new Error(`Managed review runner requires ${key} to use http or https.`);
  }
  let database: URL;
  try { database = new URL(environment.DATABASE_URL!); } catch { throw new Error('Managed review runner requires a valid DATABASE_URL.'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('Managed review runner requires PostgreSQL.');
}

async function executeWithoutShell(command: ManagedReviewCommand, environment: NodeJS.ProcessEnv): Promise<ManagedReviewExecution> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 2_000_000) output = output.slice(-2_000_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

function assertExecutionPassed(command: ManagedReviewCommand, pass: 1 | 2, execution: ManagedReviewExecution): void {
  const outputTail = execution.output
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .trim()
    .slice(-6_000);
  const withOutput = (message: string) => new Error(outputTail ? `${message}\n--- Playwright output tail ---\n${outputTail}` : message);
  if (execution.exitCode !== 0) throw withOutput(`Managed review ${command.name} failed on pass ${pass} (exit ${execution.exitCode}).`);
  for (const failure of FAILURE_PATTERNS) {
    if (failure.pattern.test(execution.output)) throw withOutput(`Managed review ${command.name} failed gate ${failure.code} on pass ${pass}.`);
  }
}

async function assertPreflightPassed(options: ManagedReviewRunnerOptions): Promise<void> {
  const preflight = await options.preflight();
  if (preflight?.serverMarker && preflight.serverMarker !== options.environment.FVRC_BUILD_MARKER) {
    throw new Error('Managed review runner detected a local/server build identity mismatch.');
  }
}

export async function runManagedReviewSuite(options: ManagedReviewRunnerOptions): Promise<ManagedReviewRunRecord[]> {
  validateEnvironment(options.environment);
  if (options.commands.length === 0) throw new Error('Managed review runner requires at least one command.');
  options.commands.forEach(validateCommand);
  await fs.access(path.resolve(options.environment.DATA!));
  await assertPreflightPassed(options);
  const execute = options.execute ?? executeWithoutShell;
  const records: ManagedReviewRunRecord[] = [];
  for (const pass of [1, 2] as const) {
    for (const command of options.commands) {
      options.report?.(`FVRC managed review: ${command.name}, pass ${pass}/2`);
      if (options.prepareExecution) {
        await options.prepareExecution(command, pass);
        await assertPreflightPassed(options);
      }
      const execution = await execute(command, options.environment);
      assertExecutionPassed(command, pass, execution);
      records.push({ command: command.name, pass, status: 'passed' });
    }
  }
  return records;
}
