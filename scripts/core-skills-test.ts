import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-core-skills-'));
  process.env.CANVAS_DATA_ROOT = path.join(tempRoot, 'data');

  try {
    const [
      { CORE_SKILL_NAMES, isCoreSkillName },
      { DISABLED_ALL_SKILLS_SENTINEL, disableSkillInConfig, resolveEnabledSkillNames },
      { createSkillDirectory, deleteSkillDirectory, loadSkillByName, loadSkillsFromDisk },
    ] = await Promise.all([
      import('../app/lib/skills/core-skills'),
      import('../app/lib/skills/enabled-skills'),
      import('../app/lib/skills/skill-loader'),
    ]);

    assert.deepEqual([...CORE_SKILL_NAMES].sort(), [
      'create-plugin',
      'find-skills',
      'skill-creator',
    ]);
    assert.equal(isCoreSkillName('skill-creator'), true);
    assert.equal(isCoreSkillName('pdf'), false);

    const scope = { userId: 'core-skill-test-user' };
    const skills = await loadSkillsFromDisk([DISABLED_ALL_SKILLS_SENTINEL], scope);
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    for (const skillName of CORE_SKILL_NAMES) {
      const skill = byName.get(skillName);
      assert.equal(Boolean(skill), true, `core skill missing from runtime: ${skillName}`);
      assert.equal(skill?.enabled, true, `core skill should stay enabled: ${skillName}`);
      assert.equal(skill?.core, true, `core flag missing: ${skillName}`);
      assert.match(skill?.path || '', /seed_skills/);

      const loaded = await loadSkillByName(skillName, scope);
      assert.equal(loaded?.core, true, `loadSkillByName should resolve bundled core skill: ${skillName}`);
    }

    const allSkillNames = skills.map((skill) => skill.name);
    const enabledWithSentinel = resolveEnabledSkillNames(allSkillNames, [DISABLED_ALL_SKILLS_SENTINEL]);
    for (const skillName of CORE_SKILL_NAMES) {
      assert.equal(enabledWithSentinel.has(skillName), true, `sentinel should not disable core skill: ${skillName}`);
    }

    const afterCoreDisable = disableSkillInConfig('skill-creator', [], allSkillNames);
    const enabledAfterCoreDisable = resolveEnabledSkillNames(allSkillNames, afterCoreDisable);
    assert.equal(enabledAfterCoreDisable.has('skill-creator'), true, 'core skill disable config should be ignored');

    const createResult = await createSkillDirectory('skill-creator', 'Shadow core skill', '', scope);
    assert.equal(createResult.success, false);
    assert.match(createResult.error || '', /core skill/i);

    const deleteResult = await deleteSkillDirectory('skill-creator', scope);
    assert.equal(deleteResult.success, false);
    assert.match(deleteResult.error || '', /core skill/i);

    console.log('core skills test passed');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
