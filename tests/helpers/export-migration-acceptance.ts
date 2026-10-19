import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { promises as fs, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import { expect, type APIRequestContext, type APIResponse, type Browser, type BrowserContext } from '@playwright/test';
import type { ClientWorkspaceSummary } from '../../app/lib/workspaces/client-types';

export const acceptanceRoot = process.env.EXPORT_MIGRATION_STATE_DIR
  || path.join(os.homedir(), '.local/state/canvas-local-team-seat/export-migration-99b4');
export const origin = 'http://127.0.0.1:3001';
export const artifacts = path.join(acceptanceRoot, 'artifacts');
export const sentinel = 'fixture-export-99b4-NEVER-PORTABLE';
export const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
type FixtureWorkspace = ClientWorkspaceSummary & { rootRelativePath: string };
export type Fixture = { workspaces: FixtureWorkspace[]; selected: FixtureWorkspace;
  empty: FixtureWorkspace; active: ClientWorkspaceSummary; publicShareToken: string };
let child: ChildProcess | undefined;

function withRoot(workspace: ClientWorkspaceSummary): FixtureWorkspace {
  if (!workspace.rootRelativePath) throw new Error('A fixture workspace must have a concrete relative filesystem root.');
  return { ...workspace, rootRelativePath: workspace.rootRelativePath };
}

export async function runtimeEnv(kind: 'source' | 'target') {
  const env = parse(await fs.readFile(path.join(acceptanceRoot, `${kind}.env`)));
  const database = new URL(env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(database.hostname)
    || database.pathname !== `/canvas_export_99b4_${kind}`
    || path.resolve(env.DATA) !== path.join(acceptanceRoot, `${kind}-data`)
    || env.BASE_URL !== origin || env.PORT !== '3001') {
    throw new Error('Acceptance requires the explicitly isolated source/target database, data root and loopback port.');
  }
  return env;
}

export async function stopRuntime() {
  if (!child || child.exitCode !== null || child.signalCode !== null) { child = undefined; return; }
  const current = child;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { current.kill('SIGKILL'); reject(new Error('Owned acceptance runtime did not stop.')); }, 15_000);
    current.once('exit', () => { clearTimeout(timer); resolve(); });
    current.kill('SIGTERM');
  });
  child = undefined;
}

export async function startRuntime(kind: 'source' | 'target') {
  await stopRuntime();
  const env = await runtimeEnv(kind);
  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
  // Refuse an occupied port instead of adopting or stopping someone else's app.
  const occupied = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) }).then(() => true, () => false);
  if (occupied) throw new Error('Port 3001 is already occupied; stop only the acceptance runtime that owns it.');
  const logPath = path.join(acceptanceRoot, `${kind}-runtime.log`);
  const logOffset = await fs.stat(logPath).then(value => value.size, () => 0);
  const log = openSync(logPath, 'a', 0o600);
  child = spawn(process.execPath, ['--import', 'tsx', 'server.js'], {
    cwd: process.cwd(), env: { ...process.env, ...env, HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  for (const until = Date.now() + 90_000; Date.now() < until;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${kind} runtime exited before readiness; inspect its private log.`);
    const ready = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) }).then(r => r.ok, () => false);
    if (ready) {
      const recentLog = (await fs.readFile(logPath)).subarray(logOffset).toString();
      if (recentLog.includes('[Startup] Orphaned-assets cleanup:')) return;
    }
    await delay(500);
  }
  throw new Error(`${kind} runtime did not become ready.`);
}

export async function json<T = Record<string, unknown>>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${new URL(response.url()).pathname}: HTTP ${response.status()}`).toBeTruthy();
  return await response.json() as T;
}

export async function login(browser: Browser, member = false): Promise<BrowserContext> {
  const env = await runtimeEnv('source');
  const secondary = member ? parse(await fs.readFile(path.join(os.homedir(), '.local/state/canvas-local-team-seat/fixtures.env'))) : {};
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 960 } });
  const response = await context.request.post('/api/auth/sign-in/email', { headers: { origin }, data: {
    email: member ? secondary.LOCAL_TEAM_SEAT_SECONDARY_EMAIL : env.BOOTSTRAP_ADMIN_EMAIL,
    password: member ? secondary.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD : env.BOOTSTRAP_ADMIN_PASSWORD,
  } });
  expect(response.ok(), 'Configured local fixture login succeeds; credentials are never attached.').toBeTruthy();
  return context;
}

