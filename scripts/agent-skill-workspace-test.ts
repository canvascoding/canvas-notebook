import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') {
    return {};
  }
  if (request === '@earendil-works/pi-ai') {
    return {
      completeSimple: async () => {
        throw new Error('pi-ai should not be called by the agent skill workspace test.');
      },
      streamSimple: async function* () {
        throw new Error('pi-ai should not be streamed by the agent skill workspace test.');
      },
      getModels: () => [],
      getProviders: () => [],
      isContextOverflow: () => false,
      registerBuiltInApiProviders: () => undefined,
    };
  }
  if (request === '@earendil-works/pi-ai/oauth') {
    return {};
  }
  return originalLoad(request, parent, isMain);
};

async function pathExists(targetPath: string): Promise<boolean> {
  return fs.stat(targetPath).then(() => true).catch(() => false);
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-skill-data-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-skill-workspace-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;

  try {
    const {
      createCanvasSkillDraft,
      discardCanvasSkillDraft,
      inspectCanvasSkillForAgent,
      installCanvasSkillFromWorkspace,
      updateCanvasSkillFromWorkspace,
    } = await import('../app/lib/skills/agent-skill-workspace');
    const {
      readCanvasSkillRegistry,
      writeCanvasSkillRegistry,
    } = await import('../app/lib/skills/canvas-skill-store');
    const { computeCanvasPluginChecksum } = await import('../app/lib/plugins/canvas-plugin-registry');

    const scope = { userId: 'agent-skill-user' };
    const createdDraft = await createCanvasSkillDraft({
      workspaceRoot,
      scope,
      skillName: 'agent-draft-skill',
      description: 'Temporary skill created by the agent skill workspace test.',
      version: '1.0.0',
    });
    assert.equal(createdDraft.packagePath.startsWith('.canvas-skill-drafts/'), true);
    assert.equal(await pathExists(path.join(workspaceRoot, createdDraft.packagePath, 'SKILL.md')), true);

    const install = await installCanvasSkillFromWorkspace({
      workspaceRoot,
      scope,
      draftPath: createdDraft.packagePath,
      updatedBy: 'agent-skill-user',
    });
    assert.equal(install.name, 'agent-draft-skill');
    assert.equal(install.version, '1.0.0');
    assert.equal(install.draftCleaned, true);
    assert.equal(await pathExists(path.join(workspaceRoot, createdDraft.draftPath)), false);

    let registry = await readCanvasSkillRegistry(scope);
    assert.equal(registry.skills['agent-draft-skill'].version, '1.0.0');

    const inspection = await inspectCanvasSkillForAgent({
      scope,
      skillName: 'agent-draft-skill',
    });
    assert.equal(inspection.editable, true);
    assert.equal(inspection.version, '1.0.0');
    assert.match(inspection.checksum || '', /^[a-f0-9]{64}$/);
    assert.equal(inspection.files?.some((file) => file.path === 'SKILL.md'), true);

    const editDraft = await createCanvasSkillDraft({
      workspaceRoot,
      scope,
      skillName: 'agent-draft-skill',
      sourceSkillName: 'agent-draft-skill',
    });
    assert.equal(editDraft.expectedVersion, '1.0.0');
    assert.equal(editDraft.expectedChecksum, inspection.checksum);

    const editPackageRoot = path.join(workspaceRoot, editDraft.packagePath);
    await fs.writeFile(
      path.join(editPackageRoot, 'agents', 'canvas.yaml'),
      [
        'skill:',
        '  version: "1.1.0"',
        'interface:',
        '  display_name: Agent Draft Skill',
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.mkdir(path.join(editPackageRoot, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(editPackageRoot, 'scripts', 'helper.js'), 'export const ok = true;\n', 'utf-8');
    await fs.appendFile(path.join(editPackageRoot, 'SKILL.md'), '\nUpdated instructions.\n', 'utf-8');

    await assert.rejects(
      updateCanvasSkillFromWorkspace({
        workspaceRoot,
        scope,
        skillName: 'agent-draft-skill',
        draftPath: editDraft.packagePath,
        expectedVersion: '9.9.9',
        expectedChecksum: inspection.checksum || '',
      }),
      /Skill version changed since inspection/,
    );
    assert.equal(await pathExists(path.join(workspaceRoot, editDraft.packagePath)), true);

    const update = await updateCanvasSkillFromWorkspace({
      workspaceRoot,
      scope,
      skillName: 'agent-draft-skill',
      draftPath: editDraft.packagePath,
      expectedVersion: inspection.version || '',
      expectedChecksum: inspection.checksum || '',
      updatedBy: 'agent-skill-user',
    });
    assert.equal(update.previousVersion, '1.0.0');
    assert.equal(update.version, '1.1.0');
    assert.equal(update.draftCleaned, true);
    assert.equal(await pathExists(path.join(workspaceRoot, editDraft.draftPath)), false);

    registry = await readCanvasSkillRegistry(scope);
    const installed = registry.skills['agent-draft-skill'];
    assert.equal(installed.version, '1.1.0');
    assert.equal(await pathExists(path.join(path.dirname(installed.skillPath), 'scripts', 'helper.js')), true);

    const sourceBeforeFork = await inspectCanvasSkillForAgent({
      scope,
      skillName: 'agent-draft-skill',
    });
    const forkDraft = await createCanvasSkillDraft({
      workspaceRoot,
      scope,
      skillName: 'agent-draft-skill-fork',
      sourceSkillName: 'agent-draft-skill',
    });
    assert.equal(forkDraft.sourceSkillName, 'agent-draft-skill');
    const forkSkillContent = await fs.readFile(
      path.join(workspaceRoot, forkDraft.packagePath, 'SKILL.md'),
      'utf-8',
    );
    assert.match(forkSkillContent, /^---\nname: agent-draft-skill-fork\n/m);
    const forkInstall = await installCanvasSkillFromWorkspace({
      workspaceRoot,
      scope,
      draftPath: forkDraft.packagePath,
      updatedBy: 'agent-skill-user',
    });
    assert.equal(forkInstall.name, 'agent-draft-skill-fork');
    assert.equal(
      (await inspectCanvasSkillForAgent({ scope, skillName: 'agent-draft-skill' })).checksum,
      sourceBeforeFork.checksum,
    );

    const organizationId = 'agent-skill-organization';
    const organizationScope = { scopeType: 'organization' as const, organizationId };
    const organizationSkillDir = path.join(
      dataRoot,
      'organizations',
      organizationId,
      'skills',
      'installed',
      'organization-writing',
      '2.0.0',
    );
    await fs.mkdir(path.join(organizationSkillDir, 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(organizationSkillDir, 'SKILL.md'),
      [
        '---',
        'name: organization-writing',
        'description: Organization-owned writing instructions.',
        '---',
        '',
        '# Organization Writing',
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(organizationSkillDir, 'agents', 'canvas.yaml'),
      'skill:\n  version: "2.0.0"\n',
      'utf-8',
    );
    const organizationChecksum = await computeCanvasPluginChecksum(organizationSkillDir);
    await writeCanvasSkillRegistry({
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        'organization-writing': {
          name: 'organization-writing',
          version: '2.0.0',
          description: 'Organization-owned writing instructions.',
          sourceType: 'local',
          sourcePath: 'admin-upload:test',
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          checksum: organizationChecksum,
          installDir: organizationSkillDir,
          skillPath: path.join(organizationSkillDir, 'SKILL.md'),
        },
      },
    }, organizationScope);

    const migratedOrganizationRegistry = await readCanvasSkillRegistry(organizationScope);
    const migratedOrganizationRecord = migratedOrganizationRegistry.skills['organization-writing'];
    assert.equal(
      migratedOrganizationRecord.installDir,
      path.join(organizationSkillDir, 'organization-writing'),
    );
    assert.equal(
      migratedOrganizationRecord.skillPath,
      path.join(organizationSkillDir, 'organization-writing', 'SKILL.md'),
    );
    assert.equal(await fs.stat(migratedOrganizationRecord.skillPath).then((stat) => stat.isFile()), true);
    assert.equal(await fs.stat(path.join(organizationSkillDir, 'SKILL.md')).then(() => true).catch(() => false), false);

    const organizationAgentScope = { userId: scope.userId, organizationId };
    const organizationInspection = await inspectCanvasSkillForAgent({
      scope: organizationAgentScope,
      sourceScope: 'organization',
      skillName: 'organization-writing',
    });
    assert.equal(organizationInspection.scope, 'organization');
    assert.equal(organizationInspection.editable, false);
    assert.equal(organizationInspection.forkable, true);
    assert.equal(organizationInspection.version, '2.0.0');
    await assert.rejects(
      createCanvasSkillDraft({
        workspaceRoot,
        scope: organizationAgentScope,
        skillName: 'organization-writing',
        sourceSkillName: 'organization-writing',
        sourceScope: 'organization',
      }),
      /Organization skills are read-only/,
    );
    const organizationForkDraft = await createCanvasSkillDraft({
      workspaceRoot,
      scope: organizationAgentScope,
      skillName: 'personal-organization-writing',
      sourceSkillName: 'organization-writing',
      sourceScope: 'organization',
    });
    assert.equal(organizationForkDraft.forked, true);
    assert.equal(organizationForkDraft.sourceScope, 'organization');
    const organizationForkInstall = await installCanvasSkillFromWorkspace({
      workspaceRoot,
      scope: organizationAgentScope,
      draftPath: organizationForkDraft.packagePath,
      updatedBy: scope.userId,
    });
    assert.equal(organizationForkInstall.name, 'personal-organization-writing');
    assert.equal(
      (await readCanvasSkillRegistry(organizationScope)).skills['organization-writing'].checksum,
      organizationChecksum,
    );

    const secretDraft = await createCanvasSkillDraft({
      workspaceRoot,
      scope,
      skillName: 'secret-draft-skill',
      version: '1.0.0',
    });
    await fs.writeFile(
      path.join(workspaceRoot, secretDraft.packagePath, '.env'),
      'EXAMPLE_SECRET=must-not-be-imported\n',
      'utf-8',
    );
    await assert.rejects(
      installCanvasSkillFromWorkspace({
        workspaceRoot,
        scope,
        draftPath: secretDraft.packagePath,
      }),
      /blocked secret-bearing file: \.env/,
    );
    assert.equal(await pathExists(path.join(workspaceRoot, secretDraft.packagePath)), true);

    const discardDraft = await createCanvasSkillDraft({
      workspaceRoot,
      scope,
      skillName: 'discard-draft-skill',
      version: '1.0.0',
    });
    await fs.rm(path.join(workspaceRoot, discardDraft.packagePath, 'SKILL.md'));
    const discard = await discardCanvasSkillDraft({
      workspaceRoot,
      draftPath: discardDraft.packagePath,
    });
    assert.equal(discard.deleted, true);
    assert.equal(await pathExists(path.join(workspaceRoot, discardDraft.draftPath)), false);

    const symlinkDraft = await createCanvasSkillDraft({
      workspaceRoot,
      scope,
      skillName: 'symlink-draft-skill',
      version: '1.0.0',
    });
    await fs.symlink('/tmp', path.join(workspaceRoot, symlinkDraft.packagePath, 'outside-link'));
    await assert.rejects(
      installCanvasSkillFromWorkspace({
        workspaceRoot,
        scope,
        draftPath: symlinkDraft.packagePath,
      }),
      /symbolic links/,
    );

    console.log('agent skill workspace test passed');
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
