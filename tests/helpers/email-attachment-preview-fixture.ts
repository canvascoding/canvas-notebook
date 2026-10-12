import type { BrowserContext } from '@playwright/test';
import * as XLSX from 'xlsx';
import { createOfficeRoundtripFixture, OFFICE_ROUNDTRIP_PNG } from '../../scripts/fixtures/office-docx-roundtrip';

function pdfFixture(): Buffer {
  const content = 'BT /F1 18 Tf 20 130 Td (Attachment PDF fixture) Tj ET';
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let output = '%PDF-1.4\n'; const offsets: number[] = [];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const start = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}
export async function installEmailAttachmentPreviewFixture(context: BrowserContext, options: { shared?: boolean; uncertain?: boolean } = {}) {
  context.setDefaultTimeout(15_000);
  const session = await (await context.request.get('/api/auth/get-session')).json();
  if (!session.user?.id) throw new Error('Attachment fixture requires an authenticated user.');
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Item', 'Amount'], ['Preview fixture', 42]]), 'Sheet1');
  const files = new Map<string, { name: string; mimeType: string; body: Buffer }>([
    ['notes', { name: 'notes.txt', mimeType: 'text/plain', body: Buffer.from('Frozen agent attachment contents') }],
    ['pdf', { name: 'report.pdf', mimeType: 'application/pdf', body: pdfFixture() }],
    ['image', { name: 'image.png', mimeType: 'image/png', body: OFFICE_ROUNDTRIP_PNG }],
    ['markdown', { name: 'readme.md', mimeType: 'text/markdown', body: Buffer.from('# Attachment heading\n\n![remote](https://preview-external.invalid/image.png)\n\n[remote link](https://preview-external.invalid/)') }],
    ['html', { name: 'unsafe.html', mimeType: 'text/html', body: Buffer.from('<script>window.previewExecuted = true</script><h1>Inert HTML attachment</h1>') }],
    ['svg', { name: 'drawing.svg', mimeType: 'image/svg+xml', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.previewExecuted = true</script></svg>') }],
    ['zip', { name: 'archive.zip', mimeType: 'application/zip', body: Buffer.from('unsupported archive fixture') }],
    ['empty', { name: 'empty.txt', mimeType: 'text/plain', body: Buffer.alloc(0) }],
    ['json', { name: 'data.json', mimeType: 'application/json', body: Buffer.from('{"preview":true}') }],
    ['docx', { name: 'document.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: await createOfficeRoundtripFixture({ comments: false, trackedChanges: false }) }],
    ['xlsx', { name: 'spreadsheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer }],
    ['missing', { name: 'missing.txt', mimeType: 'text/plain', body: Buffer.from('missing') }],
    ['forbidden', { name: 'forbidden.txt', mimeType: 'text/plain', body: Buffer.from('forbidden') }],
    ['large', { name: 'large.txt', mimeType: 'text/plain', body: Buffer.from('too large') }],
  ]);
  const attachments = [...files].map(([id, file]) => ({ id, source: 'upload', uploadId: `preview-${id}.${file.name.split('.').pop()}`, name: file.name,
    mimeType: file.mimeType, size: id === 'large' ? 26 * 1024 * 1024 : file.body.length }));
  const accounts = [{ id: 'preview-account', provider: 'smtp_imap', authType: 'smtp_imap', emailAddress: 'preview@example.test', displayName: 'Attachment Preview',
    isPrimary: true, status: 'active', imapHost: 'imap.example.test', connectionState: 'ready', policy: { readFrom: ['*'], sendTo: ['*'] },
    accountScope: options.shared ? 'workspace' : 'personal', workspaceId: options.shared ? 'preview-workspace' : null, workspaceName: options.shared ? 'Preview Team' : null,
    capabilities: { canRead: true, canWrite: true, canManage: false, canDelete: true, canRunAgent: true } }];
  const origin = { mailboxRef: `emb:${'a'.repeat(64)}`, accountSource: 'local', accountId: accounts[0].id,
    accountScope: accounts[0].accountScope, accountOwnerId: session.user.id, mailboxId: options.shared ? 'preview-mailbox' : null,
    workspaceId: accounts[0].workspaceId, workspaceName: accounts[0].workspaceName, emailAddress: accounts[0].emailAddress,
    displayName: accounts[0].displayName, folder: 'INBOX', canonicalId: '', capabilities: accounts[0].capabilities };
  const entry = { id: 'attachment-draft', accountId: 'preview-account', subject: 'Agent attachment proposal', senderAddress: 'preview@example.test',
    body: '<ul><li><p>Prepared agent email</p></li></ul>', isHtml: true, to: ['recipient@example.test'], cc: [], bcc: [], attachments,
    status: options.uncertain ? 'send_uncertain' : 'awaiting_review', version: 1, origin: 'agent', createdAt: '2026-10-07T09:00:00Z', updatedAt: '2026-10-07T09:00:00Z' };
  const state = { files, attachments, entry, origin, reads: [] as string[], writes: [] as string[], external: [] as string[], changed: false, deny: false, corruptImage: false, delay: null as Promise<void> | null };
  await context.route('https://api.github.com/repos/canvascoding/canvas-notebook/releases/latest', route => route.fulfill({ json: { tag_name: '0.0.0', body: '', html_url: 'https://github.com/canvascoding/canvas-notebook/releases' } }));
  await context.route('https://preview-external.invalid/**', route => { state.external.push(route.request().url()); return route.abort(); });
  await context.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (path.startsWith('/api/user-hints')) return route.fulfill({ json: { page: 'emails', version: 1, completed: true, currentHintKey: null, hints: [] } });
    if (path === '/api/email/classification/availability') return route.fulfill({ json: { success: true, data: { enabled: false, available: false, revision: 1, defaultMode: 'focus', reason: 'DISABLED' } } });
    if (path === '/api/email/classification/mailboxes') return route.fulfill({ json: { success: true, data: { mailboxes: [origin] } } });
    if (path === '/api/email/accounts' || path === '/api/email/mailboxes') return route.fulfill({ json: { success: true, data: { mode: 'local', accounts, setup: { canManageBusiness: false, manageableWorkspaces: [] } } } });
    if (path.endsWith('/email/outbox') || path === '/api/email/outbox') return route.fulfill({ json: { success: true, data: path === '/api/email/outbox' ? [entry] : [] } });
    if (path === '/api/email/outbox/attachment-draft') {
      if (!['GET', 'HEAD'].includes(request.method())) { state.writes.push(path); return route.fulfill({ status: 403, json: { success: false, error: 'Fixture email writes blocked.' } }); }
      return route.fulfill({ json: { success: true, data: { ...entry, version: state.changed ? 2 : 1 } } });
    }
    if (path === '/api/email/folders') return route.fulfill({ json: { success: true, data: { folders: [{ id: 'INBOX', path: 'INBOX', name: 'Inbox', role: 'inbox', messageCount: 1, unseenCount: 0 }] } } });
    if (path === '/api/email/messages/list') return route.fulfill({ json: { success: true, data: { messages: [{ id: 'preview-message', folder: 'INBOX', from: 'sender@example.test', subject: 'Preview incoming message', snippet: 'Attachment preview fixture', date: '2026-10-07', isRead: true }], total: 1, hasMore: false } } });
    if (path === '/api/email/accounts/preview-account/messages/preview-message') return route.fulfill({ json: { success: true, data: { message: {
      id: 'preview-message', folder: 'INBOX', from: 'sender@example.test', subject: 'Preview incoming message', to: ['preview@example.test'], body: 'Received email with attachments',
      bodyHtml: '<p>Received email with attachments</p>', isRead: true, attachments: attachments.map(attachment => ({ id: attachment.id, filename: attachment.name, contentType: attachment.mimeType, size: attachment.size, downloadable: true })) } } } });
    const fileId = path.match(/^\/api\/files\/preview-([^.]+)\.[^/]+$/u)?.[1] || path.match(/\/attachments\/([^/]+)$/u)?.[1];
    if (fileId && files.has(fileId)) {
      state.reads.push(url.pathname + url.search);
      if (state.delay && fileId === 'notes') await state.delay;
      if (state.deny || fileId === 'forbidden') return route.fulfill({ status: 403, json: { success: false, error: 'Forbidden fixture.' } });
      if (fileId === 'missing') return route.fulfill({ status: 404, json: { success: false, error: 'Missing fixture.' } });
      const file = files.get(fileId)!;
      return route.fulfill({ body: state.corruptImage && fileId === 'image' ? Buffer.from('corrupted image') : request.headers().range ? file.body.subarray(0, 1) : file.body, status: request.headers().range ? 206 : 200,
        headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="${file.name}"` } }).catch(() => {});
    }
    if (path === '/api/email/attachments/upload') {
      state.writes.push(path);
      return route.fulfill({ json: { success: true, files: [attachments[0]] } });
    }
    if (path.includes('/email/') && !['GET', 'HEAD'].includes(request.method())) {
      state.writes.push(path); return route.fulfill({ status: 403, json: { success: false, error: 'Live email writes blocked by fixture.' } });
    }
    return route.continue();
  });
  return state;
}
