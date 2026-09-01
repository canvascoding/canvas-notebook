import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CapabilityCandidate, CapabilityReference } from '../app/lib/capabilities/types';
import { loadCapabilitySkillByReference } from '../app/lib/skills/skill-documentation';

function skillReference(
  resourceId: string,
  scopeType: CapabilityReference['scopeType'],
): CapabilityReference {
  return {
    resourceType: 'skill',
    scopeType,
    resourceId,
    name: 'xlsx',
    version: '1.0.0',
    revision: 1,
    checksum: `${resourceId}-checksum`,
    sourceType: scopeType === 'organization' ? 'plugin' : 'standalone',
    organizationId: scopeType === 'organization' ? 'organization-one' : null,
    ownerUserId: scopeType === 'user' ? 'user-one' : null,
    sourcePluginId: scopeType === 'organization' ? 'document-suite-resource' : null,
  };
}

async function writeSkill(root: string, directory: string, marker: string): Promise<string> {
  const skillPath = path.join(root, directory, 'xlsx', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, `---
name: xlsx
description: "Spreadsheet documentation fixture."
---

# XLSX

${marker}
`, 'utf8');
  return skillPath;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-documentation-'));

  try {
    const personalPath = await writeSkill(root, 'personal-xlsx', 'Personal documentation');
    const organizationPath = await writeSkill(root, 'organization-xlsx', 'Organization plugin documentation');
    const candidates: CapabilityCandidate[] = [
      {
        ref: skillReference('personal-xlsx-resource', 'user'),
        description: 'Personal spreadsheet skill',
        enabled: true,
        runtimePath: personalPath,
      },
      {
        ref: skillReference('organization-xlsx-resource', 'organization'),
        description: 'Organization spreadsheet skill',
        enabled: true,
        runtimePath: organizationPath,
        pluginResourceId: 'document-suite-resource',
      },
    ];

    const organizationSkill = await loadCapabilitySkillByReference(candidates, {
      name: 'xlsx',
      resourceId: 'organization-xlsx-resource',
    });
    assert.match(organizationSkill?.content || '', /Organization plugin documentation/);

    const personalSkill = await loadCapabilitySkillByReference(candidates, {
      name: 'xlsx',
      resourceId: 'personal-xlsx-resource',
    });
    assert.match(personalSkill?.content || '', /Personal documentation/);

    assert.equal(await loadCapabilitySkillByReference(candidates, {
      name: 'pdf',
      resourceId: 'organization-xlsx-resource',
    }), null);
    assert.equal(await loadCapabilitySkillByReference(candidates, {
      name: 'xlsx',
      resourceId: 'missing-resource',
    }), null);

    console.log('skill documentation resolution test passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