export async function ensureFixture(request: APIRequestContext, browser: Browser): Promise<Fixture> {
  const listing = await json<{ workspaces: ClientWorkspaceSummary[] }>(await request.get('/api/workspaces'));
  const session = await json<{ user: { id: string } }>(await request.get('/api/auth/get-session'));
  const own = listing.workspaces.filter(w => w.type === 'personal' && w.ownerUserId === session.user.id);
  const create = async (type: string, name: string, projectId?: string) => {
    const existing = listing.workspaces.find(w => w.name === name);
    return withRoot(existing || (await json<{ workspace: ClientWorkspaceSummary }>(await request.post('/api/workspaces', {
      data: { type, name, ...(projectId ? { projectId } : {}) },
    }))).workspace);
  };
  const selected = await create('personal', 'Export E2E Personal 99b4');
  const empty = await create('personal', 'Export E2E Empty 99b4');
  const team = await create('team', 'Export E2E Team 99b4');
  const organization = listing.workspaces.find(w => w.type === 'organization');
  if (!organization) throw new Error('The managed Team fixture must expose an organization workspace.');
  let project = listing.workspaces.find(w => w.name === 'Export E2E Project 99b4');
  if (!project) {
    const created = await json<{ project: { id: string } }>(await request.post('/api/projects', { data: { name: 'Export E2E Project 99b4' } }));
    project = await create('project', 'Export E2E Project 99b4', created.project.id);
  }
  const env = await runtimeEnv('source');
  const memberContext = await login(browser, true);
  let memberPersonal: FixtureWorkspace;
  try {
    const memberListing = await json<{ workspaces: ClientWorkspaceSummary[] }>(await memberContext.request.get('/api/workspaces'));
    const personal = memberListing.workspaces.find(workspace => workspace.type === 'personal');
    if (!personal) throw new Error('The managed member fixture requires its own personal workspace.');
    memberPersonal = withRoot(personal);
  } finally { await memberContext.close(); }
  const workspaces = [selected, organization, team, project, memberPersonal].map(withRoot);
  for (const workspace of workspaces) {
    const root = path.join(env.DATA, workspace.rootRelativePath, 'export-99b4');
    await fs.mkdir(path.join(root, 'Ordner mit Leerzeichen', 'leer'), { recursive: true });
    await fs.writeFile(path.join(root, 'überblick 日本語.md'), `# ${workspace.type}\n\nOriginal ${workspace.id}\n`, { flag: 'wx' })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    await fs.writeFile(path.join(root, 'Ordner mit Leerzeichen', 'gleich.txt'), workspace.type);
    await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 127, 128, 254, 255]));
  }
  const emptyRoot = path.join(env.DATA, empty.rootRelativePath);
  if (!empty.rootRelativePath.includes('export-e2e-empty-99b4')) throw new Error('Refusing to empty any workspace except the owned empty fixture.');
  await fs.rm(emptyRoot, { recursive: true, force: true });
  await fs.mkdir(emptyRoot, { recursive: true });
  await fs.mkdir(path.join(env.DATA, 'workspace', 'export-99b4'), { recursive: true });
  await fs.writeFile(path.join(env.DATA, 'workspace', 'export-99b4', 'restore.txt'), 'SOURCE RESTORE CONTENT 99b4\n');
  const components: Record<string, string> = {
    'studio/assets/export-99b4.txt': 'studio-assets', 'studio/outputs/export-99b4.txt': 'studio-outputs',
    'user-uploads/export-99b4.txt': 'uploads', 'agents/export-99b4.txt': 'agents', 'skills/export-99b4/SKILL.md': '# Test skill\n',
    'settings/mcp-oauth/export-99b4.json': JSON.stringify({ accessToken: sentinel }),
  };
  for (const [relative, content] of Object.entries(components)) {
    const destination = path.join(env.DATA, relative); await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, { mode: 0o600 });
  }
  await json(await request.patch('/api/integrations/env', { data: {
    secretScope: 'system', scope: 'all', patches: [{ key: 'EXPORT_E2E_SENTINEL', value: sentinel }],
  } }));
  const share = await json<{ shares: Array<{ publicUrl: string }> }>(await request.post('/api/security/public-shares', {
    headers: { 'x-canvas-workspace-id': selected.id }, data: { paths: ['export-99b4/überblick 日本語.md'] },
  }));
  const publicShareToken = decodeURIComponent(new URL(share.shares[0].publicUrl, origin).pathname.split('/')[3]);
  if (!publicShareToken) throw new Error('The public-share fixture must provide a real link token.');
  const fixture = { workspaces, selected, empty, active: own[0], publicShareToken };
  await fs.writeFile(path.join(acceptanceRoot, 'fixture.json'), JSON.stringify(fixture, null, 2), { mode: 0o600 });
  return fixture;
}

export type ZipEntry = { path: string; size: number; sha256: string; directory: boolean };
export function zipEntries(filename: string): ZipEntry[] {
  return JSON.parse(execFileSync('python3', ['-c',
    'import sys,zipfile,json,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps([dict(path=i.filename,size=i.file_size,sha256=hashlib.sha256(z.read(i)).hexdigest(),directory=i.is_dir()) for i in z.infolist()]))',
    filename], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }));
}

