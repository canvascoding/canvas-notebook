import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function envValue(content: string, key: string): string | null {
  const line = content.split(/\r?\n/u).find((candidate) => candidate.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).replace(/^"|"$/gu, '') : null;
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-legacy-secret-migration-'));
  const previousData = process.env.DATA;
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const previousIntegrationsPath = process.env.INTEGRATIONS_ENV_PATH;
  const previousAgentsPath = process.env.AGENTS_ENV_PATH;

  try {
    process.env.DATA = dataRoot;
    delete process.env.CANVAS_DATA_ROOT;
    delete process.env.INTEGRATIONS_ENV_PATH;
    delete process.env.AGENTS_ENV_PATH;

    await fs.mkdir(path.join(dataRoot, 'secrets'), { recursive: true });
    await fs.mkdir(path.join(dataRoot, 'users', 'owner-user', 'secrets'), { recursive: true });
    await fs.writeFile(
      path.join(dataRoot, 'secrets', 'Canvas-Integrations.env'),
      'OPENAI_API_KEY=legacy-openai\nGEMINI_API_KEY=legacy-gemini\nMULTILINE_KEY="line1\tline2"\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(dataRoot, 'secrets', 'Canvas-Agents.env'),
      'ANTHROPIC_API_KEY=legacy-anthropic\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(dataRoot, 'users', 'owner-user', 'secrets', 'Canvas-Integrations.env'),
      'OPENAI_API_KEY=user-openai\n',
      'utf8',
    );

    const { migrateLegacySecretsToUserScope } = await import('../app/lib/integrations/legacy-secret-migration');
    const result = migrateLegacySecretsToUserScope('owner-user');
    assert.equal(result.status, 'migrated');
    assert.equal(result.migratedFiles.length, 2);

    const migratedIntegrations = await fs.readFile(
      path.join(dataRoot, 'users', 'owner-user', 'secrets', 'Canvas-Integrations.env'),
      'utf8',
    );
    const migratedAgents = await fs.readFile(
      path.join(dataRoot, 'users', 'owner-user', 'secrets', 'Canvas-Agents.env'),
      'utf8',
    );

    assert.equal(envValue(migratedIntegrations, 'OPENAI_API_KEY'), 'user-openai');
    assert.equal(envValue(migratedIntegrations, 'GEMINI_API_KEY'), 'legacy-gemini');
    assert.equal(envValue(migratedIntegrations, 'MULTILINE_KEY'), 'line1\\tline2');
    assert.equal(envValue(migratedAgents, 'ANTHROPIC_API_KEY'), 'legacy-anthropic');

    const secondRun = migrateLegacySecretsToUserScope('owner-user');
    assert.equal(secondRun.status, 'skipped');
    assert.equal(secondRun.reason, 'already_migrated');

    console.log('legacy-secret-migration-test: ok');
  } finally {
    if (previousData === undefined) {
      delete process.env.DATA;
    } else {
      process.env.DATA = previousData;
    }
    if (previousCanvasDataRoot === undefined) {
      delete process.env.CANVAS_DATA_ROOT;
    } else {
      process.env.CANVAS_DATA_ROOT = previousCanvasDataRoot;
    }
    if (previousIntegrationsPath === undefined) {
      delete process.env.INTEGRATIONS_ENV_PATH;
    } else {
      process.env.INTEGRATIONS_ENV_PATH = previousIntegrationsPath;
    }
    if (previousAgentsPath === undefined) {
      delete process.env.AGENTS_ENV_PATH;
    } else {
      process.env.AGENTS_ENV_PATH = previousAgentsPath;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
