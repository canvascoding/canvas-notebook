import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { chromium } from '@playwright/test';

import { createAuthenticatedContext, runManagedTestPreflight } from '../tests/helpers/managed-test-context';
import { runManagedReviewSuite, type ManagedReviewCommand } from './fvrc-managed-review-runner';

type HealthPayload = {
  status?: string;
  checks?: { db?: string };
  database?: { provider?: string };
  deployment?: { teamFeaturesEnabled?: boolean };
};

function parseCommands(value: string | undefined): ManagedReviewCommand[] {
  if (!value) throw new Error('FVRC_REVIEW_COMMANDS_JSON is required.');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('FVRC_REVIEW_COMMANDS_JSON must be valid JSON.'); }
  if (!Array.isArray(parsed)) throw new Error('FVRC_REVIEW_COMMANDS_JSON must be an array.');
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Review command ${index} is invalid.`);
    const candidate = entry as Partial<ManagedReviewCommand>;
    if (typeof candidate.name !== 'string' || typeof candidate.executable !== 'string' || !Array.isArray(candidate.args) || !candidate.args.every((arg) => typeof arg === 'string')) {
      throw new Error(`Review command ${index} is invalid.`);
    }
    return { name: candidate.name, executable: candidate.executable, args: candidate.args };
  });
}

function parseResetCommand(value: string | undefined): ManagedReviewCommand | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('FVRC_REVIEW_RESET_COMMAND_JSON must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('FVRC_REVIEW_RESET_COMMAND_JSON must be an object.');
  const candidate = parsed as Partial<ManagedReviewCommand>;
  if (typeof candidate.name !== 'string' || typeof candidate.executable !== 'string' || !Array.isArray(candidate.args) || !candidate.args.every((arg) => typeof arg === 'string')) {
    throw new Error('FVRC_REVIEW_RESET_COMMAND_JSON is invalid.');
  }
  if (!candidate.name.trim() || !candidate.executable.trim() || candidate.args.some((argument) => argument.includes('\0'))) {
    throw new Error('FVRC_REVIEW_RESET_COMMAND_JSON is invalid.');
  }
  return { name: candidate.name, executable: candidate.executable, args: candidate.args };
}

async function executeResetCommand(command: ManagedReviewCommand, environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Managed review reset ${command.name} failed (exit ${code ?? 1}).`));
    });
  });
}

async function waitForHealthyTeamDeployment(context: Awaited<ReturnType<typeof createAuthenticatedContext>>): Promise<HealthPayload> {
  const deadline = Date.now() + 90_000;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await context.request.get('/api/health', { timeout: 5_000 });
      lastStatus = response.status();
      if (response.ok()) return await response.json() as HealthPayload;
    } catch {
      // A recreated runtime may briefly refuse connections while the health endpoint starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Managed review preflight health check failed${lastStatus ? ` (${lastStatus})` : ''}.`);
}

async function main(): Promise<void> {
  const baseURL = process.env.BASE_URL!;
  const localBuildMarker = (await fs.readFile(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')).trim();
  const environment = { ...process.env, AUTH_ORIGIN: process.env.AUTH_ORIGIN || baseURL, FVRC_BUILD_MARKER: localBuildMarker };
  const commands = parseCommands(process.env.FVRC_REVIEW_COMMANDS_JSON);
  const resetCommand = parseResetCommand(process.env.FVRC_REVIEW_RESET_COMMAND_JSON);
  const browser = await chromium.launch();
  try {
    const context = await createAuthenticatedContext(browser, { baseURL });
    try {
      const records = await runManagedReviewSuite({
        commands,
        environment,
        report: (message) => console.log(message),
        prepareExecution: resetCommand ? async () => {
          console.log(`FVRC managed review: ${resetCommand.name}`);
          await executeResetCommand(resetCommand, environment);
        } : undefined,
        preflight: async () => {
          const health = await waitForHealthyTeamDeployment(context);
          if (health.status !== 'healthy' || health.checks?.db !== 'ok' || health.database?.provider !== 'postgres' || health.deployment?.teamFeaturesEnabled !== true) {
            throw new Error('Managed review preflight requires a healthy PostgreSQL Team deployment.');
          }
          await runManagedTestPreflight(context, {
            baseURL,
            authOrigin: process.env.AUTH_ORIGIN,
            workspaceId: process.env.FVRC_WORKSPACE_ID,
            requireWorkspacePermission: 'write',
            fixtureIdentity: process.env.FVRC_FIXTURE_ID,
            buildMarker: localBuildMarker,
          });
          const buildResponse = await context.request.get(`/_next/static/${encodeURIComponent(localBuildMarker)}/_buildManifest.js`);
          if (!buildResponse.ok()) throw new Error('Managed review preflight detected a local/server build identity mismatch.');
          return { serverMarker: localBuildMarker };
        },
      });
      console.log(`FVRC managed review completed: ${records.length} serial suite runs passed.`);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Managed review runner failed.');
  process.exitCode = 1;
});
