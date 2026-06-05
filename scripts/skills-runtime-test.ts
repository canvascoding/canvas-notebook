import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const projectRoot = process.cwd();
  const projectNodeModules = path.join(projectRoot, 'node_modules');
  const pptxgenPath = path.join(projectNodeModules, 'pptxgenjs');
  assert.ok(existsSync(pptxgenPath), 'pptxgenjs must be installed in project node_modules');

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-skills-runtime-'));

  try {
    const dataRoot = path.join(tempRoot, 'data');
    const workspaceDir = path.join(dataRoot, 'workspace', 'pptx-skill');
    await mkdir(workspaceDir, { recursive: true });
    await symlink(projectNodeModules, path.join(dataRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

    const skillScriptPath = path.join(workspaceDir, 'generate-pptx.cjs');
    await writeFile(
      skillScriptPath,
      `
const fs = require('node:fs');
const path = require('node:path');
const pptxgen = require('pptxgenjs');

async function main() {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Canvas Notebook';
  pptx.subject = 'Skill runtime dependency test';
  pptx.title = 'Skill Runtime Test';

  const slide = pptx.addSlide();
  slide.addText('pptxgenjs runtime ok', {
    x: 0.6,
    y: 0.6,
    w: 8.8,
    h: 0.8,
    fontSize: 28,
    bold: true,
    color: '1f2937',
  });

  const outputPath = path.join(process.cwd(), 'skill-runtime-test.pptx');
  await pptx.writeFile({ fileName: outputPath });

  if (!fs.existsSync(outputPath)) {
    throw new Error('PPTX output was not created');
  }

  console.log(require.resolve('pptxgenjs'));
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    );

    const result = spawnSync(process.execPath, [skillScriptPath], {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: '',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /pptxgenjs/);

    const outputPath = path.join(workspaceDir, 'skill-runtime-test.pptx');
    assert.ok(existsSync(outputPath), 'workspace skill script should create a pptx file');
    assert.ok(statSync(outputPath).size > 0, 'generated pptx file should not be empty');

    console.log('skills runtime dependency bridge ok');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