export function zipRead(filename: string, entry: string): Buffer {
  return execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: sys.stdout.buffer.write(z.read(sys.argv[2]))', filename, entry], { maxBuffer: 30 * 1024 * 1024 });
}

export function zipMarkerLeaks(filename: string, markers: string[]): string[] {
  const script = 'import sys,zipfile,json\nneedles=[v.encode() for v in json.load(sys.stdin)]\nkeep=max(map(len,needles))\nleaks=[]\nwith zipfile.ZipFile(sys.argv[1]) as z:\n for info in z.infolist():\n  with z.open(info) as f:\n   carry=b""\n   while True:\n    chunk=f.read(65536)\n    if not chunk: break\n    block=carry+chunk\n    if any(n in block for n in needles):\n     leaks.append(info.filename)\n     break\n    carry=block[-keep:]\nprint(json.dumps(leaks))';
  // Tokens go through stdin, never into shell arguments or diagnostic output.
  return JSON.parse(execFileSync('python3', ['-c', script, filename], {
    input: JSON.stringify(markers), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }));
}

export async function inventory(root: string, prefix = ''): Promise<ZipEntry[]> {
  const result: ZipEntry[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      result.push({ path: relative + '/', size: 0, sha256: digest(Buffer.alloc(0)), directory: true });
      result.push(...await inventory(path.join(root, entry.name), relative + '/'));
    } else {
      const bytes = await fs.readFile(path.join(root, entry.name));
      result.push({ path: relative, size: bytes.length, sha256: digest(bytes), directory: false });
    }
  }
  return result;
}

export async function uploadArchive(request: APIRequestContext, filename: string) {
  const bytes = await fs.readFile(filename); const chunkSize = 8 * 1024 * 1024;
  const created = await json<{ upload: { id: string } }>(await migrationPost(request, '/api/migration/uploads', {
    data: { fileName: path.basename(filename), totalBytes: bytes.length, totalParts: Math.ceil(bytes.length / chunkSize) },
  }));
  for (let offset = 0, index = 0; offset < bytes.length; offset += chunkSize, index++) {
    const part = bytes.subarray(offset, offset + chunkSize);
    await json(await request.put(`/api/migration/uploads/${created.upload.id}?partIndex=${index}&expectedBytes=${part.length}`, { data: part }));
  }
  const completed = await migrationPost(request, `/api/migration/uploads/${created.upload.id}/complete`);
  return { response: completed, payload: await completed.json(), bytes: bytes.length };
}

export async function migrationPost(request: APIRequestContext, url: string, options?: Parameters<APIRequestContext['post']>[1]) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request.post(url, options);
    if (response.status() !== 429 || attempt === 1) return response;
    const seconds = Number(response.headers()['retry-after'] || response.headers()['x-retry-after'] || '1');
    await delay(Math.min(60_000, Math.max(1_000, seconds * 1_000)) + 100);
  }
  throw new Error('Migration request exceeded its bounded retry.');
}

/** Synthetic bundles exercise inspector/restore guards; they are labelled separately from UI exports. */
export async function syntheticBundle(name: string, options: {
  schema?: number; appVersion?: string; entry?: string; content?: Buffer; database?: boolean;
} = {}) {
  const content = options.content || Buffer.from('SOURCE RESTORE CONTENT 99b4\n');
  const entry = options.entry || 'data/workspace/export-99b4/restore.txt';
  const version = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')).version;
  const manifest = { format: 'canvas-notebook-migration', bundleSchemaVersion: options.schema ?? 2,
    appVersion: options.appVersion ?? version, exportedAt: new Date().toISOString(), exportId: name,
    exportProfile: 'standard', components: { database: !!options.database, workspace: true, studioAssets: false,
      studioOutputs: false, userUploads: false, agents: false, skills: false, secrets: false },
    fileCount: 1, totalBytes: content.length, warnings: [], files: [{ component: 'workspace', archivePath: entry,
      size: content.length, modifiedAt: new Date().toISOString() }],
    source: { databaseProvider: 'postgres', deploymentMode: 'team', teamFeaturesEnabled: true,
      managedServicesEnabled: false, organizationId: null, createdByUserId: null, createdByEmail: null, createdByRole: null } };
  const filename = path.join(artifacts, name + '.zip');
  execFileSync('python3', ['-c', 'import sys,json,zipfile,base64\np=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_STORED) as z:\n z.writestr("manifest.json",json.dumps(p["manifest"]))\n z.writestr(p["entry"],base64.b64decode(p["content"]))', filename],
    { input: JSON.stringify({ manifest, entry, content: content.toString('base64') }) });
  return filename;
}

export async function randomMultiChunkBundle() {
  return syntheticBundle('synthetic-multichunk', { content: randomBytes(9 * 1024 * 1024) });
}
