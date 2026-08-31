import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-files-'));
  const originalData = process.env.DATA;
  const originalProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.DATA = path.join(temporaryRoot, 'data');
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  try {
    const workspaceRoot = path.join(process.env.DATA, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'Projects'), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, 'Projects', 'assets'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'Readme.txt'), 'Mobile file preview.');
    await fs.writeFile(path.join(workspaceRoot, 'Cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(workspaceRoot, 'A-small.bin'), Buffer.from([0x00]));
    await fs.writeFile(path.join(workspaceRoot, 'Z-large.bin'), Buffer.alloc(2_048, 0x01));
    await fs.utimes(path.join(workspaceRoot, 'A-small.bin'), new Date('2024-01-01'), new Date('2024-01-01'));
    await fs.utimes(path.join(workspaceRoot, 'Z-large.bin'), new Date('2025-01-01'), new Date('2025-01-01'));
    await fs.writeFile(path.join(workspaceRoot, 'Projects', 'Brief.md'), '# Brief');
    await fs.writeFile(path.join(workspaceRoot, 'Projects', 'MobileDeck.marp.md'), '---\nmarp: true\n---\n\n# Deck');
    await fs.writeFile(
      path.join(workspaceRoot, 'Projects', 'Dashboard.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head><body><a href="Details.html">Details</a></body></html>',
    );
    await fs.writeFile(path.join(workspaceRoot, 'Projects', 'Details.html'), '<!doctype html><h1>Details</h1>');
    await fs.writeFile(path.join(workspaceRoot, 'Projects', 'assets', 'site.css'), 'body { color: rebeccapurple; }');
    await fs.writeFile(path.join(workspaceRoot, 'Drawing.excalidraw'), JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'canvas-notebook',
      elements: [],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    }, null, 2));

    const { closeDatabaseConnections, openDb } = await import('../app/lib/db');
    const database = await openDb();
    const now = Date.now();
    await database.run(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['files-user', 'Files User', 'files@example.test', 1, now, now],
    );
    await database.close();

    const { createLegacyPersonalWorkspaceContext } = await import('../app/lib/workspaces/context');
    const {
      listMobileFiles,
      mobileFileCategory,
      mobileFileOpenKind,
      normalizeMobileFilePath,
      readMobileFileDetail,
    } = await import('../app/lib/mobile/files');
    const workspace = createLegacyPersonalWorkspaceContext({
      userId: 'files-user',
      email: 'files@example.test',
      role: 'owner',
    });
    const fileOptions = { workspace };
    const {
      readMobileExcalidrawDocument,
      saveMobileExcalidrawDocument,
    } = await import('../app/lib/mobile/excalidraw');

    const root = await listMobileFiles({ workspace, fileOptions, directory: '.', limit: 20 });
    assert.equal(root.items[0]?.category, 'folder');
    assert.equal(root.items.some((entry) => entry.path === 'Readme.txt'), true);
    assert.equal(root.actions.canUpload, true);
    assert.equal(root.actions.canCopy, true);
    assert.equal(root.actions.canExport, true);
    assert.deepEqual(root.breadcrumbs, [{ name: 'Workspace', path: '.' }]);

    const nameDescending = await listMobileFiles({
      workspace,
      fileOptions,
      directory: '.',
      sort: 'name',
      sortOrder: 'desc',
      limit: 20,
    });
    assert.equal(nameDescending.items[0]?.type, 'directory');
    assert.equal(nameDescending.items.find((entry) => entry.type === 'file')?.path, 'Z-large.bin');

    const sizeAscending = await listMobileFiles({
      workspace,
      fileOptions,
      directory: '.',
      sort: 'size',
      sortOrder: 'asc',
      limit: 20,
    });
    assert.equal(sizeAscending.items[0]?.type, 'directory');
    assert.equal(sizeAscending.items.find((entry) => entry.type === 'file')?.path, 'A-small.bin');

    const sortedFirstPage = await listMobileFiles({
      workspace,
      fileOptions,
      directory: '.',
      sort: 'name',
      sortOrder: 'asc',
      limit: 1,
    });
    await assert.rejects(() => listMobileFiles({
      workspace,
      fileOptions,
      directory: '.',
      sort: 'modified',
      sortOrder: 'desc',
      cursor: sortedFirstPage.nextCursor,
      limit: 1,
    }), (error: unknown) => Boolean(
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'INVALID_CURSOR'
    ));
    await assert.rejects(() => listMobileFiles({
      workspace,
      fileOptions,
      sort: 'unknown',
      limit: 20,
    }), (error: unknown) => Boolean(
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'INVALID_SORT'
    ));

    const imageOnly = await listMobileFiles({ workspace, fileOptions, filter: 'image', limit: 20 });
    assert.deepEqual(imageOnly.items.map((entry) => entry.path), ['Cover.png']);

    const search = await listMobileFiles({ workspace, fileOptions, query: 'brief', limit: 20 });
    assert.equal(search.items[0]?.path, 'Projects/Brief.md');
    assert.equal(search.items[0]?.openKind, 'markdown');
    assert.equal(search.items[0]?.canOpenInNotebook, true);

    const marpList = await listMobileFiles({ workspace, fileOptions, query: 'mobiledeck', limit: 20 });
    assert.equal(marpList.items[0]?.renderKind, 'marp');
    const marpDetail = await readMobileFileDetail({ workspace, fileOptions, path: 'Projects/MobileDeck.marp.md' });
    assert.equal(marpDetail.renderKind, 'marp');

    const text = await readMobileFileDetail({ workspace, fileOptions, path: 'Readme.txt' });
    assert.equal(text.previewMode, 'text');
    assert.equal(text.content, 'Mobile file preview.');

    const image = await readMobileFileDetail({ workspace, fileOptions, path: 'Cover.png' });
    assert.equal(image.previewMode, 'image');
    assert.equal(image.mimeType, 'image/png');

    const html = await readMobileFileDetail({ workspace, fileOptions, path: 'Projects/Dashboard.html' });
    assert.equal(html.openKind, 'text');
    assert.equal(html.previewMode, 'text');
    assert.match(html.content || '', /assets\/site\.css/u);
    const { createWorkspaceHtmlPreviewResponse } = await import('../app/lib/html-preview-response');
    const renderedHtml = await createWorkspaceHtmlPreviewResponse({
      filePath: 'Projects/Dashboard.html',
      fileOptions,
      routePrefix: '/api/mobile/v1/files/html-preview/test-ticket',
    });
    assert.equal(renderedHtml.headers.get('referrer-policy'), 'no-referrer');
    assert.match(
      await renderedHtml.text(),
      /<base href="\/api\/mobile\/v1\/files\/html-preview\/test-ticket\/Projects\/">/u,
    );
    const renderedCss = await createWorkspaceHtmlPreviewResponse({
      filePath: 'Projects/assets/site.css',
      fileOptions,
      routePrefix: '/api/mobile/v1/files/html-preview/test-ticket',
    });
    assert.equal(renderedCss.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await renderedCss.text(), 'body { color: rebeccapurple; }');

    const drawing = await readMobileExcalidrawDocument({
      workspace,
      fileOptions,
      path: 'Drawing.excalidraw',
    });
    assert.equal(drawing.canEdit, true);
    assert.equal(drawing.sceneSequence, null);
    const savedDrawing = await saveMobileExcalidrawDocument({
      workspace,
      fileOptions,
      actorUserId: 'files-user',
      actorSessionId: 'auth-session',
      path: drawing.path,
      content: JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'canvas-notebook',
        elements: [],
        appState: { viewBackgroundColor: '#f8fafc' },
        files: {},
      }),
      expectedSha256: drawing.sha256,
      baseRevisionId: drawing.revisionId,
      baseSceneSequence: null,
    });
    assert.match(savedDrawing.content, /#f8fafc/u);
    await assert.rejects(() => saveMobileExcalidrawDocument({
      workspace,
      fileOptions,
      actorUserId: 'files-user',
      actorSessionId: 'stale-auth-session',
      path: drawing.path,
      content: drawing.content,
      expectedSha256: drawing.sha256,
      baseRevisionId: drawing.revisionId,
      baseSceneSequence: null,
    }), (error: unknown) => Boolean(
      error
      && typeof error === 'object'
      && 'code' in error
      && ['FILE_REVISION_CONFLICT', 'FILE_REVISION_ID_CONFLICT'].includes(String(error.code)),
    ));

    const { createDirectoryIfAbsent, writeWorkspaceFileFromPathIfAbsent } = await import('../app/lib/filesystem/workspace-files');
    await assert.rejects(() => createDirectoryIfAbsent('Projects', fileOptions), (error: unknown) => (
      Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
    ));
    const uploadSource = path.join(temporaryRoot, 'upload-source.txt');
    await fs.writeFile(uploadSource, 'must not replace');
    await assert.rejects(() => writeWorkspaceFileFromPathIfAbsent(uploadSource, 'Readme.txt', fileOptions), (error: unknown) => (
      Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
    ));
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'Readme.txt'), 'utf8'), 'Mobile file preview.');

    assert.equal(mobileFileCategory('clip.mp4', 'file'), 'video');
    assert.equal(mobileFileCategory('legacy.htm', 'file'), 'document');
    assert.equal(mobileFileOpenKind('note.md', 'file'), 'markdown');
    assert.equal(mobileFileOpenKind('dashboard.html', 'file'), 'text');
    assert.equal(mobileFileOpenKind('legacy.htm', 'file'), 'text');
    assert.equal(mobileFileOpenKind('document.docx', 'file'), 'word');
    assert.equal(mobileFileOpenKind('workbook.xlsx', 'file'), 'spreadsheet');
    assert.equal(mobileFileOpenKind('deck.pptx', 'file'), 'presentation');
    assert.equal(mobileFileOpenKind('drawing.excalidraw', 'file'), 'excalidraw');
    assert.equal(mobileFileOpenKind('bundle.zip', 'file'), 'archive');
    assert.equal(mobileFileOpenKind('Workspace', 'directory'), 'folder');
    assert.throws(() => normalizeMobileFilePath('../secrets', false));
    await assert.rejects(() => listMobileFiles({
      workspace,
      fileOptions,
      query: 'brief',
      cursor: Buffer.from(JSON.stringify({ offset: 1, signature: 'wrong' })).toString('base64url'),
    }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_CURSOR'));

    const blobAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/blob/route.ts'), 'utf8');
    const copyAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/copy/route.ts'), 'utf8');
    const markdownPdfAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/export/markdown-pdf/route.ts'), 'utf8');
    const marpDetectAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/export/marp-detect/route.ts'), 'utf8');
    const marpPdfAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/export/marp-pdf/route.ts'), 'utf8');
    const marpImagesAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/export/marp-images/route.ts'), 'utf8');
    const uploadAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/uploads/[id]/route.ts'), 'utf8');
    const excalidrawRoute = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/excalidraw/route.ts'), 'utf8');
    const htmlTicketRoute = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/html-preview-ticket/route.ts'), 'utf8');
    const marpPreviewRoute = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/marp-preview/route.ts'), 'utf8');
    const htmlPreviewRoute = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/html-preview/[ticket]/[...path]/route.ts'), 'utf8');
    const proxy = await fs.readFile(path.join(process.cwd(), 'proxy.ts'), 'utf8');
    assert.match(blobAlias, /api\/files\/download\/route/u);
    assert.match(copyAlias, /api\/files\/copy\/route/u);
    assert.match(markdownPdfAlias, /api\/files\/markdown-pdf\/route/u);
    assert.match(marpDetectAlias, /api\/files\/marp-detect\/route/u);
    assert.match(marpPdfAlias, /api\/files\/marp-pdf\/route/u);
    assert.match(marpImagesAlias, /api\/files\/marp-images\/route/u);
    assert.match(uploadAlias, /DELETE, GET, PUT/u);
    assert.match(excalidrawRoute, /readMobileExcalidrawDocument/u);
    assert.match(excalidrawRoute, /saveMobileExcalidrawDocument/u);
    assert.match(htmlTicketRoute, /issueMobileHtmlPreviewTicket/u);
    assert.match(htmlPreviewRoute, /resolveMobileHtmlPreviewTicket/u);
    assert.match(marpPreviewRoute, /requireRequestWorkspace\(request, \{ permissions: 'canRead' \}\)/u);
    assert.match(marpPreviewRoute, /renderMarpMarkdownToMobilePreview/u);
    assert.match(marpPreviewRoute, /MARP_PREVIEW_TOO_LARGE/u);
    assert.match(marpPreviewRoute, /MarpMobilePreviewTooLargeError/u);
    assert.match(proxy, /isMobileHtmlPreviewRoute/u);
    assert.match(proxy, /html-preview\\\/\[A-Za-z0-9_-\]\{43\}/u);
    const publicPrefixDeclaration = proxy.match(/const PUBLIC_PREFIX_ROUTES = \[[^\]]*\]/u)?.[0] || '';
    assert.doesNotMatch(publicPrefixDeclaration, /html-preview/u);

    const {
      issueMobileHtmlPreviewTicket,
      mobileHtmlPreviewPath,
      MOBILE_HTML_PREVIEW_TICKET_TTL_MS,
      resolveMobileHtmlPreviewTicket,
    } = await import('../app/lib/mobile/html-preview-ticket');
    const issuedAt = 10_000;
    const issued = issueMobileHtmlPreviewTicket({
      userId: 'files-user',
      sessionId: 'auth-session',
      rootHtmlPath: 'Projects/Dashboard.html',
      workspace,
    }, issuedAt);
    assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(
      mobileHtmlPreviewPath(issued.ticket, 'Projects/Quarter 2/Dashboard.html'),
      `/api/mobile/v1/files/html-preview/${issued.ticket}/Projects/Quarter%202/Dashboard.html`,
    );
    assert.equal(
      resolveMobileHtmlPreviewTicket(issued.ticket, issuedAt + 1)?.workspace.workspaceId,
      workspace.workspaceId,
    );
    assert.equal(
      resolveMobileHtmlPreviewTicket(issued.ticket, issuedAt + MOBILE_HTML_PREVIEW_TICKET_TTL_MS),
      null,
    );
    const { NextRequest } = await import('next/server');
    const { default: serverProxy } = await import('../proxy');
    const ticketAssetRequest = new NextRequest(
      `https://canvas.example/api/mobile/v1/files/html-preview/${issued.ticket}/Projects/assets/site.css`,
    );
    const ticketAssetProxyResponse = await serverProxy(ticketAssetRequest);
    assert.equal(ticketAssetProxyResponse.headers.get('x-middleware-next'), '1');
    const untrustedTicketIssueResponse = await serverProxy(new NextRequest(
      'https://canvas.example/api/mobile/v1/files/html-preview-ticket',
      { method: 'POST' },
    ));
    assert.equal(untrustedTicketIssueResponse.status, 401);

    await closeDatabaseConnections();
    console.log('mobile-files-test: ok');
  } finally {
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
    if (originalProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = originalProvider;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

void main();
