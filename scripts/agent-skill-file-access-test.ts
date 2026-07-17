import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-skill-access-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;

  try {
    const workspaceRoot = path.join(dataRoot, 'workspaces', 'personal', 'user-one', 'files');
    const effectiveSkillRoot = path.join(
      dataRoot,
      'organizations',
      'organization-one',
      'plugins',
      'installed',
      'document-suite',
      '1.2.0',
      'skills',
      'excalidraw-diagram',
    );
    const foreignSkillRoot = path.join(
      dataRoot,
      'organizations',
      'organization-two',
      'plugins',
      'installed',
      'document-suite',
      '1.2.0',
      'skills',
      'excalidraw-diagram',
    );
    const skillFilePath = path.join(effectiveSkillRoot, 'SKILL.md');
    const skillScriptPath = path.join(effectiveSkillRoot, 'scripts', 'validate.mjs');
    const foreignSkillPath = path.join(foreignSkillRoot, 'SKILL.md');
    const escapedSkillPath = path.join(effectiveSkillRoot, 'foreign-skill.md');

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(path.dirname(skillScriptPath), { recursive: true });
    await fs.mkdir(foreignSkillRoot, { recursive: true });
    await fs.writeFile(skillFilePath, '# Excalidraw Diagram\n');
    await fs.writeFile(skillScriptPath, 'export default true;\n');
    await fs.writeFile(foreignSkillPath, '# Foreign Skill\n');
    await fs.symlink(foreignSkillPath, escapedSkillPath);

    const executionContext: AgentExecutionContext = {
      userId: 'user-one',
      sessionId: 'session-one',
      agentId: 'canvas-agent',
      workspaceId: 'workspace-one',
      workspaceType: 'personal',
      workspaceName: 'Personal Workspace',
      workspaceDescription: null,
      organizationId: 'organization-one',
      customerId: null,
      projectId: null,
      workspaceRoot,
      workspaceRootRelativePath: null,
      skillReadRoots: [effectiveSkillRoot],
      canWrite: true,
      canDelete: true,
      canShare: false,
      legacy: false,
    };
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
    assert.equal(await fs.readFile(skillFilePath, 'utf8'), '# Excalidraw Diagram\n');

    await runWithAgentExecutionContext({ ...executionContext, skillReadRoots: [] }, async () => {
      await assert.rejects(
        () => assertAgentPathAllowed(skillFilePath),
        /limited to the workspace bound to this chat session/,
      );
    });

    console.log('agent-skill-file-access-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
