import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { PDFParse } from 'pdf-parse';

function pdfString(value: string): string {
  return value.replace(/[\\()]/gu, '\\$&');
}

function createStructuredPdf(): Buffer {
  const pageOneStream = [
    'BT /F2 24 Tf 72 740 Td (Quarterly Report) Tj ET',
    'BT /F1 12 Tf 72 705 Td (Revenue increased in the current quarter.) Tj ET',
    `BT /F1 12 Tf 72 680 Td (${pdfString('- First item')}) Tj ET`,
    '72 620 m 400 620 l S',
    '72 590 m 400 590 l S',
    '72 560 m 400 560 l S',
    '72 620 m 72 560 l S',
    '250 620 m 250 560 l S',
    '400 620 m 400 560 l S',
    'BT /F2 10 Tf 82 600 Td (Metric) Tj ET',
    'BT /F2 10 Tf 260 600 Td (Value) Tj ET',
    'BT /F1 10 Tf 82 570 Td (Revenue) Tj ET',
    'BT /F1 10 Tf 260 570 Td (42) Tj ET',
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

async function withServerOnlyModuleMock<T>(run: () => Promise<T>): Promise<T> {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };
  try {
    return await run();
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function pdfPageCount(buffer: Buffer): Promise<number> {
  const parser = new PDFParse({ data: buffer });
  try {
    return (await parser.getInfo()).total;
  } finally {
    await parser.destroy();
  }
}

async function main() {
  const pythonPath = process.env.CANVAS_PYTHON_PATH?.trim();
  assert.ok(pythonPath, 'CANVAS_PYTHON_PATH must point to a Python runtime with pypdf and pdfplumber.');
  process.env.CANVAS_APP_ROOT = process.cwd();

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pdf-runtime-test-'));
  try {
    const inputPath = path.join(tempDir, 'structured.pdf');
    await fs.writeFile(inputPath, createStructuredPdf());
    await withServerOnlyModuleMock(async () => {
      const {
        convertPdfFileToMarkdown,
        transformPdfFile,
      } = await import('../app/lib/pdf/tool-runtime');
      const converted = await convertPdfFileToMarkdown({
        inputPath,
        sourceLabel: 'docs/structured.pdf',
      });
      assert.equal(converted.metadata.pages, 2);
      assert.match(converted.markdown, /source: "docs\/structured\.pdf"/u);
      assert.match(converted.markdown, /<!-- page: 1 -->/u);
      assert.match(converted.markdown, /<!-- page: 2 -->/u);
      assert.match(converted.markdown, /# \*\*Quarterly Report\*\*/u);
      assert.match(converted.markdown, /- First item/u);
      assert.match(converted.markdown, /\| Metric \| Value \|/u);
      assert.match(converted.markdown, /\| Revenue \| 42 \|/u);

      const transformed = await transformPdfFile({
        inputPath,
        outputs: [
          { pages: [2] },
          { pages: [2, 1], rotations: [{ pages: [1], degrees: 90 }] },
        ],
      });
      assert.equal(transformed.sourcePageCount, 2);
      assert.equal(await pdfPageCount(transformed.outputs[0].content), 1);
      assert.equal(await pdfPageCount(transformed.outputs[1].content), 2);
      assert.deepEqual(transformed.outputs[1].pages, [2, 1]);
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  console.log('pdf-tool-runtime-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
