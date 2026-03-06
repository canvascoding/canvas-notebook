import { promises as fs } from 'node:fs';
import path from 'node:path';

import { db } from '../app/lib/db';
import { aiMessages, aiSessions } from '../app/lib/db/schema';

const AGENT_STORAGE_DIR = '/home/node/canvas-agent';
const DEFAULT_INTEGRATIONS_ENV_PATH = '/home/node/canvas-integrations.env';
const LEGACY_WIPE_MARKER_PATH = path.join(AGENT_STORAGE_DIR, '.legacy-session-wipe-done');
const RUNTIME_CONFIG_PATH = path.join(AGENT_STORAGE_DIR, 'agent-runtime-config.json');
const MANAGED_FILE_TEMPLATES: Record<string, string> = {
  'AGENTS.md': `# AGENTS

- Main agent: canvas-main-agent
- Scope: Canvas Notebook runtime behavior and guardrails
`,
  'MEMORY.md': `# MEMORY

- Persistent notes and long-lived decisions for the main agent.
`,
  'SOUL.md': `# SOUL

- Tone and interaction style for the main agent in Canvas Notebook.
`,
  'TOOLS.md': `# TOOLS

- Preferred tools and execution constraints for the main agent.
`,
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getIntegrationsEnvPath(): string {
  const configured = process.env.INTEGRATIONS_ENV_PATH?.trim();
  return configured || DEFAULT_INTEGRATIONS_ENV_PATH;
}

async function ensureIntegrationsEnvBootstrap(): Promise<void> {
  const integrationsEnvPath = getIntegrationsEnvPath();
  await fs.mkdir(path.dirname(integrationsEnvPath), { recursive: true });

  try {
    const handle = await fs.open(integrationsEnvPath, 'wx', 0o600);
    await handle.close();
    await fs.chmod(integrationsEnvPath, 0o600);
    console.log(`[bootstrap-agent-runtime] Created integrations env file: ${integrationsEnvPath}.`);
    return;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'EEXIST') {
        await fs.chmod(integrationsEnvPath, 0o600).catch(() => undefined);
        console.log(`[bootstrap-agent-runtime] Integrations env file exists: ${integrationsEnvPath} (preserved).`);
        return;
      }

      if (error.code === 'EISDIR') {
        console.warn(`[bootstrap-agent-runtime] WARNING: integrations env path is a directory: ${integrationsEnvPath}.`);
        return;
      }
    }

    throw error;
  }
}

function buildDefaultConfig() {
  return {
    version: 1,
    mainAgent: 'canvas-main-agent',
    provider: {
      id: 'codex-cli',
      kind: 'cli',
    },
    providers: {
      'codex-cli': {
        enabled: true,
        command: 'codex',
      },
      'claude-cli': {
        enabled: true,
        command: 'claude',
      },
      openrouter: {
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-4.5',
        apiKeySource: 'integrations-env',
      },
      ollama: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3.2:3b',
        apiKeySource: 'integrations-env',
      },
    },
    doctor: {
      enableLivePing: true,
      timeoutMs: 2500,
    },
    updatedAt: new Date().toISOString(),
    updatedBy: 'system:bootstrap',
  };
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  await fs.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(payload, null, 2));
}

async function ensureAgentStorageBootstrap(): Promise<void> {
  await fs.mkdir(AGENT_STORAGE_DIR, { recursive: true });

  for (const [fileName, template] of Object.entries(MANAGED_FILE_TEMPLATES)) {
    const targetPath = path.join(AGENT_STORAGE_DIR, fileName);
    if (await fileExists(targetPath)) {
      continue;
    }
    await writeTextAtomic(targetPath, template);
  }

  if (!(await fileExists(RUNTIME_CONFIG_PATH))) {
    await writeJsonAtomic(RUNTIME_CONFIG_PATH, buildDefaultConfig());
  }
}

async function runLegacySessionCleanupIfNeeded(): Promise<void> {
  if (await fileExists(LEGACY_WIPE_MARKER_PATH)) {
    console.log(`[bootstrap-agent-runtime] Legacy wipe skipped (marker exists: ${LEGACY_WIPE_MARKER_PATH}).`);
    return;
  }

  const deletedMessages = await db.delete(aiMessages).returning({ id: aiMessages.id });
  const deletedSessions = await db.delete(aiSessions).returning({ id: aiSessions.id });

  const markerContent = {
    doneAt: new Date().toISOString(),
    deleted: {
      aiMessages: deletedMessages.length,
      aiSessions: deletedSessions.length,
    },
  };

  await fs.writeFile(LEGACY_WIPE_MARKER_PATH, `${JSON.stringify(markerContent, null, 2)}\n`, 'utf8');

  console.log(
    `[bootstrap-agent-runtime] Legacy wipe done (messages=${deletedMessages.length}, sessions=${deletedSessions.length}).`,
  );
}

async function main() {
  await ensureIntegrationsEnvBootstrap();
  await ensureAgentStorageBootstrap();
  await runLegacySessionCleanupIfNeeded();

  console.log('[bootstrap-agent-runtime] Agent runtime bootstrap complete.');
}

main().catch((error) => {
  console.error('[bootstrap-agent-runtime] Failed:', error);
  process.exit(1);
});
