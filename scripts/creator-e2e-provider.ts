import fs from 'node:fs/promises';
import path from 'node:path';
import { CREATOR_COMPANY_DOMAIN, CREATOR_HUBSPOT_TOOL, CREATOR_CANVA_TOOL,
  CREATOR_RESEARCH_TOOL, CREATOR_SOURCE_TOOL, startCreatorE2eProviderFixture } from './helpers/creator-e2e-provider-fixture';

async function main() {
  if (process.argv.length !== 2) throw new Error('Creator provider runner accepts no arguments.');
  const directory = await fs.mkdtemp(path.join('/tmp', 'canvas-creator-e2e-'));
  await fs.chmod(directory, 0o700);
  const statePath = path.join(directory, 'provider.json');
  const fixture = await startCreatorE2eProviderFixture();
  let stopped = false;
  let writes = Promise.resolve();
  const save = () => {
    const value = JSON.stringify({ schemaVersion: 1, controlledFixture: true, pid: process.pid, stopped,
      baseUrl: fixture.baseUrl, composioBaseUrl: fixture.baseUrl, mcpUrl: fixture.mcpUrl,
      statusUrl: fixture.statusUrl, controlUrl: fixture.controlUrl, nonce: fixture.nonce,
      companyDomain: CREATOR_COMPANY_DOMAIN,
      tools: { hubspot: CREATOR_HUBSPOT_TOOL, canva: CREATOR_CANVA_TOOL, mcp: [CREATOR_RESEARCH_TOOL, CREATOR_SOURCE_TOOL] },
      status: fixture.status() }, null, 2) + '\n';
    writes = writes.then(async () => {
      const temporaryPath = `${statePath}.tmp`;
      await fs.writeFile(temporaryPath, value, { mode: 0o600 });
      await fs.rename(temporaryPath, statePath);
    });
    return writes;
  };
  await save();
  process.stdout.write(JSON.stringify({ statePath, baseUrl: fixture.baseUrl, mcpUrl: fixture.mcpUrl }) + '\n');
  const interval = setInterval(() => { void save().catch(() => shutdown(1)); }, 2_000);
  let shutdownStarted = false;
  const shutdown = (code: number) => {
    if (shutdownStarted) return;
    shutdownStarted = true; stopped = true; clearInterval(interval);
    void fixture.close().then(save).then(() => process.exit(code), () => process.exit(1));
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
}

void main().catch(() => { process.stderr.write('Controlled Creator provider could not start.\n'); process.exitCode = 1; });
