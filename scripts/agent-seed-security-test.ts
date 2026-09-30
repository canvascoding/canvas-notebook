import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentManagedFileName } from '../app/lib/agents/storage';

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-seed-security-'));
  const previousDataRoot = process.env.CANVAS_DATA_ROOT;
  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    const { resetManagedAgentFile } = await import('../app/lib/agents/storage');
    const scope = { userId: 'seed-security-fixture' };
    const seed = await fs.readFile(path.join(process.cwd(), 'seed_sys_prompts', 'SOUL.md'), 'utf8');
    assert.equal((await resetManagedAgentFile('SOUL.md', undefined, scope)).trim(), seed.trim());
    for (const invalid of ['../../outside.txt', '/etc/passwd', 'SOUL.md/../TOOLS.md', 'OTHER.md']) {
      await assert.rejects(() => resetManagedAgentFile(
        invalid as AgentManagedFileName, undefined, scope,
      ));
    }
    await assert.rejects(() => resetManagedAgentFile('SOUL.md', '../../outside', scope));
    console.log('agent seed security test passed');
  } finally {
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
