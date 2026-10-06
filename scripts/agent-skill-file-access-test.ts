import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-skill-access-'));
  const dataRoot = path.join(tempRoot, 'data');
  const environment = { DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_ORGANIZATION_ID: 'organization-one',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', BASE_URL: 'http://localhost:3001', CANVAS_MCP_DIRECT_ENABLED: 'false' };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const database = await createPiTestDatabase();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, parent, mainModule) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    return originalLoad(name, parent, mainModule);
  };

  try {
    const workspaceRoot = path.join(dataRoot, 'workspaces', 'personal', 'user-one', 'files');
    const raw = await database.openDb();
    for (const id of ['user-one', 'user-two']) await raw.run(
      `INSERT INTO "user" (id,name,email,email_verified,role,created_at,updated_at) VALUES ($1,$1,$2,1,'user',1,1)`, [id, `${id}@skill-access.example.test`]);
    for (const [id, owner, created] of [['organization-one', 'user-one', 1], ['organization-two', 'user-two', 2]]) {
      await raw.run(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
        VALUES ($1,$2,'team',1,$3,$3)`, [id, owner, created]);
      await raw.run(`INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at)
        VALUES ($1,$2,'owner','active',1,1,1)`, [id, owner]);
    }
    await raw.run(`INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,is_default,created_at,updated_at)
      VALUES ('workspace-one','organization-one','personal','user-one','workspaces/personal/user-one/files','Personal Workspace','active',1,1,1)`);
    const packageRoot = path.join(tempRoot, 'package');
    await fs.mkdir(path.join(packageRoot, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(packageRoot, 'skills', 'excalidraw-diagram', 'scripts'), { recursive: true });
    const originalSkillContent = '---\nname: excalidraw-diagram\ndescription: Diagram fixture\n---\n\n# Excalidraw Diagram\n';
    await fs.writeFile(path.join(packageRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name: 'document-suite', version: '1.3.0', description: 'Diagram fixture', skills: 'skills' }));
    await fs.writeFile(path.join(packageRoot, 'skills', 'excalidraw-diagram', 'SKILL.md'), originalSkillContent);
    await fs.writeFile(path.join(packageRoot, 'skills', 'excalidraw-diagram', 'scripts', 'validate.mjs'), 'export default true;\n');
    const { installCanvasPluginFromPath } = await import('../app/lib/plugins/canvas-plugin-registry');
    const installed = await installCanvasPluginFromPath(packageRoot, { scope: { scopeType: 'organization', organizationId: 'organization-one' }, enable: true });
    const foreign = await installCanvasPluginFromPath(packageRoot, { scope: { scopeType: 'organization', organizationId: 'organization-two' }, enable: true });
    assert(installed.success && installed.plugin && foreign.success && foreign.plugin);
    const effectiveSkillRoot = installed.plugin.skills[0].directory;
    const foreignSkillRoot = foreign.plugin.skills[0].directory;
    const skillFilePath = path.join(effectiveSkillRoot, 'SKILL.md');
    const skillScriptPath = path.join(effectiveSkillRoot, 'scripts', 'validate.mjs');
    const foreignSkillPath = path.join(foreignSkillRoot, 'SKILL.md');
    const escapedSkillPath = path.join(effectiveSkillRoot, 'foreign-skill.md');

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(foreignSkillPath, '# Foreign Skill\n');
    await fs.symlink(foreignSkillPath, escapedSkillPath);
    const { DEFAULT_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
    const { getAgentProfile } = await import('../app/lib/agents/registry');
    await getAgentProfile(DEFAULT_MANAGED_AGENT_ID);
    await raw.run(`INSERT INTO pi_sessions (session_id,user_id,agent_id,workspace_id,workspace_type,organization_id,workspace_root_relative_path,provider,model,created_at,updated_at)
      VALUES ('session-one','user-one',$1,'workspace-one','personal','organization-one','workspaces/personal/user-one/files','fixture','fixture',1,1)`, [DEFAULT_MANAGED_AGENT_ID]);
    const { setCapabilityPreference } = await import('../app/lib/capabilities/preference-store');
    await setCapabilityPreference({ userId: 'user-one', resourceId: installed.plugin.resourceId!, enabled: true, expectedRevision: 0 });
    const { resolveAgentExecutionContextForSession } = await import('../app/lib/pi/session-workspace-context');
    const resolved = await resolveAgentExecutionContextForSession({ userId: 'user-one', sessionId: 'session-one', agentId: DEFAULT_MANAGED_AGENT_ID });
    assert(resolved.skillReadRoots?.includes(effectiveSkillRoot), 'The real installed and activated plugin must issue this read root.');
    assert.equal(resolved.workspaceRoot, workspaceRoot);
    const executionContext: AgentExecutionContext = { ...resolved, skillReadRoots: [effectiveSkillRoot] };
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const {
      assertAgentPathAllowed,
      writeAgentTextFile,
    } = await import('../app/lib/pi/agent-file-operations');

    await runWithAgentExecutionContext(executionContext, async () => {
      await assert.doesNotReject(() => assertAgentPathAllowed(skillFilePath));
      await assert.doesNotReject(() => assertAgentPathAllowed(skillScriptPath));
      await assert.rejects(
        () => assertAgentPathAllowed(foreignSkillPath),
        /limited to the workspace bound to this chat session/,
      );
      await assert.rejects(
        () => assertAgentPathAllowed(escapedSkillPath),
        /limited to the workspace bound to this chat session/,
      );
      await assert.rejects(
        () => writeAgentTextFile({ path: skillFilePath, content: '# Mutated Skill\n' }),
        /mutations are limited to the workspace bound/,
      );
    });
    assert.equal(await fs.readFile(skillFilePath, 'utf8'), originalSkillContent);

    await runWithAgentExecutionContext({ ...executionContext, skillReadRoots: [] }, async () => {
      await assert.rejects(
        () => assertAgentPathAllowed(skillFilePath),
        /limited to the workspace bound to this chat session/,
      );
    });

    const personalSkillRoot = path.join(dataRoot, 'users', 'user-one', 'skills', 'personal-doc');
    const foreignPersonalSkillRoot = path.join(dataRoot, 'users', 'user-two', 'skills', 'foreign-doc');
    const personalSkillPath = path.join(personalSkillRoot, 'SKILL.md');
    const foreignPersonalSkillPath = path.join(foreignPersonalSkillRoot, 'SKILL.md');
    await fs.mkdir(path.join(dataRoot, 'users', 'user-one', 'settings'), { recursive: true });
    await fs.mkdir(foreignPersonalSkillRoot, { recursive: true });
    const { importSkillPackage } = await import('../app/lib/skills/skill-package-import');
    const personalInstallation = await importSkillPackage({ kind: 'text', sourceName: 'file-access-fixture', content: [
      '---',
      'name: personal-doc',
      'description: "Personal document workflow"',
      'metadata:',
      '  version: "1.0.0"',
      '---',
      '',
      '# Personal Document',
    ].join('\n') }, { scope: { userId: 'user-one' }, updatedBy: 'user-one', enable: true });
    assert.equal(personalInstallation.path, personalSkillPath);
    await fs.writeFile(foreignPersonalSkillPath, [
      '---',
      'name: foreign-doc',
      'description: "Foreign document workflow"',
      '---',
      '',
      '# Foreign Document',
    ].join('\n'));
    await fs.writeFile(
      path.join(dataRoot, 'users', 'user-one', 'settings', 'skills.json'),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        enabledSkills: ['personal-doc'],
      }),
    );
    const personalEscapePath = path.join(personalSkillRoot, 'foreign-link.md');
    await fs.symlink(foreignPersonalSkillPath, personalEscapePath);

    const { addEffectiveSkillReadRoots } = await import('../app/lib/pi/session-workspace-context');
    const personalContext = await addEffectiveSkillReadRoots({
      ...executionContext,
      skillReadRoots: [],
    });
    assert.ok(personalContext.skillReadRoots?.includes(personalSkillRoot));
    assert.equal(personalContext.skillReadRoots?.includes(foreignPersonalSkillRoot), false);
    await runWithAgentExecutionContext(personalContext, async () => {
      await assert.doesNotReject(() => assertAgentPathAllowed(personalSkillPath));
      await assert.rejects(
        () => assertAgentPathAllowed(foreignPersonalSkillPath),
        /limited to the workspace bound to this chat session/,
      );
      await assert.rejects(
        () => assertAgentPathAllowed(personalEscapePath),
        /limited to the workspace bound to this chat session/,
      );
    });

    console.log('agent-skill-file-access-test: ok');
  } finally {
    loader._load = originalLoad;
    await database.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
