import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Module from 'node:module';

import JSZip from 'jszip';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') {
    return {};
  }
  if (request === '@earendil-works/pi-ai') {
    return {
      completeSimple: async () => {
        throw new Error('pi-ai should not be called by the Canvas skill store test.');
      },
      streamSimple: async function* () {
        throw new Error('pi-ai should not be streamed by the Canvas skill store test.');
      },
      getModels: () => [],
      getProviders: () => [],
      isContextOverflow: () => false,
      registerBuiltInApiProviders: () => undefined,
    };
  }
  if (request === '@earendil-works/pi-ai/oauth') {
    return {};
  }
  return originalLoad(request, parent, isMain);
};

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function createTestSkillPackage(): Promise<string> {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-package-'));

  await writeFile(path.join(skillRoot, 'SKILL.md'), `---
name: test-library-skill
description: "Use this temporary library skill for Canvas skill store tests."
license: "MIT"
metadata:
  version: "1.0.0"
---

# Test Library Skill

This is a temporary test skill.
`);

  await writeFile(path.join(skillRoot, 'agents', 'canvas.yaml'), `interface:
  display_name: Test Library Skill
  short_description: Temporary library skill
  brand_color: "#2563EB"
  icon_small: "./icon.svg"
`);

  await writeFile(
    path.join(skillRoot, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="#2563EB"/><text x="16" y="21" font-size="12" text-anchor="middle" fill="white">TS</text></svg>\n',
  );

  return skillRoot;
}

async function createStoreArchive(skillRoot: string, checksum: string): Promise<string> {
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-store-'));
  const packagePrefix = 'canvas-plugin-marketplace-test/skills/test-library-skill/1.0.0';
  const zip = new JSZip();

  async function addDirectory(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await addDirectory(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(skillRoot, fullPath).split(path.sep).join('/');
        zip.file(`${packagePrefix}/${relativePath}`, await fs.readFile(fullPath));
      }
    }
  }

  await addDirectory(skillRoot);
  const zipPath = path.join(storeRoot, 'test-library-skill.zip');
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const registryPath = path.join(storeRoot, 'registry.json');
  await writeFile(registryPath, JSON.stringify({
    schemaVersion: 1,
    id: 'test-store',
    name: 'Test Canvas Store',
    updatedAt: '2026-06-17T00:00:00.000Z',
    plugins: [],
    skills: [
      {
        name: 'test-library-skill',
        displayName: 'Test Library Skill',
        description: 'Temporary skill store test.',
        category: 'Testing',
        latestVersion: '1.0.0',
        icon: 'skills/test-library-skill/1.0.0/icon.svg',
        brandColor: '#2563EB',
        license: 'MIT',
        versions: {
          '1.0.0': {
            version: '1.0.0',
            downloadUrl: pathToFileURL(zipPath).toString(),
            packagePath: packagePrefix,
            checksum: `sha256:${checksum}`,
            releasedAt: '2026-06-17T00:00:00.000Z',
          },
        },
      },
    ],
  }, null, 2));

  return registryPath;
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-test-data-'));
  const skillRoot = await createTestSkillPackage();
  let storeRoot: string | null = null;
  process.env.CANVAS_DATA_ROOT = dataRoot;

  try {
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    await writeFile(
      path.join(dataRoot, 'settings', 'pi-runtime-config.json'),
      JSON.stringify(DEFAULT_PI_CONFIG, null, 2),
    );

    const { computeCanvasPluginChecksum } = await import('../app/lib/plugins/canvas-plugin-registry');
    const {
      installCanvasSkillFromStore,
      listCanvasSkillStore,
      readCanvasSkillRegistry,
      removeCanvasSkillRegistryRecord,
      restoreCanvasSkill,
    } = await import('../app/lib/skills/canvas-skill-store');
    const { deleteSkillDirectory, loadSkillsFromDisk } = await import('../app/lib/skills/skill-loader');

    const checksum = await computeCanvasPluginChecksum(skillRoot);
    const registryPath = await createStoreArchive(skillRoot, checksum);
    storeRoot = path.dirname(registryPath);
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(registryPath).toString();

    let store = await listCanvasSkillStore();
    assert.equal(store.skills.length, 1);
    assert.equal(store.skills[0].name, 'test-library-skill');
    assert.equal(store.skills[0].installed.installed, false);
    assert.equal(store.pagination.totalItems, 1);
    assert.equal(store.stats.available, 1);

    const paginatedStore = await listCanvasSkillStore({ page: 1, pageSize: 1, query: 'library', state: 'available' });
    assert.equal(paginatedStore.skills.length, 1);
    assert.equal(paginatedStore.pagination.pageSize, 1);
    assert.equal(paginatedStore.pagination.totalItems, 1);

    const install = await installCanvasSkillFromStore('test-library-skill', undefined, { enable: true });
    assert.equal(install.success, true, install.error);

    const installedSkills = await loadSkillsFromDisk();
    assert.equal(installedSkills.some((skill) => skill.name === 'test-library-skill' && !skill.plugin), true);

    let skillRegistry = await readCanvasSkillRegistry();
    assert.equal(skillRegistry.skills['test-library-skill'].version, '1.0.0');
    assert.equal(skillRegistry.skills['test-library-skill'].sourceType, 'store');

    store = await listCanvasSkillStore();
    assert.equal(store.skills[0].installed.installed, true);
    assert.equal(store.skills[0].installed.version, '1.0.0');
    assert.equal(store.skills[0].installed.modified, false);

    const installedSkillPath = path.join(dataRoot, 'skills', 'test-library-skill', 'SKILL.md');
    await fs.appendFile(installedSkillPath, '\nLocal test edit.\n', 'utf-8');
    store = await listCanvasSkillStore();
    assert.equal(store.skills[0].installed.modified, true);
    assert.equal(store.skills[0].installed.restoreAvailable, true);

    const restore = await restoreCanvasSkill('test-library-skill', { prefer: 'store', enable: true });
    assert.equal(restore.success, true, restore.error);
    assert.ok(restore.backupPath);

    const restoredContent = await fs.readFile(installedSkillPath, 'utf-8');
    assert.equal(restoredContent.includes('Local test edit.'), false);
    skillRegistry = await readCanvasSkillRegistry();
    assert.equal(skillRegistry.skills['test-library-skill'].sourceType, 'store');

    const deleteResult = await deleteSkillDirectory('test-library-skill');
    assert.equal(deleteResult.success, true, deleteResult.error);
    await removeCanvasSkillRegistryRecord('test-library-skill');
    skillRegistry = await readCanvasSkillRegistry();
    assert.equal(skillRegistry.skills['test-library-skill'], undefined);

    store = await listCanvasSkillStore();
    assert.equal(store.skills[0].installed.installed, false);
    assert.equal(store.skills[0].installed.version, undefined);

    console.log('canvas skill store test passed');
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
    await fs.rm(skillRoot, { recursive: true, force: true });
    if (storeRoot) {
      await fs.rm(storeRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
