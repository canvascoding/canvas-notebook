/** Local host-dev fixture: creates a linked Markdown rename proposal under real workspace rights. */
import fs from 'node:fs/promises';
import { parse } from 'dotenv';

async function main() {
  const envFile = process.env.CANVAS_ENV_FILE?.trim();
  if (envFile) {
    const values = parse(await fs.readFile(envFile));
    for (const [key, value] of Object.entries(values)) process.env[key] ??= value;
  }
  const workspaceId = process.argv[2]?.trim();
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  if (!workspaceId || !email) throw new Error('Pass workspace ID as argv[2] and configure BOOTSTRAP_ADMIN_EMAIL.');
  const [{ openDb }, { submitAgentWorkspacePathOperation }, { resolveWorkspaceActor },
    { resolvePostgresWorkspaceForActor }, { resolveWorkspacePath }, { workspaceFileOptions }] = await Promise.all([
    import('../app/lib/db'), import('../app/lib/files/workspace-operation-review-service'),
    import('../app/lib/workspaces/context'), import('../app/lib/workspaces/postgres-runtime'),
    import('../app/lib/workspaces/path-guard'), import('../app/lib/workspaces/request'),
  ]);
  const connection = await openDb();
  let user: { id: string; email: string; role: string | null; name: string } | undefined;
  try {
    user = await connection.get('SELECT id, email, role, name FROM "user" WHERE email = $1', [email]) as typeof user;
  } finally { await connection.close(); }
  if (!user) throw new Error('Bootstrap user not found in the local database.');
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(user), workspaceId);
  if (!workspace || !workspace.permissions.canRunAgent || !workspace.permissions.canDelete) {
    throw new Error('The bootstrap user cannot propose agent file operations in this workspace.');
  }
  const folder = `codex-review-fixture-${Date.now()}`;
  const target = `${folder}/target.md`;
  const linked = `${folder}/index.md`;
  const moved = `${folder}/moved.md`;
  await fs.mkdir(resolveWorkspacePath(workspace, folder).absolutePath, { recursive: false });
  await fs.writeFile(resolveWorkspacePath(workspace, target).absolutePath, '# Review fixture target\n', { flag: 'wx' });
  await fs.writeFile(resolveWorkspacePath(workspace, linked).absolutePath, '[Open target](./target.md)\n', { flag: 'wx' });
  const scope = { workspace, fileOptions: workspaceFileOptions(workspace) };
  const review = await submitAgentWorkspacePathOperation({
    kind: 'move', source: scope, destination: scope,
    selections: [{ sourcePath: target, destinationPath: moved }],
    actorUserId: user.id, actorId: `fixture-agent-${user.id}`,
    actorDisplayName: 'Local review fixture', actorSessionId: `fixture-${folder}`,
    idempotencyKey: `fixture-${folder}`,
  });
  process.stdout.write(`${JSON.stringify({ workspaceId, folder, target, linked, moved, review })}\n`);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
