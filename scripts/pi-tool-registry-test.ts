import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StudioGenerateRequest } from '../app/lib/integrations/studio-generation-service';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

function getImages(result: unknown): Array<{ type?: string; data?: string; mimeType?: string }> {
  const content = (result as { content?: Array<{ type?: string; data?: string; mimeType?: string }> }).content;
  return content?.filter((item) => item.type === 'image') || [];
}

function createSimplePdfPages(texts: string[]): string {
  const pageObjectNumbers = texts.map((_, index) => 4 + index * 2);
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjectNumbers.map((objectNumber) => `${objectNumber} 0 R`).join(' ')}] /Count ${texts.length} >>\nendobj\n`,
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  texts.forEach((text, index) => {
    const escapedText = text.replace(/[\\()]/g, '\\$&');
    const stream = `BT /F1 24 Tf 100 700 Td (${escapedText}) Tj ET`;
    const pageObjectNumber = pageObjectNumbers[index];
    const contentObjectNumber = pageObjectNumber + 1;
    objects.push(
      `${pageObjectNumber} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectNumber} 0 R >>\nendobj\n`,
      `${contentObjectNumber} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });

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
  return pdf;
}

function createSimplePdf(text: string): string {
  return createSimplePdfPages([text]);
}

async function main() {
  process.env.QMD_ENABLED = 'false';
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-data-'));
  process.env.DATA = dataDir;
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.INTEGRATIONS_ENV_PATH = path.join(dataDir, 'secrets', 'Canvas-Integrations.env');

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  const { enableToolInConfig, getDefaultEnabledToolNames, serializeEnabledToolNames } = await import('../app/lib/pi/enabled-tools');
  const { detectUnsafeBashCommand } = await import('../app/lib/pi/agent-file-operations');
  const { createToolLoopGuard } = await import('../app/lib/pi/tool-loop-guard');
  const { buildPiToolRegistry, createRipgrepTool, createStudioGenerateImageTool, createStudioGenerateVideoTool, getPiToolMetadata, getPiTools, piTools } = await import('../app/lib/pi/tool-registry');

  const studioCalls: StudioGenerateRequest[] = [];
  const studioImageCalls: StudioGenerateRequest[] = [];
  const studioImageMediaUrl = '/api/studio/media/studio/outputs/studio-gen-ente-statt-affe-0-2026-05-29T15-38-00-000Z-test.jpg';
  const studioImageTool = createStudioGenerateImageTool({
    userId: 'test-user',
    executeStudioGenerationFn: async (_userId, body) => {
      studioImageCalls.push(body);
      return {
        generationId: 'studio-image-generation',
        status: 'completed',
        mode: body.mode || 'image',
        prompt: body.prompt,
        outputs: [
          {
            id: 'studio-image-output',
            variationIndex: 0,
            filePath: 'studio-gen-ente-statt-affe-0-2026-05-29T15-38-00-000Z-test.jpg',
            mediaUrl: studioImageMediaUrl,
            mimeType: 'image/jpeg',
            fileSize: 2345,
          },
        ],
      };
    },
  });
  const studioTool = createStudioGenerateVideoTool({
    userId: 'test-user',
    executeStudioGenerationFn: async (_userId, body) => {
      studioCalls.push(body);
      return {
        generationId: 'studio-seedance-generation',
        status: 'completed',
        mode: body.mode || 'video',
        prompt: body.prompt,
        outputs: [
          {
            id: 'studio-output',
            variationIndex: 0,
            filePath: 'generated.mp4',
            mediaUrl: '/api/studio/media/generated.mp4',
            mimeType: 'video/mp4',
            fileSize: 1234,
          },
        ],
      };
    },
  });
  const rgTool = createRipgrepTool();
  const readTool = piTools.find((tool) => tool.name === 'read');
  const writeTool = piTools.find((tool) => tool.name === 'write');
  const editFileTool = piTools.find((tool) => tool.name === 'edit_file');
  const applyPatchTool = piTools.find((tool) => tool.name === 'apply_patch');
  const copyPathTool = piTools.find((tool) => tool.name === 'copy_path');
  const movePathTool = piTools.find((tool) => tool.name === 'move_path');
  const deletePathTool = piTools.find((tool) => tool.name === 'delete_path');
  const listFileSnapshotsTool = piTools.find((tool) => tool.name === 'list_file_snapshots');
  const restoreFileSnapshotTool = piTools.find((tool) => tool.name === 'restore_file_snapshot');
  const lsTool = piTools.find((tool) => tool.name === 'ls');
  const bashTool = piTools.find((tool) => tool.name === 'bash');
  const webFetchTool = piTools.find((tool) => tool.name === 'web_fetch');
  const browserTool = piTools.find((tool) => tool.name === 'browser');
  const grepTool = piTools.find((tool) => tool.name === 'grep');
  const globTool = piTools.find((tool) => tool.name === 'glob');

  assert.equal(piTools.some((tool) => tool.name === 'rg'), true);
  assert.equal(piTools.some((tool) => tool.name === 'qmd'), false);
  assert.equal(piTools.some((tool) => tool.name === 'qmd_search'), false);
  assert.ok(readTool);
  assert.ok(writeTool);
  assert.ok(editFileTool);
  assert.ok(applyPatchTool);
  assert.ok(copyPathTool);
  assert.ok(movePathTool);
  assert.ok(deletePathTool);
  assert.ok(listFileSnapshotsTool);
  assert.ok(restoreFileSnapshotTool);
  assert.ok(lsTool);
  assert.ok(bashTool);
  assert.ok(webFetchTool);
  assert.ok(browserTool);
  assert.ok(grepTool);
  assert.ok(globTool);
  const browserParametersJson = JSON.stringify(browserTool.parameters);
  assert.match(browserParametersJson, /evaluate/);
  assert.match(browserParametersJson, /eval/);
  assert.match(browserParametersJson, /script/);
  assert.match(browserParametersJson, /mutates/);

  const secretsDir = path.join(dataDir, 'secrets');
  const secretFile = path.join(secretsDir, 'Canvas-Integrations.env');
  await fs.mkdir(secretsDir, { recursive: true });
  await fs.writeFile(secretFile, 'OPENROUTER_API_KEY=should-not-leak\n', 'utf8');

  const blockedReadResult = await readTool.execute('read-secret', { path: secretFile });
  assert.match(getText(blockedReadResult), /restricted/i);

  const blockedLsResult = await lsTool.execute('ls-secret', { path: secretsDir });
  assert.match(getText(blockedLsResult), /restricted/i);

  const blockedRgResult = await rgTool.execute('rg-secret', {
    pattern: 'OPENROUTER',
    path: secretsDir,
  });
  assert.match(getText(blockedRgResult), /restricted/i);

  const blockedBashResult = await bashTool.execute('bash-secret-env', { command: 'printenv' });
  assert.match(getText(blockedBashResult), /environment variables|restricted secret paths/i);

  const workspaceDir = path.join(dataDir, 'workspace');
  await fs.mkdir(path.join(workspaceDir, 'hausarbeit'), { recursive: true });
  const markdownPath = path.join(workspaceDir, 'hausarbeit', '00_Projektplan_Team6_v2.md');
  await fs.writeFile(markdownPath, [
    '# Projektplan',
    '',
    '| Nr. | Frage | Status |',
    '| --- | --- | --- |',
    '| 1 | Thema final? | offen |',
    '| 6 | Welche Zitierweise? | offen |',
    '',
    '- Einheitliche Zitierweise (Harvard oder Fußnoten - noch zu klären!)',
    '- Abgabe prüfen',
    '',
  ].join('\n'), 'utf8');

  const truncatedReadResult = await readTool.execute('read-markdown-truncated', {
    path: 'hausarbeit/00_Projektplan_Team6_v2.md',
    maxChars: 12,
  });
  assert.match(getText(truncatedReadResult), /^# Projektpla/);
  assert.match(getText(truncatedReadResult), /content truncated after 12 characters/);
  assert.equal((truncatedReadResult.details as { type: string; truncated: boolean }).type, 'text');
  assert.equal((truncatedReadResult.details as { type: string; truncated: boolean }).truncated, true);

  await fs.mkdir(path.join(workspaceDir, 'docs'), { recursive: true });
  const pdfPath = path.join(workspaceDir, 'docs', 'case.pdf');
  await fs.writeFile(pdfPath, createSimplePdf('Canvas PDF Text'), 'latin1');
  const pdfReadResult = await readTool.execute('read-pdf', { path: 'docs/case.pdf' });
  assert.match(getText(pdfReadResult), /Canvas PDF Text/);
  assert.doesNotMatch(getText(pdfReadResult), /^%PDF-/);
  assert.equal((pdfReadResult.details as { type: string; pages: number }).type, 'pdf');
  assert.equal((pdfReadResult.details as { type: string; pages: number }).pages, 1);
  assert.equal(getImages(pdfReadResult).length, 1);
  assert.equal(getImages(pdfReadResult)[0].mimeType, 'image/png');
  assert.match(getText(pdfReadResult), /Rendered PDF page image/);

  const multiPagePdfPath = path.join(workspaceDir, 'docs', 'multi-page.pdf');
  await fs.writeFile(multiPagePdfPath, createSimplePdfPages(['Page One Text', 'Page Two Diagram', 'Page Three Appendix']), 'latin1');
  const limitedPdfReadResult = await readTool.execute('read-pdf-limited-pages', {
    path: 'docs/multi-page.pdf',
    maxPdfTextPages: 2,
    includePdfImages: false,
  });
  assert.match(getText(limitedPdfReadResult), /Page One Text/);
  assert.match(getText(limitedPdfReadResult), /Page Two Diagram/);
  assert.doesNotMatch(getText(limitedPdfReadResult), /Page Three Appendix/);
  assert.match(getText(limitedPdfReadResult), /limited to the first 2 of 3 pages/);
  assert.equal((limitedPdfReadResult.details as { textPageLimited: boolean }).textPageLimited, true);
  assert.deepEqual((limitedPdfReadResult.details as { textPagesRead: number[] }).textPagesRead, [1, 2]);
  assert.equal(getImages(limitedPdfReadResult).length, 0);

  const targetedPdfImageResult = await readTool.execute('read-pdf-targeted-image', {
    path: 'docs/multi-page.pdf',
    pdfTextPages: [2],
    includePdfImages: true,
    pdfImagePages: [2],
    maxPdfImages: 1,
  });
  assert.match(getText(targetedPdfImageResult), /Page Two Diagram/);
  assert.doesNotMatch(getText(targetedPdfImageResult), /Page One Text/);
  assert.equal(getImages(targetedPdfImageResult).length, 1);
  assert.deepEqual((targetedPdfImageResult.details as { images: Array<{ pageNumber: number }> }).images.map((image) => image.pageNumber), [2]);

  const hugePdfPath = path.join(workspaceDir, 'docs', 'huge.pdf');
  await fs.writeFile(hugePdfPath, '%PDF-1.4\n', 'latin1');
  await fs.truncate(hugePdfPath, 101 * 1024 * 1024);
  const hugePdfReadResult = await readTool.execute('read-huge-pdf', { path: 'docs/huge.pdf' });
  assert.match(getText(hugePdfReadResult), /PDF is too large/);
  assert.equal((hugePdfReadResult.details as { error: string }).error, 'pdf_too_large');

  const binaryPath = path.join(workspaceDir, 'docs', 'archive.bin');
  await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  const binaryReadResult = await readTool.execute('read-binary', { path: 'docs/archive.bin' });
  assert.match(getText(binaryReadResult), /Unsupported binary file/);
  assert.equal((binaryReadResult.details as { type: string }).type, 'binary');

  const editResult = await editFileTool.execute('edit-markdown', {
    path: 'hausarbeit/00_Projektplan_Team6_v2.md',
    oldText: '| 6 | Welche Zitierweise? | offen |\n',
    newText: '',
    expectedOccurrences: 1,
  });
  const editText = getText(editResult);
  assert.match(editText, /Updated file: hausarbeit\/00_Projektplan_Team6_v2\.md/);
  assert.match(editText, /Validation: passed/);
  assert.match(editText, /markdown-tables/);
  assert.match(editText, /Snapshot: /);
  assert.doesNotMatch(await fs.readFile(markdownPath, 'utf8'), /Welche Zitierweise/);

  const brokenMarkdownResult = await editFileTool.execute('edit-broken-markdown', {
    path: 'hausarbeit/00_Projektplan_Team6_v2.md',
    oldText: '| 1 | Thema final? | offen |',
    newText: '| 1 | Thema final? | offen | extra |',
    expectedOccurrences: 1,
  });
  assert.match(getText(brokenMarkdownResult), /validation failed/i);
  assert.doesNotMatch(await fs.readFile(markdownPath, 'utf8'), /extra/);

  const snapshotsResult = await listFileSnapshotsTool.execute('list-snapshots', {
    path: 'hausarbeit/00_Projektplan_Team6_v2.md',
    limit: 10,
  });
  const snapshots = (snapshotsResult.details as { snapshots: Array<{ id: string; operation: string }> }).snapshots;
  const editSnapshot = snapshots.find((snapshot) => snapshot.operation === 'edit_file');
  assert.ok(editSnapshot);

  const restoreResult = await restoreFileSnapshotTool.execute('restore-snapshot', {
    snapshotId: editSnapshot.id,
  });
  assert.match(getText(restoreResult), /Updated file: hausarbeit\/00_Projektplan_Team6_v2\.md/);
  assert.match(await fs.readFile(markdownPath, 'utf8'), /Welche Zitierweise/);

  const jsonPath = path.join(workspaceDir, 'config.json');
  await fs.writeFile(jsonPath, '{\n  "enabled": false,\n  "name": "old"\n}\n', 'utf8');
  const patchResult = await applyPatchTool.execute('patch-json', {
    files: [
      {
        path: 'config.json',
        edits: [
          { oldText: '"enabled": false', newText: '"enabled": true', expectedOccurrences: 1 },
          { oldText: '"name": "old"', newText: '"name": "new"', expectedOccurrences: 1 },
        ],
      },
    ],
  });
  assert.match(getText(patchResult), /json-parse: JSON syntax OK/);
  assert.deepEqual(JSON.parse(await fs.readFile(jsonPath, 'utf8')), { enabled: true, name: 'new' });

  const invalidJsonResult = await applyPatchTool.execute('patch-invalid-json', {
    files: [
      {
        path: 'config.json',
        edits: [
          { oldText: '"name": "new"', newText: '"name": ', expectedOccurrences: 1 },
        ],
      },
    ],
  });
  assert.match(getText(invalidJsonResult), /validation failed/i);
  assert.deepEqual(JSON.parse(await fs.readFile(jsonPath, 'utf8')), { enabled: true, name: 'new' });

  const writeResult = await writeTool.execute('write-new-file', {
    path: 'notes/new.md',
    content: '# New File\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
  });
  assert.match(getText(writeResult), /Updated file: notes\/new\.md/);
  assert.match(getText(writeResult), /Snapshot: /);

  await fs.mkdir(path.join(workspaceDir, 'bulk-src', 'nested'), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, 'bulk-src', 'nested', 'a.txt'), 'alpha\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'bulk-src', 'b.txt'), 'beta\n', 'utf8');

  const copyResult = await copyPathTool.execute('copy-dir', {
    sourcePath: 'bulk-src',
    destinationPath: 'bulk-copy',
  });
  assert.match(getText(copyResult), /Operation: copy_path/);
  assert.match(getText(copyResult), /Snapshot: none/);
  assert.equal(await fs.readFile(path.join(workspaceDir, 'bulk-copy', 'nested', 'a.txt'), 'utf8'), 'alpha\n');

  const moveResult = await movePathTool.execute('move-file', {
    sourcePath: 'bulk-copy/b.txt',
    destinationPath: 'bulk-copy/c.txt',
  });
  assert.match(getText(moveResult), /Operation: move_path/);
  assert.equal(await fs.readFile(path.join(workspaceDir, 'bulk-copy', 'c.txt'), 'utf8'), 'beta\n');

  const deleteFileResult = await deletePathTool.execute('delete-file', {
    path: 'bulk-copy/c.txt',
  });
  assert.match(getText(deleteFileResult), /Operation: delete_path/);
  await assert.rejects(fs.stat(path.join(workspaceDir, 'bulk-copy', 'c.txt')));

  const deleteDirBlockedResult = await deletePathTool.execute('delete-dir-blocked', {
    path: 'bulk-copy',
  });
  assert.match(getText(deleteDirBlockedResult), /recursive/i);
  assert.ok(await fs.stat(path.join(workspaceDir, 'bulk-copy')));

  const deleteDirResult = await deletePathTool.execute('delete-dir', {
    path: 'bulk-copy',
    recursive: true,
  });
  assert.match(getText(deleteDirResult), /Operation: delete_path/);
  await assert.rejects(fs.stat(path.join(workspaceDir, 'bulk-copy')));

  await fs.mkdir(path.join(workspaceDir, 'multi-src', 'dir-one'), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, 'multi-src', 'one.txt'), 'one\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'multi-src', 'two.txt'), 'two\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'multi-src', 'dir-one', 'nested.txt'), 'nested\n', 'utf8');

  const multiCopyResult = await copyPathTool.execute('copy-many', {
    sourcePaths: ['multi-src/one.txt', 'multi-src/two.txt', 'multi-src/dir-one'],
    destinationPath: 'multi-copy',
  });
  assert.match(getText(multiCopyResult), /Sources: 3/);
  assert.equal(await fs.readFile(path.join(workspaceDir, 'multi-copy', 'one.txt'), 'utf8'), 'one\n');
  assert.equal(await fs.readFile(path.join(workspaceDir, 'multi-copy', 'two.txt'), 'utf8'), 'two\n');
  assert.equal(await fs.readFile(path.join(workspaceDir, 'multi-copy', 'dir-one', 'nested.txt'), 'utf8'), 'nested\n');

  const multiMoveResult = await movePathTool.execute('move-many', {
    sourcePaths: ['multi-copy/one.txt', 'multi-copy/two.txt'],
    destinationPath: 'multi-moved',
  });
  assert.match(getText(multiMoveResult), /Sources: 2/);
  assert.equal(await fs.readFile(path.join(workspaceDir, 'multi-moved', 'one.txt'), 'utf8'), 'one\n');
  assert.equal(await fs.readFile(path.join(workspaceDir, 'multi-moved', 'two.txt'), 'utf8'), 'two\n');
  await assert.rejects(fs.stat(path.join(workspaceDir, 'multi-copy', 'one.txt')));

  const multiDeleteResult = await deletePathTool.execute('delete-many', {
    paths: ['multi-moved/one.txt', 'multi-moved/two.txt', 'multi-copy/dir-one', 'multi-missing.txt'],
    recursive: true,
    ignoreMissing: true,
  });
  assert.match(getText(multiDeleteResult), /Sources: 4/);
  assert.match(getText(multiDeleteResult), /missing/);
  await assert.rejects(fs.stat(path.join(workspaceDir, 'multi-moved', 'one.txt')));
  await assert.rejects(fs.stat(path.join(workspaceDir, 'multi-copy', 'dir-one')));

  assert.equal(detectUnsafeBashCommand('cp -r /data/workspace/a /data/workspace/b'), null);
  assert.equal(detectUnsafeBashCommand('mv /data/workspace/a /data/workspace/b'), null);
  assert.equal(detectUnsafeBashCommand('rm -rf /data/workspace/a'), null);
  assert.match(detectUnsafeBashCommand("sed -i 's/a/b/' /data/workspace/file.md") || '', /sed/i);
  assert.match(detectUnsafeBashCommand('echo broken > /data/workspace/file.md') || '', /redirects/i);
  assert.match(detectUnsafeBashCommand('cd /data/workspace && echo broken > file.md') || '', /redirects/i);
  assert.equal(detectUnsafeBashCommand('cd /data/workspace/dsd-slides && nohup python3 -m http.server 8080 > /dev/null 2>&1 &'), null);
  assert.equal(detectUnsafeBashCommand('cat /data/workspace/file.md > /tmp/file.md'), null);

  const blockedSedResult = await bashTool.execute('bash-block-sed', {
    command: "sed -i 's/Projekt/Plan/' /data/workspace/hausarbeit/00_Projektplan_Team6_v2.md",
  });
  assert.match(getText(blockedSedResult), /edit_file|apply_patch|sed/i);

  const blockedRedirectResult = await bashTool.execute('bash-block-redirect', {
    command: "echo broken > /data/workspace/hausarbeit/00_Projektplan_Team6_v2.md",
  });
  assert.match(getText(blockedRedirectResult), /redirects|write|edit_file|apply_patch/i);

  const allowedNullRedirectResult = await bashTool.execute('bash-allow-null-redirect', {
    command: `cd ${JSON.stringify(path.join(workspaceDir, 'hausarbeit'))} && printf ok > /dev/null 2>&1 && echo done`,
  });
  assert.equal(getText(allowedNullRedirectResult).trim(), 'done');

  const loopGuard = createToolLoopGuard({ warningThreshold: 2, terminationThreshold: 3 });
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const repeatedFailureContext = ({
    assistantMessage: { role: 'assistant', content: [], api: 'test', provider: 'test', model: 'test', usage: emptyUsage, stopReason: 'toolCalls', timestamp: Date.now() },
    toolCall: { id: 'tool-loop-1', type: 'toolCall', name: 'bash', arguments: { command: 'echo broken > /data/workspace/file.md' } },
    args: { command: 'echo broken > /data/workspace/file.md' },
    result: {
      content: [{ type: 'text', text: 'Shell redirects that write workspace or agent files are blocked.' }],
      details: { error: 'Shell redirects that write workspace or agent files are blocked.' },
    },
    isError: false,
    context: { systemPrompt: '', messages: [], tools: [] },
  } as unknown) as Parameters<ReturnType<typeof createToolLoopGuard>['afterToolCall']>[0];
  assert.equal(loopGuard.afterToolCall(repeatedFailureContext), undefined);
  const warnedLoopResult = loopGuard.afterToolCall(repeatedFailureContext);
  assert.ok(warnedLoopResult);
  assert.equal(warnedLoopResult.isError, true);
  assert.equal(warnedLoopResult.terminate, false);
  assert.match(warnedLoopResult.content?.[0]?.type === 'text' ? warnedLoopResult.content[0].text : '', /Do not retry this exact same tool call/);
  const terminatedLoopResult = loopGuard.afterToolCall(repeatedFailureContext);
  assert.ok(terminatedLoopResult);
  assert.equal(terminatedLoopResult.terminate, true);
  assert.match(terminatedLoopResult.content?.[0]?.type === 'text' ? terminatedLoopResult.content[0].text : '', /stopped to avoid an infinite tool loop/);

  loopGuard.reset();
  assert.equal(loopGuard.afterToolCall(repeatedFailureContext), undefined);
  loopGuard.afterToolCall(repeatedFailureContext);
  const successContext = ({
    ...repeatedFailureContext,
    result: { content: [{ type: 'text', text: 'ok' }], details: {} },
    isError: false,
  } as unknown) as Parameters<ReturnType<typeof createToolLoopGuard>['afterToolCall']>[0];
  assert.equal(loopGuard.afterToolCall(successContext), undefined);
  assert.equal(loopGuard.afterToolCall(repeatedFailureContext), undefined);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-rg-tool-'));
  const matchFile = path.join(tempDir, 'match.ts');
  const otherFile = path.join(tempDir, 'other.md');
  await fs.writeFile(matchFile, 'const SearchToken = "needle";\nconst secondNeedle = "needle";\n', 'utf8');
  await fs.writeFile(otherFile, 'no interesting text here\n', 'utf8');

  const rgMatchResult = await rgTool.execute('rg-match', {
    pattern: 'needle',
    path: tempDir,
    glob: '*.ts',
    ignoreCase: true,
    maxResults: 5,
  });
  assert.match(getText(rgMatchResult), /match\.ts:1:const SearchToken = "needle";/);

  const rgNoMatchResult = await rgTool.execute('rg-empty', {
    pattern: 'definitely-not-here',
    path: tempDir,
  });
  assert.equal(getText(rgNoMatchResult), '(no matches found)');

  const rgInvalidPathResult = await rgTool.execute('rg-error', {
    pattern: 'needle',
    path: path.join(tempDir, 'missing-dir'),
  });
  assert.match(getText(rgInvalidPathResult), /^Error:/);

  const abortedController = new AbortController();
  abortedController.abort();

  const abortedRgResult = await rgTool.execute('rg-abort', {
    pattern: 'needle',
    path: tempDir,
  }, abortedController.signal);
  assert.match(getText(abortedRgResult), /aborted/i);

  const abortedBashResult = await bashTool.execute('bash-abort', {
    command: 'sleep 5',
  }, abortedController.signal);
  assert.match(getText(abortedBashResult), /aborted/i);

  const abortedWebFetchResult = await webFetchTool.execute('web-fetch-abort', {
    urls: ['https://example.com'],
  }, abortedController.signal);
  assert.match(getText(abortedWebFetchResult), /aborted/i);

  const abortedGrepResult = await grepTool.execute('grep-abort', {
    pattern: 'needle',
    path: tempDir,
  }, abortedController.signal);
  assert.match(getText(abortedGrepResult), /aborted/i);

  const abortedGlobResult = await globTool.execute('glob-abort', {
    pattern: '*.ts',
    path: tempDir,
  }, abortedController.signal);
  assert.match(getText(abortedGlobResult), /aborted/i);

  const studioImageResult = await studioImageTool.execute('studio-image', {
    prompt: 'Eine Ente statt einem Affen',
    provider: 'gemini',
  });
  const studioImageText = getText(studioImageResult);
  assert.match(studioImageText, /Studio image generation completed \(1 output/);
  assert.match(studioImageText, /Absolute copy source path: .*studio-gen-ente-statt-affe/);
  assert.match(studioImageText, /Studio reference path for later edits: studio\/outputs\/studio-gen-ente-statt-affe/);
  assert.match(studioImageText, /Browser render URL for Markdown: \/api\/studio\/media\/studio\/outputs\/studio-gen-ente-statt-affe/);
  assert.match(studioImageText, /Thumbnail preview URL \(UI only\): \/api\/files\/preview\?path=studio-gen-ente-statt-affe/);
  assert.match(studioImageText, /Markdown image \(copy exactly\): !\[studio-0\]\(\/api\/studio\/media\/studio\/outputs\/studio-gen-ente-statt-affe/);
  assert.match(studioImageText, /Do not invent, shorten, slugify, or rewrite the image URL/);
  assert.match(studioImageText, /The browser render URL and thumbnail preview URL are not filesystem paths/);
  assert.equal(studioImageCalls.length, 1);
  assert.equal(studioImageCalls[0].mode, 'image');

  const studioSeedanceResult = await studioTool.execute('studio-seedance', {
    prompt: 'A cinematic product reveal',
    provider: 'bytedance',
    model: 'bytedance/seedance-2',
    aspect_ratio: '21:9',
    resolution: '480p',
    duration: 15,
    generate_audio: false,
    web_search: true,
    nsfw_checker: true,
  });
  assert.match(getText(studioSeedanceResult), /Studio video generation completed \(1 output/);
  assert.equal(studioCalls.length, 1);
  assert.equal(studioCalls[0].provider, 'bytedance');
  assert.equal(studioCalls[0].model, 'bytedance/seedance-2');
  assert.equal(studioCalls[0].aspect_ratio, '21:9');
  assert.equal(studioCalls[0].video_resolution, '480p');
  assert.equal(studioCalls[0].video_duration, 15);
  assert.equal(studioCalls[0].video_generate_audio, false);
  assert.equal(studioCalls[0].video_web_search, true);
  assert.equal(studioCalls[0].video_nsfw_checker, true);

  // Verify skill tools are no longer registered in the tool registry
  const allTools = buildPiToolRegistry();
  const defaultEnabledTools = getDefaultEnabledToolNames(allTools.map((tool) => tool.name));
  assert.equal(defaultEnabledTools.has('mcp'), true);
  assert.equal(defaultEnabledTools.has('memory'), true);
  assert.equal(allTools.some((tool) => tool.name === 'memory'), true);
  assert.equal(defaultEnabledTools.has('delegate_task'), true);
  assert.equal(allTools.some((tool) => tool.name === 'delegate_task'), true);
  assert.equal(defaultEnabledTools.has('session_search'), true);
  assert.equal(allTools.some((tool) => tool.name === 'session_search'), true);
  assert.equal(defaultEnabledTools.has('web_search'), true);
  assert.equal(allTools.some((tool) => tool.name === 'web_search'), true);
  assert.equal(allTools.some((tool) => tool.name === 'studio_bulk_generate'), true);
  assert.equal(defaultEnabledTools.has('studio_bulk_generate'), false);
  assert.equal(allTools.some((tool) => tool.name === 'browser'), true);
  assert.equal(defaultEnabledTools.has('browser'), false);
  assert.equal((await getPiTools()).some((tool) => tool.name === 'studio_bulk_generate'), false);
  assert.equal((await getPiTools()).some((tool) => tool.name === 'browser'), false);
  const allToolNames = allTools.map((tool) => tool.name);
  const defaultToolsWith = (toolName: string) => allToolNames.filter((name) => name === toolName || defaultEnabledTools.has(name));
  assert.deepEqual(
    enableToolInConfig('studio_bulk_generate', [], allToolNames),
    defaultToolsWith('studio_bulk_generate'),
  );
  assert.deepEqual(
    enableToolInConfig('browser', [], allToolNames),
    defaultToolsWith('browser'),
  );
  assert.deepEqual(serializeEnabledToolNames(defaultEnabledTools, allToolNames), []);
  assert.equal(allTools.every((tool) => !['browser_start', 'browser_nav', 'brave_search', 'transcribe'].includes(tool.name)), true);
  assert.equal(allTools.some((tool) => tool.name === 'image_generation'), false);
  assert.equal(allTools.some((tool) => tool.name === 'video_generation'), false);
  assert.equal(allTools.some((tool) => tool.name === 'studio_edit_image'), false);

  const metadata = await getPiToolMetadata();
  const memoryMetadata = metadata.find((tool) => tool.name === 'memory');
  assert.ok(memoryMetadata);
  assert.equal(memoryMetadata.group, 'Memory');
  assert.deepEqual(memoryMetadata.toolsets, ['memory']);
  assert.equal(memoryMetadata.planningModeAllowed, false);
  const sessionSearchMetadata = metadata.find((tool) => tool.name === 'session_search');
  assert.ok(sessionSearchMetadata);
  assert.equal(sessionSearchMetadata.group, 'Session');
  assert.deepEqual(sessionSearchMetadata.toolsets, ['session_search']);
  assert.equal(sessionSearchMetadata.planningModeAllowed, true);
  const delegateTaskMetadata = metadata.find((tool) => tool.name === 'delegate_task');
  assert.ok(delegateTaskMetadata);
  assert.equal(delegateTaskMetadata.group, 'Delegation');
  assert.deepEqual(delegateTaskMetadata.toolsets, ['delegation']);
  assert.equal(delegateTaskMetadata.planningModeAllowed, false);
  const browserMetadata = metadata.find((tool) => tool.name === 'browser');
  assert.ok(browserMetadata);
  assert.equal(browserMetadata.group, 'Browser');
  assert.deepEqual(browserMetadata.toolsets, ['browser']);
  assert.equal(browserMetadata.defaultEnabled, false);
  assert.equal(browserMetadata.planningModeAllowed, false);
  const webSearchMetadata = metadata.find((tool) => tool.name === 'web_search');
  assert.ok(webSearchMetadata);
  assert.equal(webSearchMetadata.group, 'Web');
  assert.deepEqual(webSearchMetadata.toolsets, ['web']);
  assert.equal(webSearchMetadata.defaultEnabled, true);
  assert.equal(webSearchMetadata.planningModeAllowed, true);
  for (const toolName of ['copy_path', 'move_path', 'delete_path']) {
    const pathMetadata = metadata.find((tool) => tool.name === toolName);
    assert.ok(pathMetadata);
    assert.equal(pathMetadata.group, 'Core');
    assert.deepEqual(pathMetadata.toolsets, ['file']);
    assert.equal(pathMetadata.defaultEnabled, true);
    assert.equal(pathMetadata.planningModeAllowed, false);
  }

  console.log('pi-tool-registry-test: ok');

  moduleInternals._load = originalLoad;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
