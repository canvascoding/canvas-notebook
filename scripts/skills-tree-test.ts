import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSkillTree } from '../app/lib/skills/skill-tree';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-tree-'));

  try {
    await writeFile(path.join(root, 'registry.json'), '{"version":1}\n');
    await writeFile(path.join(root, 'registry.json.tmp'), '{"version":1}\n');
    await writeFile(path.join(root, 'README.md'), '# Skills\n');
    await writeFile(path.join(root, 'alpha', 'SKILL.md'), '# Alpha\n');
    await writeFile(path.join(root, 'alpha', '.agents', 'canvas.yaml'), 'interface: {}\n');
    await writeFile(path.join(root, 'beta', 'SKILL.md'), '# Beta\n');
    await writeFile(path.join(root, 'bin', 'alpha'), 'legacy command\n');
    await writeFile(path.join(root, '_shared', 'helpers.js'), 'export {};\n');
    await writeFile(path.join(root, 'legacy-assets', 'notes.md'), '# Not a skill\n');

    const tree = await buildSkillTree(root, { maxDepth: 4 });
    const rootNames = tree.map((node) => node.name);

    assert.deepEqual(rootNames, ['alpha', 'beta']);
    assert.equal(tree[0].path, 'alpha');
    assert.equal(tree[0].children?.some((node) => node.name === '.agents'), true);

    console.log('skills tree test passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
