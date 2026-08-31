import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const validatorPath = path.join(process.cwd(), 'seed_skills', 'skill-creator', 'scripts', 'quick_validate.py');

function skillMarkdown(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: Use <structured> input when this skill applies.\n${extra}---\n\n# Test\n`;
}

async function validate(root: string, directory: string, content: string): Promise<SpawnSyncReturns<string>> {
  const skillDir = path.join(root, directory);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  return spawnSync(process.env.CANVAS_PYTHON_PATH || 'python3', [validatorPath, skillDir], {
    encoding: 'utf8',
  });
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-creator-validator-'));
  try {
    const valid = await validate(root, 'überblick-2', skillMarkdown('überblick-2', [
      'license: Apache-2.0',
      'compatibility: Requires Python 3.',
      'allowed-tools: Read Grep',
      'metadata:',
      '  version: "1.0"',
      '',
    ].join('\n')));
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);

    const consecutive = await validate(root, 'double--hyphen', skillMarkdown('double--hyphen'));
    assert.notEqual(consecutive.status, 0);
    assert.match(consecutive.stdout, /consecutive hyphens/);

    const mismatch = await validate(root, 'wrong-directory', skillMarkdown('right-directory'));
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stdout, /must match skill name/);

    const unknown = await validate(root, 'unknown-field', skillMarkdown('unknown-field', 'custom: true\n'));
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stdout, /Unexpected key/);

    const numericMetadata = await validate(root, 'numeric-metadata', skillMarkdown(
      'numeric-metadata',
      'metadata:\n  version: 1\n',
    ));
    assert.notEqual(numericMetadata.status, 0);
    assert.match(numericMetadata.stdout, /Metadata keys and values must be strings/);

    console.log('skill creator validator test passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
