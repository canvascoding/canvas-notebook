import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';

import type { AgentSkillDraftResult, AgentSkillInspection } from '../app/lib/skills/agent-skill-workspace';
import { createPiTestDatabase } from './helpers/pi-test-database';

function text(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content
    .filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function details<T>(result: unknown): T {
  const value = (result as { details: T & { error?: string } }).details;
  assert.equal(value.error, undefined, text(result));
  return value;
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-gateway-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  process.env.DATA = path.join(tempRoot, 'data');
  process.env.CANVAS_DATA_ROOT = process.env.DATA;
  process.env.QMD_ENABLED = 'false';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://127.0.0.1:3000';
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = internals._load;
  const refreshes: string[] = [];
  let permissionAllowed = true;
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only' || request === '@earendil-works/pi-agent-core' || request === '@earendil-works/pi-ai/oauth') return {};
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return database;
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return {
        getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined,
        isContextOverflow: () => false,
        completeSimple: async () => { throw new Error('No model calls are permitted in this test.'); },
      };
    }
    if (request === '@/app/lib/organization/permissions') {
      return {
        assertUserOrganizationPermission: async () => {
          if (!permissionAllowed) throw new Error('Plugin and skill sharing permission required.');
        },
      };
    }
    if (request === '@/app/lib/pi/live-runtime' || request.endsWith('/pi/live-runtime.ts')) {
      return { requestPiRuntimePromptRefreshForUser: async (userId: string) => { refreshes.push(userId); } };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    await fs.mkdir(workspaceRoot, { recursive: true });
    const { user, piSessions } = await import('../app/lib/db/schema');
    const userId = 'skill-gateway-user';
    const otherUserId = 'skill-gateway-other';
    const now = new Date();
    for (const id of [userId, otherUserId]) {
      await database.db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: false, createdAt: now, updatedAt: now });
      await database.db.insert(piSessions).values({
        sessionId: `session-${id}`, userId: id, provider: 'test', model: 'test',
        createdAt: now, updatedAt: now, systemPromptSnapshot: 'original prompt',
        systemPromptSnapshotHash: 'original hash', systemPromptSnapshotCreatedAt: now,
      });
    }
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { createUserScopedTools } = await import('../app/lib/pi/scoped-tools');
    const { createProgressiveGatewayTool, PROGRESSIVE_GATEWAY_DEFINITIONS } = await import('../app/lib/pi/progressive-tool-gateway');
    const definition = PROGRESSIVE_GATEWAY_DEFINITIONS.find((entry) => entry.name === 'canvas_extensions');
    assert.ok(definition);
    const gateway = createProgressiveGatewayTool(definition, createUserScopedTools(userId, 'test-worker', 'test-session', { accountLocale: 'en' }));
    const context = {
      userId, sessionId: 'test-session', agentId: 'test-worker', workspaceId: 'test-workspace',
      workspaceType: 'personal' as const, workspaceName: 'Test', organizationId: null,
      customerId: null, projectId: null, workspaceRoot, workspaceRootRelativePath: null,
      canWrite: true, canDelete: true, canShare: true, legacy: false,
    };
    const call = (operation: string, args: Record<string, unknown>) => runWithAgentExecutionContext(context,
      () => gateway.execute(operation, { action: 'call', operation, arguments: args }));
    const snapshot = async (id = userId) => (await database.db.select().from(piSessions).where(eq(piSessions.userId, id)))[0];
    const resetSnapshot = () => database.db.update(piSessions).set({ systemPromptSnapshot: 'original prompt',
      systemPromptSnapshotHash: 'original hash', systemPromptSnapshotCreatedAt: now }).where(eq(piSessions.userId, userId));

    const search = await gateway.execute('search', { action: 'search', query: 'skill' });
    assert.match(text(search), /create_canvas_skill_draft/);
    const description = await gateway.execute('describe', { action: 'describe', operation: 'update_canvas_skill_from_workspace' });
    assert.match(text(description), /expectedChecksum/);
    const wrongSchema = await call('inspect_canvas_skill', { name: 'gateway-skill' });
    assert.match(text(wrongSchema), /Invalid arguments/);
    const missing = await call('inspect_canvas_skill', { skillName: 'gateway-skill' });
    assert.equal(details<AgentSkillInspection>(missing).forkable, false);
    assert.match(text(missing), /No draft action/);

    const created = await call('create_canvas_skill_draft', { skillName: 'gateway-skill', description: 'Gateway test.' });
    const draft = details<AgentSkillDraftResult>(created);
    assert.match(text(created), /Next:.*install_canvas_skill_from_workspace/);
    assert.deepEqual(refreshes, []);
    assert.equal((await snapshot()).systemPromptSnapshot, 'original prompt');
    const packageRoot = path.join(workspaceRoot, draft.packagePath);
    // SKILL.md alone is a complete package when its metadata supplies a version.
    await fs.rm(path.join(packageRoot, 'agents'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'SKILL.md'), '---\nname: gateway-skill\ndescription: Gateway test.\nmetadata:\n  version: "1.0.0"\n---\n\n# Gateway\n');
    const installed = await call('install_canvas_skill_from_workspace', { draftPath: draft.packagePath });
    const install = details<{ success: boolean; path: string; draftCleaned: boolean }>(installed);
    assert.equal(install.success, true);
    assert.equal(install.draftCleaned, true);
    assert.deepEqual(refreshes, [userId]);
    assert.equal((await snapshot()).systemPromptSnapshot, null);
    assert.equal((await snapshot()).systemPromptSnapshotHash, null);
    assert.equal((await snapshot()).systemPromptSnapshotCreatedAt, null);
    assert.equal((await snapshot(otherUserId)).systemPromptSnapshot, 'original prompt');

    await resetSnapshot();
    const inspection = details<AgentSkillInspection>(await call('inspect_canvas_skill', { skillName: 'gateway-skill' }));
    const editing = await call('create_canvas_skill_draft', { skillName: 'gateway-skill', sourceSkillName: 'gateway-skill' });
    const edit = details<AgentSkillDraftResult>(editing);
    assert.match(text(editing), /Next:.*update_canvas_skill_from_workspace/);
    assert.equal(edit.expectedChecksum, inspection.checksum);
    const editPath = path.join(workspaceRoot, edit.packagePath, 'SKILL.md');
    const original = await fs.readFile(install.path, 'utf8');
    const updateArgs = { skillName: 'gateway-skill', draftPath: edit.packagePath,
      expectedVersion: edit.expectedVersion, expectedChecksum: edit.expectedChecksum };
    const stale = await call('update_canvas_skill_from_workspace', { ...updateArgs, expectedChecksum: '0'.repeat(64) });
    assert.match(text(stale), /checksum changed/);
    await fs.writeFile(editPath, original.replace('name: gateway-skill\n', ''));
    const invalid = await call('update_canvas_skill_from_workspace', updateArgs);
    assert.match(text(invalid), /Missing required field: name/);
    assert.equal(await fs.readFile(install.path, 'utf8'), original);
    assert.equal((await snapshot()).systemPromptSnapshot, 'original prompt');
    assert.deepEqual(refreshes, [userId]);
    assert.ok(await fs.stat(editPath));
    await fs.writeFile(editPath, original.replace('"1.0.0"', '"1.1.0"'));
    const updated = await call('update_canvas_skill_from_workspace', { ...updateArgs, enable: false });
    assert.equal(details<{ success: boolean; draftCleaned: boolean }>(updated).draftCleaned, true);
    assert.deepEqual(refreshes, [userId, userId]);
    assert.equal((await snapshot()).systemPromptSnapshot, null);

    const core = await call('inspect_canvas_skill', { skillName: 'skill-creator' });
    assert.equal(details<AgentSkillInspection>(core).editable, false);
    assert.match(text(core), /Next:.*differently named personal fork/);
    const fork = await call('create_canvas_skill_draft', { skillName: 'gateway-fork', sourceSkillName: 'gateway-skill' });
    assert.match(text(fork), /Next:.*install_canvas_skill_from_workspace/);
    const forkDraft = details<AgentSkillDraftResult>(fork);
    permissionAllowed = false;
    const denied = await call('install_canvas_skill_from_workspace', { draftPath: forkDraft.packagePath });
    assert.match(text(denied), /permission required/);
    assert.ok(await fs.stat(path.join(workspaceRoot, forkDraft.packagePath)));
    assert.deepEqual(refreshes, [userId, userId]);
    permissionAllowed = true;
    details(await call('discard_canvas_skill_draft', { draftPath: forkDraft.packagePath }));
    assert.deepEqual(refreshes, [userId, userId]);
    console.log('agent skill gateway test passed');
  } finally {
    internals._load = originalLoad;
    await database.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
