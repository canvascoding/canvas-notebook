import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PDFParse } from 'pdf-parse';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

function pdfString(value: string): string {
  return value.replace(/[\\()]/gu, '\\$&');
}

function createStructuredPdf(): Buffer {
  const pageOneStream = [
    'BT /F2 24 Tf 72 740 Td (Quarterly Report) Tj ET',
    'BT /F1 12 Tf 72 705 Td (Revenue increased in the current quarter.) Tj ET',
    `BT /F1 12 Tf 72 680 Td (${pdfString('- First item')}) Tj ET`,
  ].join('\n');
  const pageTwoStream = [
    'BT /F2 18 Tf 72 740 Td (Appendix) Tj ET',
    'BT /F1 12 Tf 72 705 Td (Second page details.) Tj ET',
  ].join('\n');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [5 0 R 7 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
    '5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 6 0 R >>\nendobj\n',
    `6 0 obj\n<< /Length ${Buffer.byteLength(pageOneStream, 'latin1')} >>\nstream\n${pageOneStream}\nendstream\nendobj\n`,
    '7 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 8 0 R >>\nendobj\n',
    `8 0 obj\n<< /Length ${Buffer.byteLength(pageTwoStream, 'latin1')} >>\nstream\n${pageTwoStream}\nendstream\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function pdfPageCount(filePath: string): Promise<number> {
  const parser = new PDFParse({ data: await fs.readFile(filePath) });
  try {
    return (await parser.getInfo()).total;
  } finally {
    await parser.destroy();
  }
}

async function withServerModuleMocks<T>(run: () => Promise<T>): Promise<T> {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only' || request === '@earendil-works/pi-agent-core') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return await run();
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function main() {
  const pythonPath = process.env.CANVAS_PYTHON_PATH?.trim();
  assert.ok(pythonPath, 'CANVAS_PYTHON_PATH must point to a Python runtime with pypdf and pdfplumber.');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pdf-tools-test-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const qaDir = process.env.CANVAS_PDF_TOOL_QA_DIR?.trim();
  process.env.DATA = tempDir;
  process.env.CANVAS_DATA_ROOT = tempDir;
  process.env.CANVAS_APP_ROOT = process.cwd();
  process.env.INTEGRATIONS_ENV_PATH = path.join(tempDir, 'secrets', 'Canvas-Integrations.env');
  process.env.CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB = '0';
  process.env.CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU = '0';

  try {
    await fs.mkdir(path.join(workspaceDir, 'pdf'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'pdf', 'structured.pdf'), createStructuredPdf());

    await withServerModuleMocks(async () => {
      const { createPdfTools } = await import('../app/lib/pi/pdf-tools');
      const { disposePdfBrowser } = await import('../app/lib/pdf/browser');
      const tools = new Map(createPdfTools().map((tool) => [tool.name, tool]));
      const createPdf = tools.get('create_pdf');
      const pdfToMarkdown = tools.get('pdf_to_markdown');
      const splitPdf = tools.get('split_pdf');
      const editPdfPages = tools.get('edit_pdf_pages');
      assert.ok(createPdf);
      assert.ok(pdfToMarkdown);
      assert.ok(splitPdf);
      assert.ok(editPdfPages);

      try {
        const created = await createPdf.execute('create-pdf', {
          markdown: [
            '# PDF Tool Integration',
            '',
            'This paragraph contains **bold text** and *italic text*.',
            '',
            '## Results',
            '',
            '- First result',
            '- Second result',
            '',
            '| Metric | Value |',
            '| --- | ---: |',
            '| Coverage | 100% |',
          ].join('\n'),
          outputPath: 'pdf/from-markdown.pdf',
          title: 'PDF Tool Integration',
        });
        assert.doesNotMatch(getText(created), /^Error:/u);
        const createdPath = path.join(workspaceDir, 'pdf', 'from-markdown.pdf');
        assert.equal(await pdfPageCount(createdPath), 1);
        assert.equal((await fs.readFile(createdPath)).subarray(0, 5).toString('latin1'), '%PDF-');

        const duplicateCreate = await createPdf.execute('create-pdf-duplicate', {
          markdown: '# Must not overwrite',
          outputPath: 'pdf/from-markdown.pdf',
        });
        assert.match(getText(duplicateCreate), /overwrite: true/u);

        const converted = await pdfToMarkdown.execute('pdf-to-markdown', {
          inputPath: 'pdf/from-markdown.pdf',
          outputPath: 'pdf/from-markdown.md',
        });
        assert.doesNotMatch(getText(converted), /^Error:/u);
        const convertedMarkdown = await fs.readFile(
          path.join(workspaceDir, 'pdf', 'from-markdown.md'),
          'utf8',
        );
        assert.match(convertedMarkdown, /<!-- page: 1 -->/u);
        assert.match(convertedMarkdown, /^# .+PDF Tool Integration/mu);
        assert.match(convertedMarkdown, /\*\*bold text\*\*/u);
        assert.match(convertedMarkdown, /\*italic text\*/u);
        assert.match(convertedMarkdown, /\| Metric \| Value \|/u);
        assert.match(convertedMarkdown, /- First result/u);

        const split = await splitPdf.execute('split-pdf', {
          inputPath: 'pdf/structured.pdf',
          parts: [
            { pages: '1', outputPath: 'pdf/part-one.pdf' },
            { pages: '2', outputPath: 'pdf/part-two.pdf' },
          ],
        });
        assert.doesNotMatch(getText(split), /^Error:/u);
        assert.equal(await pdfPageCount(path.join(workspaceDir, 'pdf', 'part-one.pdf')), 1);
        assert.equal(await pdfPageCount(path.join(workspaceDir, 'pdf', 'part-two.pdf')), 1);

        const edited = await editPdfPages.execute('edit-pdf-pages', {
          inputPath: 'pdf/structured.pdf',
          outputPath: 'pdf/reordered.pdf',
          pageOrder: [2, 1],
        });
        assert.doesNotMatch(getText(edited), /^Error:/u);
        assert.equal(await pdfPageCount(path.join(workspaceDir, 'pdf', 'reordered.pdf')), 2);

        const reorderedMarkdownResult = await pdfToMarkdown.execute('reordered-to-markdown', {
          inputPath: 'pdf/reordered.pdf',
          outputPath: 'pdf/reordered.md',
        });
        assert.doesNotMatch(getText(reorderedMarkdownResult), /^Error:/u);
        const reorderedMarkdown = await fs.readFile(
          path.join(workspaceDir, 'pdf', 'reordered.md'),
          'utf8',
        );
        assert.ok(
          reorderedMarkdown.indexOf('Appendix') < reorderedMarkdown.indexOf('Quarterly Report'),
          'pageOrder must be reflected in converted Markdown',
        );

        const rotated = await editPdfPages.execute('rotate-pdf-page', {
          inputPath: 'pdf/structured.pdf',
          outputPath: 'pdf/rotated.pdf',
          rotations: [{ pages: '1', degrees: 90 }],
        });
        assert.doesNotMatch(getText(rotated), /^Error:/u);
        assert.equal(await pdfPageCount(path.join(workspaceDir, 'pdf', 'rotated.pdf')), 2);
      } finally {
        await disposePdfBrowser('PDF tools integration test complete');
      }
    });

  } finally {
    if (qaDir) {
      await fs.cp(workspaceDir, qaDir, { recursive: true, force: true });
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log('pdf-tools-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
