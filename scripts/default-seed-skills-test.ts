import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_BOOTSTRAP_SEED_SKILL_NAMES,
  parseBootstrapSeedSkillNames,
} from '../app/lib/skills/default-seed-skills';

async function main() {
  assert.deepEqual([...DEFAULT_BOOTSTRAP_SEED_SKILL_NAMES].sort(), [
    'create-plugin',
    'find-skills',
    'frontend-slides',
    'marp-slides',
    'skill-creator',
  ]);

  const defaultSet = parseBootstrapSeedSkillNames();
  assert.equal(defaultSet.has('create-plugin'), true);
  assert.equal(defaultSet.has('frontend-slides'), true);
  assert.equal(defaultSet.has('marp-slides'), true);
  assert.equal(defaultSet.has('pdf'), false);
  assert.equal(defaultSet.has('docx'), false);
  assert.equal(defaultSet.has('youtube-transcript'), false);

  const customSet = parseBootstrapSeedSkillNames('pdf, qmd, docx');
  assert.deepEqual([...customSet].sort(), ['docx', 'pdf', 'qmd']);

  for (const skillName of DEFAULT_BOOTSTRAP_SEED_SKILL_NAMES) {
    const skillPath = path.join(process.cwd(), 'seed_skills', skillName, 'SKILL.md');
    const stat = await fs.stat(skillPath).catch(() => null);
    assert.equal(Boolean(stat?.isFile()), true, `Default seed skill is missing SKILL.md: ${skillName}`);
  }

  console.log('default seed skills test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
