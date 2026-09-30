import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MigrationExportJob } from '../app/lib/migration/types';
import { DEFAULT_MIGRATION_COMPONENTS } from '../app/lib/migration/types';
import type { FullBackupJob } from '../app/lib/backups/types';
const run = promisify(execFile);
async function write(file: string, content: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
async function waitFor<T extends MigrationExportJob | FullBackupJob>(id: string, read: (id: string) => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const job = await read(id); if (job?.status === 'completed') return job; if (job?.status === 'failed') throw new Error(job.error);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Fixture archive timed out.');
}
async function zipText(archive: string, entry: string) { return (await run('unzip', ['-p', archive, entry])).stdout; }
async function main() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-secret-archive-'));
  const dataRoot = path.join(fixtureRoot, 'source'); const restoreRoot = path.join(fixtureRoot, 'restored');
  const saved = { ...process.env }; const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network access forbidden in archive fixture.'); };
  try {
    process.env.DATA = dataRoot; process.env.CANVAS_DATA_ROOT = dataRoot;
    for (const key of ['AGENTS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'OAUTH_STORAGE_PATH', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY', 'MCP_CREDENTIAL_PREVIOUS_KEYS', 'CANVAS_BACKUP_TARGET_DIR']) delete process.env[key];
    process.env.CANVAS_SECRETS_MASTER_KEY = 'fixture-unified-master-32-bytes-and-more';
    process.env.CANVAS_SECRETS_ENV_PATH = path.join(fixtureRoot, 'outside', 'custom-private.txt');
    process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:5432/isolated';
    const pgDump = path.join(fixtureRoot, 'fake-pg-dump');
    await write(pgDump, `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--version'))console.log('pg_dump (PostgreSQL) 18.4');else fs.writeFileSync(a[a.indexOf('--file')+1],'fixture PG dump');\n`); await fs.chmod(pgDump, 0o700); process.env.CANVAS_PG_DUMP_BIN = pgDump;
    const env = await import('../app/lib/integrations/env-config');
    const pi = await import('../app/lib/pi/oauth');
    const mcp = await import('../app/lib/mcp/credential-storage');
    const mail = await import('../app/lib/email/secret-store');
    const migration = await import('../app/lib/migration/export-service');
    const backup = await import('../app/lib/backups/full-backup-service');
    const scopes = [{ userId: 'alice' }, { organizationId: 'org-a' }, { secretScope: 'system' as const }];
    for (const [index, scope] of scopes.entries()) {
      await env.replaceScopedEnvEntries('integrations', [{ key: 'OPENAI_API_KEY', value: `fixture-media-${index}` }, ...(index === 2 ? [{ key: 'MCP_CREDENTIAL_KEY', value: crypto.randomBytes(32).toString('base64url') }] : [])], scope);
      await env.replaceScopedEnvEntries('agents', [{ key: 'OPENAI_API_KEY', value: `fixture-runtime-${index}` }], scope);
    }
    const alice = { userId: 'alice' }; const systemMcp = { legacy: true };
    await pi.saveProviderCredentials('openai-codex', { access: 'fixture-rotated-pi-alice', refresh: 'fixture-pi-refresh', expires: Date.now() + 100_000 }, alice);
    await pi.saveProviderCredentials('openai-codex', { access: 'fixture-rotated-pi-system', refresh: 'fixture-system-refresh', expires: Date.now() + 100_000 });
    const connection = crypto.randomUUID(); const mcpPath = `connections/${connection}/tokens.json`;
    await mcp.writeMcpCredentialJson(mcpPath, { connectionId: connection, organizationId: null, accessToken: 'fixture-rotated-mcp-alice' }, alice);
    const systemConnection = `system-${crypto.randomBytes(32).toString('hex')}`; const systemMcpPath = `connections/${systemConnection}/tokens.json`;
    await mcp.writeMcpCredentialJson(systemMcpPath, { connectionId: systemConnection, accessToken: 'fixture-rotated-mcp-system' }, systemMcp);
    const mailRef = mail.emailAccountSecretRef('alice', 'account-a'); const sharedMailRef = mail.workspaceEmailAccountSecretRef('shared');
    await mail.writeEmailAccountSecret(mailRef, { authType: 'oauth', tokenType: 'Bearer', accessToken: 'fixture-rotated-mail-alice' });
    await mail.writeEmailAccountSecret(sharedMailRef, { authType: 'smtp_imap', smtp: { host: 'smtp.example.test', port: 465, secure: true, username: 'fixture', password: 'fixture-rotated-smtp' } });
    const bytesByScope = await Promise.all(scopes.map(scope => fs.readFile(env.getUnifiedEnvFilePath(scope))));
    // Legacy decoys must not replace the rotated durable credentials after recovery.
    await write(path.join(dataRoot, 'settings', 'auth.json'), '{"legacy-token":"fixture-legacy-PI-DO-NOT-EXPORT"}');
    await write(path.join(dataRoot, 'canvas-agent', 'auth.json'), 'fixture-agent-auth-DO-NOT-EXPORT');
    await write(path.join(dataRoot, 'settings', 'mcp-oauth', 'old.json'), 'fixture-legacy-mcp-DO-NOT-EXPORT');
    await write(path.join(dataRoot, 'settings', 'connections', 'old', 'tokens.json'), 'fixture-encrypted-old-MCP-DO-NOT-EXPORT');
    await write(path.join(dataRoot, 'settings', 'states', 'pending.json'), 'fixture-pkce-state-DO-NOT-EXPORT');
    await write(path.join(dataRoot, 'secrets', 'email-accounts', 'alice', 'old.json.enc'), 'fixture-encrypted-old-MAIL-DO-NOT-EXPORT');
    await write(path.join(dataRoot, 'system', 'secrets', 'Canvas-Secrets.env'), 'DECOY=fixture-dormant-system-store\n');
    await write(path.join(dataRoot, 'workspace', 'note.md'), 'ordinary workspace note\n');
    await write(path.join(dataRoot, 'workspace', 'auth.json'), '{"ordinary":"workspace user content"}');
    await write(path.join(dataRoot, 'workspace', 'project', 'secrets', 'README.md'), 'ordinary project documentation\n');
    await write(path.join(dataRoot, 'workspace', 'project', 'Canvas-Agents.env'), 'ORDINARY_PROJECT_VALUE=keep-this-file\n');
    const inlineConfig = JSON.stringify({ mcpServers: { remote: { connectionId: connection, url: 'https://mcp.example.test', env: { TOKEN: 'fixture-inline-env-DO-NOT-EXPORT', REF: '${SAFE_EXISTING_KEY}' }, headers: { 'X-Custom': 'fixture-inline-header-DO-NOT-EXPORT', Authorization: 'Bearer ${OLD_TOKEN}' }, oauth: { clientId: 'safe-client-id', clientSecret: 'fixture-inline-client-secret-DO-NOT-EXPORT' } } } });
    await write(path.join(dataRoot, 'settings', 'mcp.json'), inlineConfig);
    await write(path.join(dataRoot, 'canvas-agent', 'pi-runtime-config.json'), JSON.stringify({ activeProvider: 'openai', providers: { openai: { model: 'safe-model', apiKey: 'fixture-inline-provider-DO-NOT-EXPORT', apiKeyEnv: 'OPENAI_API_KEY' } } }));
    // Both configured secret overrides are inside otherwise portable components.
    process.env.INTEGRATIONS_ENV_PATH = path.join(dataRoot, 'workspace', 'custom-integration-private.txt');
    process.env.OAUTH_STORAGE_PATH = path.join(dataRoot, 'workspace', 'custom-oauth-private.txt');
    await write(process.env.INTEGRATIONS_ENV_PATH, 'CUSTOM_API_KEY="fixture-custom-override-DO-NOT-EXPORT\nFIXTURE_VALUE_FRAGMENT_DO_NOT_EXPORT=value\n"\n'); await write(process.env.OAUTH_STORAGE_PATH, 'fixture-custom-oauth-DO-NOT-EXPORT');
    const activeCanonical = process.env.CANVAS_SECRETS_ENV_PATH;
    process.env.CANVAS_SECRETS_ENV_PATH = path.join(dataRoot, 'workspace', 'custom-canonical-private.txt'); await fs.copyFile(activeCanonical, process.env.CANVAS_SECRETS_ENV_PATH);
    await env.readUnifiedEnvState({ secretScope: 'system' });
    assert.ok(await fs.stat(`${process.env.CANVAS_SECRETS_ENV_PATH}.lock`));
    await write(path.join(dataRoot, 'system', 'secrets', 'Canvas-Secrets.env.lock'), '');
    await fs.chmod(path.join(dataRoot, 'system', 'secrets', 'Canvas-Secrets.env.lock'), 0o600);
    const exported = await waitFor((await migration.createMigrationExportJob({ components: { ...DEFAULT_MIGRATION_COMPONENTS, secrets: true, database: false }, source: { databaseProvider: 'postgres' } })).id, migration.getMigrationExportJob);
    assert.ok(exported.filePath);
    const names = (await run('unzip', ['-Z1', exported.filePath])).stdout.split('\n').filter(Boolean);
    for (const name of names) assert.equal(/(?:\/mcp-oauth\/|\/connections\/|\/states\/|(?:settings|canvas-agent)\/auth\.json|custom-.*private)/.test(name), false, `portable archive excludes credential path ${name}`);
    let archiveText = ''; for (const name of names) archiveText += await zipText(exported.filePath, name);
    assert.equal(archiveText.includes('DO-NOT-EXPORT'), false); assert.equal(archiveText.includes('fixture-rotated'), false); assert.equal(archiveText.includes('enc:v1:'), false);
    assert.equal(archiveText.includes('FIXTURE_VALUE_FRAGMENT_DO_NOT_EXPORT'), false, 'multiline secret values never masquerade as reconnect key names');
    assert.equal(await zipText(exported.filePath, 'data/workspace/auth.json'), '{"ordinary":"workspace user content"}');
    assert.equal(await zipText(exported.filePath, 'data/workspace/project/secrets/README.md'), 'ordinary project documentation\n');
    assert.equal(await zipText(exported.filePath, 'data/workspace/project/Canvas-Agents.env'), 'ORDINARY_PROJECT_VALUE=keep-this-file\n');
    const exportedConfig = JSON.parse(await zipText(exported.filePath, 'data/settings/mcp.json'));
    assert.equal(exportedConfig.mcpServers.remote.connectionId, connection); assert.equal(exportedConfig.mcpServers.remote.env.REF, '${SAFE_EXISTING_KEY}'); assert.match(exportedConfig.mcpServers.remote.env.TOKEN, /^\$\{CANVAS_MCP_/); assert.equal(exportedConfig.mcpServers.remote.oauth.clientSecret, undefined); assert.equal(exportedConfig.mcpServers.remote.oauth.clientId, 'safe-client-id');
    assert.equal(await fs.readFile(path.join(dataRoot, 'settings', 'mcp.json'), 'utf8'), inlineConfig, 'portable redaction never edits live source');
    const reconnect = JSON.parse(await zipText(exported.filePath, 'data/reconnect-manifest.json'));
    assert.ok(reconnect.entries.some((entry: { path: string; secretNames?: string[] }) => entry.path === 'configured/Canvas-Secrets.env' && entry.secretNames?.includes('CANVAS_CREDENTIAL_PI_OAUTH')));
    assert.ok(reconnect.entries.some((entry: { path: string }) => entry.path === 'users/alice/secrets/Canvas-Secrets.env'));
    assert.ok(reconnect.entries.some((entry: { path: string }) => entry.path === 'organizations/org-a/secrets/Canvas-Secrets.env'));
    assert.ok(reconnect.entries.some((entry: { path: string }) => entry.path === 'configured/pi-auth.json'));
    for (const entry of exported.manifest!.files) assert.equal(Buffer.byteLength(await zipText(exported.filePath, entry.archivePath)), entry.size, 'manifest sizes describe redacted archive bytes');
    const withoutReconnect = await waitFor((await migration.createMigrationExportJob({ components: { ...DEFAULT_MIGRATION_COMPONENTS, secrets: false, database: true }, source: { databaseProvider: 'postgres' } })).id, migration.getMigrationExportJob);
    assert.ok(withoutReconnect.filePath);
    const withoutNames = (await run('unzip', ['-Z1', withoutReconnect.filePath])).stdout;
    assert.equal(withoutNames.includes('reconnect-manifest'), false); assert.equal(withoutNames.includes('database/'), false, 'portable Postgres exports carry metadata rather than credential-bearing dumps');
    assert.equal(withoutNames.includes('custom-canonical-private'), false);
    const safeArgs = ['--region', 'eu', '--api-key', '${API_KEY}', 'TOKEN=${TOKEN}', '--header', 'Authorization: Bearer ${TOKEN}'];
    const safeConfig = JSON.stringify({ mcpServers: { safe: { command: 'node', args: safeArgs, url: 'https://mcp.example.test?token=${TOKEN}&region=eu' } } });
    await write(path.join(dataRoot, 'settings', 'mcp.json'), safeConfig);
    const safeExport = await waitFor((await migration.createMigrationExportJob({ components: { ...DEFAULT_MIGRATION_COMPONENTS, secrets: false, database: false }, source: { databaseProvider: 'postgres' } })).id, migration.getMigrationExportJob);
    assert.ok(safeExport.filePath);
    assert.deepEqual(JSON.parse(await zipText(safeExport.filePath, 'data/settings/mcp.json')).mcpServers.safe.args, safeArgs, 'safe arguments and explicit credential references survive portable export');
    for (const unsafe of [
      { env: ['fixture-shape-secret'] }, { env: 'fixture-shape-secret' }, { headers: ['fixture-shape-secret'] }, { headers: 'fixture-shape-secret' },
      { url: 'https://user:fixture-password@mcp.example.test' }, { url: 'https://mcp.example.test?access_token=fixture-query-token' },
      { command: 'node', args: ['--api-key', 'fixture-cli-secret'] }, { command: 'node', args: ['--token=fixture-cli-secret'] },
      { command: 'node', args: ['API_KEY=fixture-env-assignment'] }, { command: 'node', args: ['--header', 'Authorization: Bearer fixture-cli-secret'] },
      { auth: { type: 'api-key', value: 'fixture-auth-secret' } },
    ]) {
      const unsafeRaw = JSON.stringify({ mcpServers: { unsafe } });
      await write(path.join(dataRoot, 'settings', 'mcp.json'), unsafeRaw);
      const queued = await migration.createMigrationExportJob({ components: { ...DEFAULT_MIGRATION_COMPONENTS, secrets: false, database: false }, source: { databaseProvider: 'postgres' } });
      await assert.rejects(() => waitFor(queued.id, migration.getMigrationExportJob), /safely export|Reconnect before exporting/);
      assert.equal((await migration.getMigrationExportJob(queued.id))?.filePath, undefined, 'credential-bearing or malformed known runtime config fails before archive publication');
      assert.equal(await fs.readFile(path.join(dataRoot, 'settings', 'mcp.json'), 'utf8'), unsafeRaw);
    }
    await write(path.join(dataRoot, 'settings', 'mcp.json'), inlineConfig);
    const underDataBackup = await waitFor((await backup.createFullBackupJob()).id, backup.getFullBackupJob);
    assert.equal(underDataBackup.manifest?.files.some(entry => entry.archivePath === 'data/workspace/custom-canonical-private.txt.lock'), false, 'configured custom lock inside DATA is omitted');
    assert.equal(underDataBackup.manifest?.files.some(entry => entry.archivePath === 'data/system/secrets/Canvas-Secrets.env.lock'), false, 'default canonical lock fixture inside DATA is omitted');
    await new Promise(resolve => setTimeout(resolve, 25));
    process.env.CANVAS_SECRETS_ENV_PATH = activeCanonical;
    await fs.chmod(activeCanonical, 0o644);
    const full = await waitFor((await backup.createFullBackupJob()).id, backup.getFullBackupJob); assert.ok(full.filePath);
    const inspected = await backup.inspectFullBackupArchive(full.filePath); assert.equal(inspected.canRestore, true);
    assert.equal(inspected.manifest?.files.some(entry => entry.archivePath.endsWith('Canvas-Secrets.env.lock')), false, 'kernel lock sidecars are recreated after recovery');
    assert.equal(await zipText(full.filePath, 'data/system/secrets/Canvas-Secrets.env'), bytesByScope[2].toString(), 'active external store replaces dormant canonical archive slot');
    await fs.mkdir(restoreRoot); await run('unzip', ['-q', full.filePath, 'data/*', '-d', restoreRoot]);
    process.env.DATA = path.join(restoreRoot, 'data'); process.env.CANVAS_DATA_ROOT = process.env.DATA;
    for (const key of ['CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'OAUTH_STORAGE_PATH']) delete process.env[key];
    for (const [index, scope] of scopes.entries()) {
      assert.deepEqual(await fs.readFile(env.getUnifiedEnvFilePath(scope)), bytesByScope[index]);
      assert.equal((await fs.stat(env.getUnifiedEnvFilePath(scope))).mode & 0o777, 0o600, 'restored canonical credential files keep private permissions');
      assert.equal((await env.readScopedEnvState('integrations', scope)).entries.find(item => item.key === 'OPENAI_API_KEY')?.value, `fixture-media-${index}`);
      assert.equal((await env.readScopedEnvState('agents', scope)).entries.find(item => item.key === 'OPENAI_API_KEY')?.value, `fixture-runtime-${index}`);
    }
    assert.equal(pi.getProviderCredentials('openai-codex', alice)?.access, 'fixture-rotated-pi-alice'); assert.equal(pi.getProviderCredentials('openai-codex')?.access, 'fixture-rotated-pi-system');
    assert.equal((await mcp.readMcpCredentialJson<{ accessToken: string }>(mcpPath, alice))?.accessToken, 'fixture-rotated-mcp-alice'); assert.equal((await mcp.readMcpCredentialJson<{ accessToken: string }>(systemMcpPath, systemMcp))?.accessToken, 'fixture-rotated-mcp-system');
    assert.equal((await mail.readEmailAccountSecret(mailRef) as { accessToken: string }).accessToken, 'fixture-rotated-mail-alice'); assert.equal((await mail.readEmailAccountSecret(sharedMailRef) as { smtp: { password: string } }).smtp.password, 'fixture-rotated-smtp');
    assert.equal(pi.getProviderCredentials('openai-codex', { userId: 'missing-user' }), null);
    process.env.CANVAS_SECRETS_MASTER_KEY = 'wrong-fixture-master'; await assert.rejects(() => env.readScopedEnvState('agents', alice), /decrypt|readable|master/i);
    console.log('Portable archive excludes canonical/legacy/custom credentials and redacts runtime configs; full DATA recovery preserves profiles, stored keys and actual PI/MCP/Mail credentials. No database restore exercised.');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); globalThis.fetch = oldFetch; await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
