import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  DEFAULT_MIGRATION_COMPONENTS,
  MIGRATION_BUNDLE_SCHEMA_VERSION,
  type CanvasMigrationManifest,
  type MigrationComponents,
} from '../app/lib/migration/types';

const execFileAsync = promisify(execFile);

async function createZipArchive(root: string, name: string, manifest: CanvasMigrationManifest, files: Record<string, string>): Promise<string> {
  const bundleDir = path.join(root, name);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(bundleDir, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  const archivePath = path.join(root, `${name}.zip`);
  await execFileAsync('zip', ['-qr', archivePath, '.'], { cwd: bundleDir });
  return archivePath;
}

async function seedTargetDatabase(dataRoot: string) {
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'admin', ?, ?)
    `).run('user-target', 'Target Admin', 'admin@example.test', now, now);
    sqlite.prepare(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES (?, ?, 'team', 1, ?, ?)
    `).run('org-target', 'user-target', now, now);
    sqlite.prepare(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      'workspace-team-target',
      'org-target',
      'team',
      null,
      'workspaces/team/org-target/files',
      'Team Workspace',
      now,
      now,
    );
    sqlite.prepare(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      'workspace-personal-target',
      'org-target',
      'personal',
      'user-target',
      'workspaces/personal/user-target/files',
      'Personal Workspace',
      now,
      now,
    );
  } finally {
    sqlite.close();
  }
}

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-migration-import-dry-run-data-'));
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'canvas-migration-import-dry-run-archives-'));
  const previousData = process.env.DATA;
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const previousDatabaseProvider = process.env.CANVAS_DATABASE_PROVIDER;
  const previousDeploymentMode = process.env.CANVAS_DEPLOYMENT_MODE;

  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_DEPLOYMENT_MODE = 'team';

  try {
    await seedTargetDatabase(dataRoot);
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    const appVersion = packageJson.version;
    const components: MigrationComponents = {
      ...DEFAULT_MIGRATION_COMPONENTS,
      studioAssets: false,
      studioOutputs: false,
      userUploads: false,
      agents: false,
      skills: false,
      secrets: true,
    };

    const matchingManifest: CanvasMigrationManifest = {
      format: 'canvas-notebook-migration',
      bundleSchemaVersion: MIGRATION_BUNDLE_SCHEMA_VERSION,
      appVersion,
      exportedAt: new Date().toISOString(),
      exportId: 'export-matching',
      exportProfile: 'full_admin',
      components,
      selection: {
        includePersonalWorkspaces: true,
        includePublicLinks: false,
        includeRawSecrets: false,
      },
      source: {
        databaseProvider: 'sqlite',
        deploymentMode: 'team',
        teamFeaturesEnabled: true,
        managedServicesEnabled: false,
        organizationId: 'org-target',
        createdByUserId: 'user-target',
        createdByEmail: 'admin@example.test',
        createdByRole: 'admin',
      },
      security: {
        publicLinksIncluded: false,
        publicLinkTokensIncluded: false,
        rawSecretsIncluded: false,
        secretsMode: 'reconnect_manifest',
        unencryptedArchive: true,
      },
      database: {
        provider: 'sqlite',
        logicalSchemaVersion: null,
        migrationVersion: MIGRATION_BUNDLE_SCHEMA_VERSION,
        backupKind: 'sqlite_snapshot',
        artifactPath: 'data/sqlite.db',
        artifactSha256: '0'.repeat(64),
        pgvectorEnabled: null,
        pgvectorVersion: null,
        postgresVersion: null,
      },
      features: {
        teamWorkspaceEnabled: true,
        knowledgeEnabled: false,
        embeddingsEnabled: false,
        collaborationEnabled: false,
      },
      restore: {
        requiresPostgres: false,
        requiresReindex: false,
        preservesTargetInstanceAndLicense: true,
        publicLinksIncluded: false,
      },
      fileCount: 4,
      totalBytes: 4,
      warnings: [],
      files: [
        { component: 'workspace', archivePath: 'data/workspaces/team/org-target/files/team.md', size: 1, modifiedAt: new Date().toISOString() },
        { component: 'workspace', archivePath: 'data/workspaces/personal/user-target/files/private.md', size: 1, modifiedAt: new Date().toISOString() },
        { component: 'secrets', archivePath: 'data/reconnect-manifest.json', size: 1, modifiedAt: new Date().toISOString() },
        { component: 'database', archivePath: 'data/sqlite.db', size: 1, modifiedAt: new Date().toISOString() },
      ],
    };

    const matchingArchive = await createZipArchive(archiveRoot, 'matching', matchingManifest, {
      'data/workspaces/team/org-target/files/team.md': '# Team\n',
      'data/workspaces/personal/user-target/files/private.md': '# Private\n',
      'data/reconnect-manifest.json': `${JSON.stringify({
        format: 'canvas-notebook-reconnect-manifest',
        rawSecretsIncluded: false,
        entries: [
          {
            kind: 'env_file',
            scope: 'legacy',
            path: 'secrets/Canvas-Integrations.env',
            secretNames: ['OPENAI_API_KEY'],
            requiresReconnect: true,
          },
        ],
      })}\n`,
      'data/sqlite.db': 'placeholder',
    });

    const { inspectMigrationArchive } = await import('../app/lib/migration/inspect-service');
    const matchingInspection = await inspectMigrationArchive({ uploadId: 'matching-upload', archivePath: matchingArchive });
    assert.equal(matchingInspection.canRestore, true);
    assert.equal(matchingInspection.dryRun?.status, 'attention_required');
    assert.equal(matchingInspection.dryRun?.stats.blockers, 0);
    assert.equal(matchingInspection.dryRun?.stats.reconnectRequirements, 1);
    assert.equal(matchingInspection.dryRun?.stats.userMappings, 1);
    assert.equal(matchingInspection.dryRun?.users.length, 1);
    assert.equal(matchingInspection.dryRun?.users[0]?.status, 'mapped');
    assert.equal(matchingInspection.dryRun?.workspaces.every((mapping) => mapping.status === 'mapped'), true);

    const blockedManifest: CanvasMigrationManifest = {
      ...matchingManifest,
      exportId: 'export-blocked',
      source: {
        ...matchingManifest.source!,
        organizationId: 'org-source',
        createdByUserId: 'source-user',
        createdByEmail: 'source@example.test',
      },
      files: [
        { component: 'workspace', archivePath: 'data/workspaces/team/org-source/files/team.md', size: 1, modifiedAt: new Date().toISOString() },
        { component: 'workspace', archivePath: 'data/workspaces/personal/source-user/files/private.md', size: 1, modifiedAt: new Date().toISOString() },
        { component: 'workspace', archivePath: 'data/workspaces/project/project-source/files/project.md', size: 1, modifiedAt: new Date().toISOString() },
      ],
    };
    const blockedArchive = await createZipArchive(archiveRoot, 'blocked', blockedManifest, {
      'data/workspaces/team/org-source/files/team.md': '# Team\n',
      'data/workspaces/personal/source-user/files/private.md': '# Private\n',
      'data/workspaces/project/project-source/files/project.md': '# Project\n',
    });
    const blockedInspection = await inspectMigrationArchive({ uploadId: 'blocked-upload', archivePath: blockedArchive });
    assert.equal(blockedInspection.canRestore, false);
    assert.equal(blockedInspection.dryRun?.status, 'blocked');
    assert.ok((blockedInspection.dryRun?.stats.blockers ?? 0) >= 3);
    assert.ok(blockedInspection.dryRun?.blockers.some((blocker) => blocker.includes('source-user')));
    assert.ok(blockedInspection.dryRun?.blockers.some((blocker) => blocker.includes('data/workspaces/team/org-source/files')));
    assert.ok(blockedInspection.dryRun?.blockers.some((blocker) => blocker.includes('data/workspaces/project/project-source/files')));

    const postgresManifest: CanvasMigrationManifest = {
      ...matchingManifest,
      exportId: 'export-postgres',
      database: {
        provider: 'postgres',
        logicalSchemaVersion: null,
        migrationVersion: MIGRATION_BUNDLE_SCHEMA_VERSION,
        backupKind: 'none',
        artifactPath: null,
        artifactSha256: null,
        pgvectorEnabled: true,
        pgvectorVersion: '0.8.3',
        postgresVersion: 'PostgreSQL 18.1',
      },
      features: {
        teamWorkspaceEnabled: true,
        knowledgeEnabled: true,
        embeddingsEnabled: true,
        collaborationEnabled: true,
      },
      restore: {
        requiresPostgres: true,
        requiresReindex: true,
        preservesTargetInstanceAndLicense: true,
        publicLinksIncluded: false,
      },
      files: [],
      fileCount: 0,
      totalBytes: 0,
    };
    const postgresArchive = await createZipArchive(archiveRoot, 'postgres', postgresManifest, {});
    const postgresInspection = await inspectMigrationArchive({ uploadId: 'postgres-upload', archivePath: postgresArchive });
    assert.equal(postgresInspection.canRestore, false);
    assert.equal(postgresInspection.dryRun?.status, 'blocked');
    assert.ok(postgresInspection.dryRun?.blockers.some((blocker) => blocker.includes('Postgres target')));
    assert.ok(postgresInspection.dryRun?.blockers.some((blocker) => blocker.includes('Full Backup')));
    assert.ok(postgresInspection.dryRun?.blockers.some((blocker) => blocker.includes('requires Postgres')));
    assert.ok(postgresInspection.risks.some((risk) => risk.includes('Postgres database data')));

    console.log('migration-import-dry-run-test: ok');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousCanvasDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousCanvasDataRoot;
    if (previousDatabaseProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previousDatabaseProvider;
    if (previousDeploymentMode === undefined) delete process.env.CANVAS_DEPLOYMENT_MODE;
    else process.env.CANVAS_DEPLOYMENT_MODE = previousDeploymentMode;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
