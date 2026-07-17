import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CapabilityCandidate, CapabilityReference } from '../app/lib/capabilities/types';
import {
  CapabilitySkillFileError,
  buildCapabilitySkillTree,
  resolveCapabilitySkillFile,
  selectBrowsableSkillCandidates,
} from '../app/lib/skills/capability-skill-browser';

function candidate(
  resourceId: string,
  name: string,
  scopeType: CapabilityReference['scopeType'],
  runtimePath: string,
): CapabilityCandidate {
  return {
    ref: {
      resourceType: 'skill',
      resourceId,
      name,
      scopeType,
      sourceType: scopeType === 'organization' ? 'plugin' : 'standalone',
      version: '1.0.0',
      revision: 1,
      checksum: `${resourceId}-checksum`,
      organizationId: scopeType === 'organization' ? 'organization-one' : null,
      ownerUserId: scopeType === 'user' ? 'user-one' : null,
      sourcePluginId: scopeType === 'organization' ? 'plugin-one' : null,
    },
    description: `${name} fixture`,
    enabled: true,
    runtimePath,
  };
}

async function writeSkill(root: string, directory: string, name: string): Promise<string> {
  const skillRoot = path.join(root, directory);
  await fs.mkdir(path.join(skillRoot, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\n\n# ${name}\n`, 'utf8');
  await fs.writeFile(path.join(skillRoot, 'scripts', 'helper.ts'), 'export const helper = true;\n', 'utf8');
  return path.join(skillRoot, 'SKILL.md');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-capability-skill-browser-'));
  try {
    const personal = candidate('personal-skill-resource', 'personal-skill', 'user', await writeSkill(root, 'personal', 'personal-skill'));
    const organization = candidate('organization-skill-resource', 'organization-skill', 'organization', await writeSkill(root, 'organization', 'organization-skill'));
    const candidates = [personal, organization];

    assert.deepEqual(selectBrowsableSkillCandidates(candidates, 'organization'), [organization]);
    assert.deepEqual(selectBrowsableSkillCandidates(candidates, 'user'), candidates);

    const tree = await buildCapabilitySkillTree(candidates);
    assert.equal(tree.length, 2);
    const organizationTree = tree.find((node) => node.resourceId === organization.ref.resourceId);
    assert.equal(organizationTree?.name, 'organization-skill');
    assert.equal(organizationTree?.relativePath, '');
    const skillFile = organizationTree?.children?.find((node) => node.name === 'SKILL.md');
    assert.equal(skillFile?.relativePath, 'SKILL.md');
    assert.equal(skillFile?.path, 'organization-skill-resource/SKILL.md');
    const scriptsDirectory = organizationTree?.children?.find((node) => node.name === 'scripts');
    assert.equal(scriptsDirectory?.children?.[0]?.relativePath, 'scripts/helper.ts');

    const resolved = await resolveCapabilitySkillFile(candidates, {
      resourceId: organization.ref.resourceId,
      relativePath: 'SKILL.md',
    });
    assert.match(await fs.readFile(resolved.filePath, 'utf8'), /# organization-skill/u);

    await assert.rejects(
      resolveCapabilitySkillFile(candidates, {
        resourceId: organization.ref.resourceId,
        relativePath: '../personal/SKILL.md',
      }),
      (error: unknown) => error instanceof CapabilitySkillFileError && error.status === 400,
    );
    await assert.rejects(
      resolveCapabilitySkillFile(candidates, {
        resourceId: 'missing-resource',
        relativePath: 'SKILL.md',
      }),
      (error: unknown) => error instanceof CapabilitySkillFileError && error.status === 404,
    );

    const panelSource = await fs.readFile(path.join(process.cwd(), 'app/components/settings/SkillsPanel.tsx'), 'utf8');
    assert.match(panelSource, /capabilityScopeUrl\('\/api\/skills\/tree\?depth=4', requestedScope\)/u);
    assert.match(panelSource, /if \(node\.resourceId\) params\.set\('resourceId', node\.resourceId\)/u);
    assert.doesNotMatch(panelSource, /setSkillTree\(merged\.map/u);
    assert.doesNotMatch(panelSource, /managementScope === 'user' \? skills\s*\.filter\(\(skill\) => skill\.scopeType === 'organization'\)/u);

    console.log('capability-skill-browser-test: ok');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
