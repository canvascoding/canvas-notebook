import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-memory-'));
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.DATA = dataDir;

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };

  try {
    const {
      addMemory,
      deleteMemory,
      readMemory,
      updateMemory,
    } = await import('../app/lib/agents/memory-store');

    const empty = await readMemory({ target: 'agent', agentId: 'research-agent' });
    assert.equal(empty.agentId, 'research-agent');
    assert.equal(empty.fileName, 'MEMORY.md');
    assert.deepEqual(empty.entries, []);

    const added = await addMemory({
      target: 'agent',
      agentId: 'research-agent',
      content: 'User prefers concise implementation notes.',
    });
    assert.equal(added.changed, true);
    assert.equal(added.entries.length, 1);
    assert.match(added.entry?.id || '', /^mem_/);
    assert.equal(added.entry?.content, 'User prefers concise implementation notes.');

    const agentMemoryPath = path.join(dataDir, 'agents', 'research-agent', 'MEMORY.md');
    assert.match(await fs.readFile(agentMemoryPath, 'utf8'), /User prefers concise implementation notes/);

    const duplicate = await addMemory({
      target: 'agent',
      agentId: 'research-agent',
      content: 'User prefers concise implementation notes.',
    });
    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.entries.length, 1);

    const updated = await updateMemory({
      target: 'agent',
      agentId: 'research-agent',
      id: added.entry!.id,
      content: 'User prefers concise implementation notes with file references.',
    });
    assert.equal(updated.changed, true);
    assert.equal(updated.entries[0].content, 'User prefers concise implementation notes with file references.');

    const userAdded = await addMemory({
      target: 'user',
      agentId: 'research-agent',
      content: 'User timezone is Europe/Berlin.',
    });
    assert.equal(userAdded.agentId, 'canvas-agent');
    assert.equal(userAdded.fileName, 'USER.md');
    assert.match(
      await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', 'USER.md'), 'utf8'),
      /Europe\/Berlin/,
    );

    const scopedAgentAdded = await addMemory({
      target: 'agent',
      agentId: 'research-agent',
      userId: 'user_a',
      content: 'Scoped agent memory belongs to user A.',
    });
    assert.equal(scopedAgentAdded.changed, true);
    assert.equal(scopedAgentAdded.agentId, 'research-agent');
    assert.match(
      await fs.readFile(path.join(dataDir, 'users', 'user_a', 'agents', 'research-agent', 'MEMORY.md'), 'utf8'),
      /Scoped agent memory belongs to user A/,
    );
    assert.doesNotMatch(await fs.readFile(agentMemoryPath, 'utf8'), /Scoped agent memory belongs to user A/);

    const scopedOtherUser = await readMemory({
      target: 'agent',
      agentId: 'research-agent',
      userId: 'user_b',
    });
    assert.deepEqual(scopedOtherUser.entries, []);

    const scopedUserAdded = await addMemory({
      target: 'user',
      agentId: 'research-agent',
      userId: 'user_a',
      content: 'Scoped user memory belongs to user A.',
    });
    assert.equal(scopedUserAdded.agentId, 'canvas-agent');
    assert.match(
      await fs.readFile(path.join(dataDir, 'users', 'user_a', 'agents', 'canvas-agent', 'USER.md'), 'utf8'),
      /Scoped user memory belongs to user A/,
    );
    assert.doesNotMatch(
      await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', 'USER.md'), 'utf8'),
      /Scoped user memory belongs to user A/,
    );

    await assert.rejects(
      () => addMemory({
        target: 'user',
        content: 'OPENAI_API_KEY=sk-testtesttesttesttesttest',
      }),
      /secret or credential/,
    );

    const deleted = await deleteMemory({
      target: 'agent',
      agentId: 'research-agent',
      id: added.entry!.id,
    });
    assert.equal(deleted.changed, true);
    assert.deepEqual(deleted.entries, []);

    await fs.rm(path.join(dataDir, 'agents', 'canvas-agent', 'MEMORY.md'), { force: true });
    await fs.mkdir(path.join(dataDir, 'canvas-agent'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'canvas-agent', 'MEMORY.md'), 'Legacy canvas memory.\n', 'utf8');
    const migrated = await readMemory({ target: 'agent', agentId: 'canvas-agent' });
    assert.match(migrated.content, /Legacy canvas memory/);
    assert.match(
      await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', 'MEMORY.md'), 'utf8'),
      /Legacy canvas memory/,
    );

    console.log('agent-memory-store-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
