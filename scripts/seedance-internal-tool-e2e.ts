import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { openDb, closeDatabaseConnections } from '../app/lib/db';
import { resolvePostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import { runWithAgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createStudioGenerateVideoTool } from '../app/lib/pi/studio-tools';
import { resolveStudioFilePath } from '../app/lib/integrations/studio-workspace';

async function main() {
  assert.equal(process.env.CANVAS_MANAGED_SERVICES_ENABLED, 'true');
  assert.ok(new URL(process.env.CANVAS_CONTROL_PLANE_URL!).hostname === '127.0.0.1');
  const database = await openDb();
  const user = await database.get('SELECT id FROM "user" WHERE email = $1', [process.env.BOOTSTRAP_ADMIN_EMAIL]) as { id: string };
  await database.close();
  assert.ok(user?.id);
  const workspace = await resolvePostgresWorkspaceForActor({ userId: user.id, role: 'admin' }, process.env.KIE_E2E_WORKSPACE_ID!);
  assert.ok(workspace?.permissions.canRunAgent && workspace.permissions.canWrite);
  const tool = createStudioGenerateVideoTool({ userId: user.id });
  const result = await runWithAgentExecutionContext({
    userId: user.id, sessionId: 'seedance-e2e', agentId: null, workspaceId: workspace.workspaceId,
    workspaceType: workspace.workspaceType, workspaceName: workspace.displayName || null,
    workspaceRoot: workspace.rootPath, workspaceRootRelativePath: workspace.rootRelativePath || null,
    organizationId: workspace.organizationId!, customerId: workspace.customerId || null, projectId: workspace.projectId || null,
    canWrite: workspace.permissions.canWrite, canDelete: workspace.permissions.canDelete,
    canShare: workspace.permissions.canCreatePublicLinks, legacy: workspace.legacy,
  }, () => tool.execute('seedance-e2e-tool', { prompt: 'Internal tool E2E: blue geometric shape', provider: 'bytedance', duration: 5 }));
  const details = result.details as { generationId: string; status: string; outputs: Array<{ filePath: string }> };
  assert.equal(details.status, 'completed');
  const check = await openDb();
  const row = await check.get('SELECT model FROM studio_generations WHERE id = $1', [details.generationId]) as { model: string };
  await check.close();
  assert.equal(row.model, 'bytedance/seedance-2-5');
  assert.equal(details.outputs.length, 1);
  for (const output of details.outputs) assert.ok((await stat(resolveStudioFilePath(output.filePath)!)).size > 1000);
  await writeFile('/tmp/canvas-kie-e2e/internal-tool.json', JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log('PASS actual internal studio_generate_video tool → persisted workspace → managed HTTP → worker → output file');
  await closeDatabaseConnections();
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
