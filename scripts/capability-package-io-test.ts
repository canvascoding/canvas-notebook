import assert from 'node:assert/strict';
import Module from 'node:module';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-package-io-'));
  const previousData = process.env.DATA, previousRoot = process.env.CANVAS_DATA_ROOT, previousOrigin = process.env.BETTER_AUTH_BASE_URL;
  process.env.DATA = scratch; process.env.CANVAS_DATA_ROOT = scratch;
  process.env.BETTER_AUTH_BASE_URL = 'http://fixture.local:3000';
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    return originalLoad(name, parent, isMain);
  };
  try {
    const io = await import('../app/lib/capabilities/packages/io');
    const { CAPABILITY_PACKAGE_LIMITS: limits } = await import('../app/lib/capabilities/packages/contracts');
    const { computeCanvasPluginChecksum } = await import('../app/lib/plugins/canvas-plugin-registry');
    const source = path.join(scratch, 'source', 'design-skill');
    await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(source, 'assets'), { recursive: true });
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: design-skill\ndescription: Initial package\n---\n\nVersion one.\n');
    await fs.writeFile(path.join(source, 'scripts', 'design.sh'), '#!/bin/sh\nprintf original\n', { mode: 0o700 });
    await fs.writeFile(path.join(source, 'assets', 'image.png'), Buffer.from([0, 255, 17, 36]));
    await fs.writeFile(path.join(source, '.canvas-plugin', 'plugin.json'), '{"version":"1.0.0"}');
    await fs.writeFile(path.join(source, 'node_modules', 'ignored.txt'), 'excluded legacy checksum content');
    const inventory = await io.readExactPackageInventory(source);
    assert.equal(inventory.checksum, await computeCanvasPluginChecksum(source));
    assert.equal(inventory.files.length, 4);
    assert(inventory.files.some(file => file.path === '.canvas-plugin/plugin.json'));
    assert(!inventory.files.some(file => file.path.includes('node_modules')));
    assert.equal(inventory.files.find(file => file.path === 'scripts/design.sh')?.executable, true);

    const owner = { type: 'team' as const, organizationId: 'package-org', workspaceId: 'real-team' };
    const resourceRef = `canvas-resource:${randomUUID()}`;
    const draft = io.resolveCapabilityPackageDraftLocation({ resourceRef, draftRef: `canvas-package-draft:${randomUUID()}`,
      kind: 'skill', name: 'design-skill', owner, actorUserId: 'editor', draftRevision: 1 });
    assert(draft.rootPath.startsWith(path.join(scratch, 'users', 'editor')));
    assert(!draft.rootPath.includes('workspaces'));
    await io.createCapabilityPackageDraft({ rootPath: source, resourceRef, owner, kind: 'skill', name: 'design-skill' }, draft);
    const changedSourceDraft = io.resolveCapabilityPackageDraftLocation({ ...draft, draftRef: `canvas-package-draft:${randomUUID()}` });
    await assert.rejects(io.createCapabilityPackageDraft({ rootPath: source, resourceRef, owner, kind: 'skill', name: 'design-skill' },
      changedSourceDraft, { expectedSourceChecksum: 'a'.repeat(64) }), /source package changed/i);
    await assert.rejects(fs.access(changedSourceDraft.rootPath), /ENOENT/);
    const fork = io.resolveCapabilityPackageDraftLocation({ ...draft, draftRef: `canvas-package-draft:${randomUUID()}`, name: 'design-fork' });
    const forked = await io.createCapabilityPackageDraft({ rootPath: source, resourceRef, owner, kind: 'skill', name: 'design-skill' },
      fork, { expectedSourceChecksum: inventory.checksum });
    assert.notEqual(forked.checksum, inventory.checksum);
    assert.match(Buffer.from((await io.readCapabilityPackageFile(fork, { path: 'SKILL.md' })).content, 'base64').toString(), /name: design-fork/u);
    assert.match(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), /name: design-skill/u);
    await io.removeCapabilityPackageDraft(fork);
    const pluginSource = path.join(scratch, 'source', 'seed-plugin');
    await fs.mkdir(path.join(pluginSource, '.canvas-plugin'), { recursive: true });
    await fs.writeFile(path.join(pluginSource, '.canvas-plugin', 'plugin.json'), JSON.stringify({
      name: 'seed-plugin', version: '1.0.0', skillRefs: [{ name: 'design-skill', source: 'seed' }],
    }));
    const pluginInventory = await io.readExactPackageInventory(pluginSource);
    const bundledDraft = io.resolveCapabilityPackageDraftLocation({ ...draft, draftRef: `canvas-package-draft:${randomUUID()}`,
      kind: 'plugin', name: 'seed-plugin' });
    const bundle = { source: { rootPath: source, resourceRef, owner, kind: 'skill' as const, name: 'design-skill' },
      relativeTargetRoot: 'skills/design-skill', checksum: inventory.checksum };
    const bundled = await io.createCapabilityPackageDraft({ rootPath: pluginSource, resourceRef, owner,
      kind: 'plugin', name: 'seed-plugin' }, bundledDraft, { expectedSourceChecksum: pluginInventory.checksum, bundledReferences: [bundle] });
    const bundledManifest = JSON.parse(Buffer.from((await io.readCapabilityPackageFile(bundledDraft, { path: '.canvas-plugin/plugin.json' })).content, 'base64').toString());
    assert.equal(bundledManifest.skills, './skills');
    assert.equal(bundledManifest.skillRefs, undefined);
    assert.equal(Buffer.from((await io.readCapabilityPackageFile(bundledDraft, { path: 'skills/design-skill/assets/image.png' })).content, 'base64').toString('hex'), '00ff1124');
    assert.equal(bundled.files.find(file => file.path === 'skills/design-skill/scripts/design.sh')?.executable, true);
    const dependencyRaceDraft = io.resolveCapabilityPackageDraftLocation({ ...bundledDraft, draftRef: `canvas-package-draft:${randomUUID()}` });
    await assert.rejects(io.createCapabilityPackageDraft({ rootPath: pluginSource, resourceRef, owner, kind: 'plugin', name: 'seed-plugin' },
      dependencyRaceDraft, { bundledReferences: [{ ...bundle, checksum: 'b'.repeat(64) }] }), /referenced skill changed/i);
    await assert.rejects(fs.access(dependencyRaceDraft.rootPath), /ENOENT/);
    await assert.rejects(io.createCapabilityPackageDraft({ rootPath: pluginSource, resourceRef, owner, kind: 'plugin', name: 'seed-plugin' },
      dependencyRaceDraft, { bundledReferences: [{ ...bundle, relativeTargetRoot: '../design-skill' }] }), /path.*invalid/i);
    await assert.rejects(io.readExactPackageInventory(source, { maxFiles: 3 }), /too many files/i);
    await assert.rejects(io.readExactPackageInventory(source, { maxTotalBytes: 1 }), /byte limit/i);
    await io.removeCapabilityPackageDraft(bundledDraft);
    const original = await io.readCapabilityPackageFile(draft, { path: 'scripts/design.sh', offset: 2, maxBytes: 4 });
    assert.equal(Buffer.from(original.content, 'base64').toString(), '/bin');
    assert.equal(original.eof, false);
    assert.equal((await io.listCapabilityPackageFiles(draft)).filter(file => file.type === 'file').length, 4);
    for (const unsafe of ['../SKILL.md', '/SKILL.md', 'C:/SKILL.md', 'scripts/../SKILL.md', 'scripts//design.sh', 'scripts\\design.sh', 'SKILL.md\0']) {
      await assert.rejects(io.readCapabilityPackageFile(draft, { path: unsafe }), /path.*invalid/i);
    }
    await assert.rejects(io.readCapabilityPackageFile(draft, { path: 'SKILL.md', maxBytes: limits.maxReadBytes + 1 }), /range.*invalid/i);
    await assert.rejects(io.writeCapabilityPackageDraftFile(draft, { path: 'scripts/a.ts', encoding: 'base64', content: 'a==' }), /base64/i);
    await assert.rejects(io.writeCapabilityPackageDraftFile({ ...draft, actorUserId: 'foreign-editor' },
      { path: 'SKILL.md', encoding: 'base64', content: Buffer.from('foreign').toString('base64') }), /actor-owned/i);
    await assert.rejects(io.writeCapabilityPackageDraftFile(draft,
      { path: '.env', encoding: 'base64', content: Buffer.from('TOKEN=secret').toString('base64') }), /central secrets/i);

    const identity = { resourceRef, revisionRef: `canvas-package-revision:${randomUUID()}`, kind: 'skill' as const,
      name: 'design-skill', version: '1.0.0', checksum: inventory.checksum, owner };
    const validation = { valid: true, kind: 'skill' as const, name: identity.name, version: identity.version,
      checksum: inventory.checksum, files: inventory.files.map(({ path: filePath, size, checksum }) => ({ path: filePath, size, checksum })),
      totalBytes: inventory.totalBytes, errors: [], warnings: [] };
    const published = await io.preparePublishedSnapshot(draft, identity, validation);
    assert(published.location.rootPath.startsWith(path.join(scratch, 'organizations', 'package-org')));
    assert.equal(path.basename(published.location.rootPath), 'design-skill');
    await io.verifyCapabilityPackageSnapshot(published.location);
    await assert.rejects(io.preparePublishedSnapshot(draft, identity, validation), /exist/i);
    await assert.rejects(io.verifyCapabilityPackageSnapshot({ ...published.location, checksum: 'a'.repeat(64) }), /binding.*inconsistent/i);
    assert.equal((await fs.stat(path.join(published.location.rootPath, 'scripts/design.sh'))).mode & 0o222, 0);
    assert.equal((await fs.stat(path.join(published.location.rootPath, 'scripts/design.sh'))).mode & 0o111, 0o100);
    const marker = await fs.readFile(path.join(path.dirname(published.location.rootPath), 'published.json'), 'utf8');
    assert.equal(JSON.parse(marker).checksum, inventory.checksum);
    assert(!(await io.readExactPackageInventory(published.location.rootPath)).files.some(file => file.path === 'published.json'));

    const eightMiB = Buffer.alloc(limits.maxReadBytes, 65);
    await io.writeCapabilityPackageDraftFile(draft,
      { path: 'assets/large.bin', encoding: 'base64', content: eightMiB.toString('base64') });
    const second = io.resolveCapabilityPackageDraftLocation({ ...draft, draftRevision: 2 });
    assert.equal((await io.readCapabilityPackageFile(second, { path: 'assets/large.bin' })).byteLength, eightMiB.byteLength,
      'A valid large base64 write uses a bounded linear decoder and remains readable.');
    await assert.rejects(io.readCapabilityPackageFile(draft, { path: 'assets/large.bin' }), /ENOENT/);
    const unchanged = await io.readExactPackageInventory(draft.rootPath);
    assert.equal(unchanged.checksum, inventory.checksum, 'SQL rollback can retain r=1 without any byte mutation.');
    // Reusing held current r=1 represents a rolled-back write: only its uncommitted
    // r+1 destination is replaced, while current and published bytes remain intact.
    const newScript = Buffer.from('#!/bin/sh\nprintf updated\n');
    await io.writeCapabilityPackageDraftFile(draft,
      { path: 'scripts/design.sh', encoding: 'base64', content: newScript.toString('base64') });
    assert.equal(Buffer.from((await io.readCapabilityPackageFile(second, { path: 'scripts/design.sh' })).content, 'base64').toString(), newScript.toString());
    await assert.rejects(io.readCapabilityPackageFile(second, { path: 'assets/large.bin' }), /ENOENT/);
    assert.equal(Buffer.from((await io.readCapabilityPackageFile(published.location, { path: 'scripts/design.sh' })).content, 'base64').toString(), '#!/bin/sh\nprintf original\n');
    await io.deleteCapabilityPackageDraftFile(second, { path: 'assets/image.png' });
    const third = io.resolveCapabilityPackageDraftLocation({ ...draft, draftRevision: 3 });
    await assert.rejects(io.readCapabilityPackageFile(third, { path: 'assets/image.png' }), /ENOENT/);
    assert.equal((await io.readCapabilityPackageFile(second, { path: 'assets/image.png' })).size, 4);
    await io.removeCapabilityPackageDraft(third);
    await assert.rejects(fs.access(draft.rootPath), /ENOENT/);
    await io.verifyCapabilityPackageSnapshot(published.location);

    const oversized = path.join(scratch, 'oversized');
    await fs.mkdir(oversized);
    const handle = await fs.open(path.join(oversized, 'large.bin'), constants.O_WRONLY | constants.O_CREAT, 0o600);
    try { await handle.truncate(limits.maxFileBytes + 1); } finally { await handle.close(); }
    await assert.rejects(io.readExactPackageInventory(oversized), /byte limit/i);
    const linked = path.join(scratch, 'linked');
    await fs.mkdir(linked);
    await fs.symlink(path.join(source, 'SKILL.md'), path.join(linked, 'SKILL.md'));
    await assert.rejects(io.readExactPackageInventory(linked), /symbolic links/i);
    await fs.unlink(path.join(linked, 'SKILL.md'));
    await fs.link(path.join(source, 'SKILL.md'), path.join(linked, 'SKILL.md'));
    await assert.rejects(io.readExactPackageInventory(linked), /non-linked/i);
    await fs.unlink(path.join(linked, 'SKILL.md'));
    const secret = path.join(scratch, 'secret');
    await fs.mkdir(secret);
    await fs.writeFile(path.join(secret, 'config.json'), '-----BEGIN PRIVATE KEY-----\nprivate body\n');
    await assert.rejects(io.readExactPackageInventory(secret), /central secrets/i);
    const ancestor = path.join(scratch, 'users', 'symlink-editor');
    await fs.symlink(path.join(scratch, 'source'), ancestor);
    const badDraft = io.resolveCapabilityPackageDraftLocation({ ...draft, actorUserId: 'symlink-editor' });
    await assert.rejects(io.createCapabilityPackageDraft({ rootPath: source, resourceRef, owner, kind: 'skill', name: 'design-skill' }, badDraft), /symbolic links/i);

    console.log('capability-package-io-test: PASS (full bytes/checksum, private draft, immutable org snapshot, ranges, symlinks, secrets and bounded allocation)');
  } finally {
    internals._load = originalLoad;
    await database.close();
    async function unlock(directory: string): Promise<void> {
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        await fs.chmod(directory, 0o700);
        for (const entry of await fs.readdir(directory)) await unlock(path.join(directory, entry));
      }
    }
    await unlock(scratch);
    await fs.rm(scratch, { recursive: true, force: true });
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    if (previousRoot === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousRoot;
    if (previousOrigin === undefined) delete process.env.BETTER_AUTH_BASE_URL; else process.env.BETTER_AUTH_BASE_URL = previousOrigin;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
