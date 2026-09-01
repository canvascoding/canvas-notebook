import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isValidAgentSkillName,
  parseFrontmatter,
  parseSkillFile,
  validateFrontmatter,
} from '../app/lib/skills/canvas-skill-manifest';

function manifest(overrides: Record<string, unknown> = {}): string {
  const values: Record<string, unknown> = {
    name: 'example-skill',
    description: 'Use this when <structured> input needs careful handling.',
    ...overrides,
  };
  const fields = Object.entries(values).map(([key, value]) => {
    if (typeof value === 'string') return `${key}: ${JSON.stringify(value)}`;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value).map(([childKey, childValue]) => `  ${childKey}: ${JSON.stringify(childValue)}`);
      return `${key}:\n${entries.join('\n')}`;
    }
    return `${key}: ${JSON.stringify(value)}`;
  });
  return `---\n${fields.join('\n')}\n---\n\n# Example\n`;
}

function validationFor(overrides: Record<string, unknown> = {}, expectedDirectoryName?: string) {
  const { frontmatter } = parseFrontmatter(manifest(overrides));
  return validateFrontmatter(frontmatter, { expectedDirectoryName });
}

function assertInvalid(overrides: Record<string, unknown>, expectedError: RegExp): void {
  const result = validationFor(overrides);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), expectedError);
}

async function main(): Promise<void> {
  assert.equal(isValidAgentSkillName('example-skill'), true);
  assert.equal(isValidAgentSkillName('überblick-2'), true);
  assert.equal(isValidAgentSkillName('double--hyphen'), false);
  assert.equal(isValidAgentSkillName(' example-skill '), false);
  assert.equal(validationFor({}, 'example-skill').valid, true);
  assert.equal(validationFor({
    name: 'überblick-2',
    license: 'Apache-2.0',
    compatibility: 'Requires Python 3.11 or newer.',
    'allowed-tools': 'Read Grep',
    metadata: { version: '1.0.0', author: 'Canvas' },
  }, 'überblick-2').valid, true);

  assertInvalid({ name: 'double--hyphen' }, /consecutive hyphens/);
  assertInvalid({ name: 'Uppercase' }, /lowercase/);
  assertInvalid({ name: '-leading' }, /start or end/);
  assertInvalid({ name: 'trailing-' }, /start or end/);
  assertInvalid({ name: 'bad_name' }, /Only letters, numbers, and hyphens/);
  assertInvalid({ name: 'a'.repeat(65) }, /Maximum is 64/);
  assertInvalid({ description: '' }, /description: Must be a non-empty string/);
  assertInvalid({ description: 'a'.repeat(1025) }, /Maximum is 1024/);
  assertInvalid({ compatibility: ' ' }, /compatibility: Must not be empty/);
  assertInvalid({ compatibility: 'a'.repeat(501) }, /Maximum is 500/);
  assertInvalid({ compatibility: 3 }, /compatibility: Must be a string/);
  assertInvalid({ license: false }, /license: Must be a string/);
  assertInvalid({ 'allowed-tools': ['Read'] }, /allowed-tools: Must be a string/);
  assertInvalid({ metadata: 'version=1' }, /metadata: Must be a key-value mapping/);
  assertInvalid({ metadata: { version: 1 } }, /metadata: Value for key "version" must be a string/);
  assertInvalid({ unexpected: true }, /Unexpected fields in frontmatter: unexpected/);

  const mismatch = validationFor({}, 'different-directory');
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.errors.join('\n'), /Directory name "different-directory" must match/);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-skills-spec-'));
  try {
    const matchingDir = path.join(tempRoot, 'example-skill');
    await fs.mkdir(matchingDir, { recursive: true });
    await fs.writeFile(path.join(matchingDir, 'SKILL.md'), manifest(), 'utf8');
    const parsed = await parseSkillFile(path.join(matchingDir, 'SKILL.md'), { validateDirectoryName: true });
    assert.equal(parsed?.name, 'example-skill');
    assert.match(parsed?.description ?? '', /<structured>/);

    const mismatchingDir = path.join(tempRoot, 'wrong-directory');
    await fs.mkdir(mismatchingDir, { recursive: true });
    await fs.writeFile(path.join(mismatchingDir, 'SKILL.md'), manifest(), 'utf8');
    assert.equal(
      await parseSkillFile(path.join(mismatchingDir, 'SKILL.md'), { validateDirectoryName: true }),
      null,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('Agent Skills manifest conformance tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
