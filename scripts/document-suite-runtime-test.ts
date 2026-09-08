import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

async function main() {
  const root = process.cwd();
  const skillNames = ['docx', 'xlsx', 'pptx', 'pdf'] as const;
  const [dockerfile, ...skillBodies] = await Promise.all([
    fs.readFile(path.join(root, 'Dockerfile'), 'utf8'),
    ...skillNames.map((name) => fs.readFile(path.join(root, 'seed_skills', name, 'SKILL.md'), 'utf8')),
  ]);

  assert.match(dockerfile, /COPY --from=builder \/app\/seed_plugins \.\/seed_plugins/);
  assert.match(dockerfile, /pandoc libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui libreoffice-draw-nogui/);

  for (const [index, body] of skillBodies.entries()) {
    assert.match(body, /CANVAS_AGENT_TEMP_DIR/, `${skillNames[index]} must route intermediate work to scratch`);
    assert.match(body, /`copy_path` or `move_path`/, `${skillNames[index]} must explain final artifact promotion`);
  }

  const [docx, xlsx, pptx, pdf] = skillBodies;
  assert.match(docx, /Pandoc for simple, text-oriented Markdown-to-DOCX/);
  assert.match(docx, /Do not use it for format-faithful edits/);
  assert.match(xlsx, /reopen that result with `openpyxl`/);
  assert.match(pptx, /render every PDF\s+page with Poppler/);
  assert.doesNotMatch(pdf, /reportlab/i);
  assert.match(pdf, /bundled headless Chromium/);

  for (const name of ['docx', 'xlsx', 'pptx'] as const) {
    const referencePath = path.join(root, 'seed_skills', name, 'references', 'headless-libreoffice.md');
    const reference = await fs.readFile(referencePath, 'utf8');
    assert.match(skillBodies[skillNames.indexOf(name)], /references\/headless-libreoffice\.md/);
    assert.match(reference, /mktemp -d/);
    assert.match(reference, /-env:UserInstallation=file:\/\//);
    assert.match(reference, /--headless --nologo --nodefault --nolockcheck --nofirststartwizard/);
    assert.match(reference, /CANVAS_AGENT_TEMP_DIR/);
  }

  console.log('document-suite-runtime-test: ok');
}

void main();
