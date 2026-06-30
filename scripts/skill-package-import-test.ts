import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
        throw new Error('pi-ai should not be called by the skill package import test.');
      },
      streamSimple: async function* () {
        throw new Error('pi-ai should not be streamed by the skill package import test.');
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

function skillContent(name: string, version = '1.0.0'): string {
  return `---
name: ${name}
description: "Temporary skill package import test skill."
metadata:
  version: "${version}"
---

# ${name}

Test instructions.
`;
}

async function createZip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function assertFileIncludes(filePath: string, expected: string): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');
  assert.equal(content.includes(expected), true, `${filePath} did not include expected content`);
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-package-import-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;

  try {
    const {
      importSkillPackage,
      SkillPackageImportError,
    } = await import('../app/lib/skills/skill-package-import');

    const scope = { userId: 'skill-package-user' };

    const textImport = await importSkillPackage({
      kind: 'text',
      content: skillContent('text-upload-skill'),
      sourceName: 'test-text',
    }, { scope, updatedBy: 'tester@example.com' });
    assert.equal(textImport.name, 'text-upload-skill');
    await assertFileIncludes(textImport.path, 'Test instructions.');

    const rootZip = await createZip({
      'SKILL.md': skillContent('root-zip-skill'),
      'agents/canvas.yaml': 'interface:\n  display_name: Root Zip Skill\n',
      'scripts/helper.js': 'export const ok = true;\n',
    });
    const rootZipImport = await importSkillPackage({
      kind: 'archive',
      sourceName: 'root-zip-skill.zip',
      bytes: rootZip,
    }, { scope });
    assert.equal(rootZipImport.name, 'root-zip-skill');
    await assertFileIncludes(path.join(path.dirname(rootZipImport.path), 'scripts', 'helper.js'), 'ok = true');

    const wrapperZip = await createZip({
      'wrapped-skill/SKILL.md': skillContent('wrapped-skill'),
      'wrapped-skill/reference/notes.md': 'wrapper asset\n',
    });
    const wrapperImport = await importSkillPackage({
      kind: 'archive',
      sourceName: 'wrapped-skill.zip',
      bytes: wrapperZip,
    }, { scope });
    assert.equal(wrapperImport.name, 'wrapped-skill');
    assert.equal(path.basename(path.dirname(wrapperImport.path)), 'wrapped-skill');
    await assertFileIncludes(path.join(path.dirname(wrapperImport.path), 'reference', 'notes.md'), 'wrapper asset');

    const folderImport = await importSkillPackage({
      kind: 'folder',
      sourceName: 'folder-skill',
      files: [
        {
          relativePath: 'folder-skill/SKILL.md',
          bytes: Buffer.from(skillContent('folder-skill'), 'utf-8'),
        },
        {
          relativePath: 'folder-skill/assets/example.txt',
          bytes: Buffer.from('folder asset\n', 'utf-8'),
        },
      ],
    }, { scope });
    assert.equal(folderImport.name, 'folder-skill');
    await assertFileIncludes(path.join(path.dirname(folderImport.path), 'assets', 'example.txt'), 'folder asset');

    await assert.rejects(
      importSkillPackage({
        kind: 'archive',
        sourceName: 'missing-skill.zip',
        bytes: await createZip({ 'README.md': '# Missing skill\n' }),
      }, { scope }),
      (error) => error instanceof SkillPackageImportError
        && error.message === 'Skill package must contain a SKILL.md file.',
    );

    await assert.rejects(
      importSkillPackage({
        kind: 'folder',
        sourceName: 'unsafe-folder',
        files: [
          {
            relativePath: '../evil.txt',
            bytes: Buffer.from('evil\n', 'utf-8'),
          },
        ],
      }, { scope }),
      (error) => error instanceof SkillPackageImportError
        && error.message.includes('unsafe path'),
    );
    await assert.rejects(fs.stat(path.join(dataRoot, 'users', 'evil.txt')));

    await assert.rejects(
      importSkillPackage({
        kind: 'archive',
        sourceName: 'multi-skill.zip',
        bytes: await createZip({
          'first/SKILL.md': skillContent('first-skill'),
          'second/SKILL.md': skillContent('second-skill'),
        }),
      }, { scope }),
      (error) => error instanceof SkillPackageImportError
        && error.message.includes('multiple SKILL.md files'),
    );

    await assert.rejects(
      importSkillPackage({
        kind: 'text',
        content: skillContent('wrapped-skill'),
      }, { scope }),
      (error) => error instanceof SkillPackageImportError
        && error.statusCode === 409
        && error.message.includes('already exists'),
    );

    console.log('skill package import test passed');
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
