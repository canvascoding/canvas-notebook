import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only' || request === '@earendil-works/pi-ai/oauth' || request === '@earendil-works/pi-agent-core') return {};
  if (request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-plugin-data-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-plugin-workspace-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  const scope = { userId: 'agent-plugin-user' };

  try {
    const {
      createCanvasPluginDraft,
      inspectCanvasPluginForAgent,
      installCanvasPluginFromWorkspace,
      removeCanvasPluginForAgent,
      setCanvasPluginEnabledForAgent,
      updateCanvasPluginFromWorkspace,
    } = await import('../app/lib/plugins/agent-plugin-workspace');

    const draft = await createCanvasPluginDraft({
      workspaceRoot,
      pluginName: 'agent-plugin-test',
      description: 'Exercises the Bradley plugin lifecycle.',
      draftId: 'lifecycle',
    });
    assert.equal(draft.packagePath, '.canvas-plugin-drafts/lifecycle/agent-plugin-test');
    const extraSkillRoot = path.join(workspaceRoot, draft.packagePath, 'skills', 'agent-plugin-test-extra');
    await fs.mkdir(path.join(extraSkillRoot, 'agents'), { recursive: true });
    await fs.writeFile(path.join(extraSkillRoot, 'SKILL.md'), [
      '---',
      'name: agent-plugin-test-extra',
      'description: "Second skill used to verify plugin updates remove obsolete materialized skills."',
      'metadata:',
      '  version: "1.0.0"',
      '---',
      '',
      '# Agent Plugin Test Extra',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(extraSkillRoot, 'agents', 'canvas.yaml'), 'skill:\n  version: "1.0.0"\n', 'utf8');

    const installed = await installCanvasPluginFromWorkspace({
      workspaceRoot,
      workspacePath: draft.packagePath,
      scope,
      enable: true,
      updatedBy: scope.userId,
    });
    assert.equal(installed.name, 'agent-plugin-test');
    assert.equal(installed.enabled, true);
    assert.deepEqual(installed.skills, ['agent-plugin-test-extra', 'agent-plugin-test']);

    const inspection = await inspectCanvasPluginForAgent({ pluginName: installed.name, scope });
    assert.equal(inspection.installed, true);
    assert.equal(inspection.checksum, installed.checksum);

    await fs.rm(extraSkillRoot, { recursive: true, force: true });
    const updated = await updateCanvasPluginFromWorkspace({
      workspaceRoot,
      workspacePath: draft.packagePath,
      pluginName: installed.name,
      expectedVersion: inspection.version || '',
      expectedChecksum: inspection.checksum || '',
      scope,
      enable: false,
      updatedBy: scope.userId,
    });
    assert.equal(updated.enabled, false);
    assert.equal(updated.previousChecksum, installed.checksum);
    await assert.rejects(fs.stat(path.join(dataRoot, 'users', scope.userId, 'skills', 'agent-plugin-test-extra', 'SKILL.md')));

    const enabled = await setCanvasPluginEnabledForAgent({
      pluginName: installed.name,
      enabled: true,
      scope,
      updatedBy: scope.userId,
    });
    assert.equal(enabled.enabled, true);

    await removeCanvasPluginForAgent({ pluginName: installed.name, scope, updatedBy: scope.userId });
    const removedInspection = await inspectCanvasPluginForAgent({ pluginName: installed.name, scope });
    assert.equal(removedInspection.installed, false);

    console.log('agent-plugin-workspace-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(dataRoot, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
