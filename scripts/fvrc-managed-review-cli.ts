import { promises as fs } from 'node:fs';
import path from 'node:path';

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

async function main(): Promise<void> {
  const baseURL = process.env.BASE_URL!;
  const localBuildMarker = (await fs.readFile(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')).trim();
  const environment = { ...process.env, AUTH_ORIGIN: process.env.AUTH_ORIGIN || baseURL, FVRC_BUILD_MARKER: localBuildMarker };
  const commands = parseCommands(process.env.FVRC_REVIEW_COMMANDS_JSON);
  const browser = await chromium.launch();
  try {
    const context = await createAuthenticatedContext(browser, { baseURL });
    try {
      const records = await runManagedReviewSuite({
        commands,
        environment,
        report: (message) => console.log(message),
        preflight: async () => {
          const healthResponse = await context.request.get('/api/health');
          if (!healthResponse.ok()) throw new Error(`Managed review preflight health check failed (${healthResponse.status()}).`);
          const health = await healthResponse.json() as HealthPayload;
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
