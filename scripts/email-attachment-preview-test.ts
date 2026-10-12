import assert from 'node:assert/strict';
import { composeEmailAttachmentPreviewItems, draftEmailAttachmentPreviewItems, emailAttachmentPreviewKind,
  emailAttachmentPreviewURL, EMAIL_ATTACHMENT_PREVIEW_MAX_BYTES, EmailAttachmentPreviewError,
  loadEmailAttachmentPreviewResource, type EmailAttachmentPreviewItem } from '../app/lib/email/attachment-preview';
import type { EmailReviewEntry } from '../app/lib/email/review-client';

async function main() {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const text: EmailAttachmentPreviewItem = { id: 'notes', name: 'notes.txt', size: 7, source: { kind: 'upload', uploadId: 'owned-notes.txt' } };
  assert.equal(emailAttachmentPreviewURL({ ...text, source: { kind: 'inbound', accountId: 'account/a', messageId: 'message/b', attachmentId: 'part/c', folder: 'INBOX/a', workspaceId: 'work/d' } }), '/api/email/accounts/account%2Fa/messages/message%2Fb/attachments/part%2Fc?folder=INBOX%2Fa&mailboxWorkspaceId=work%2Fd');
  const workspace = composeEmailAttachmentPreviewItems([{ id: 'file', source: 'workspace', path: 'docs/file.md', name: 'file.md', mimeType: 'text/markdown', size: 10, deliveryFormat: 'pdf' }], 'chosen-workspace')[0];
  assert.equal(workspace.name, 'file.pdf'); assert.equal(workspace.mimeType, 'application/pdf');
  assert.equal(emailAttachmentPreviewURL(workspace), '/api/files/markdown-pdf');
  assert.equal(composeEmailAttachmentPreviewItems([{ id: 'file', source: 'workspace', path: 'file.txt', name: 'file.txt', mimeType: 'text/plain', size: 7 }], null)[0].source, null);
  assert.equal(emailAttachmentPreviewKind({ name: 'unsafe.html', mimeType: 'text/html' }), 'text');
  assert.equal(emailAttachmentPreviewKind({ name: 'unsafe.svg', mimeType: 'image/svg+xml' }), 'text');
  assert.equal(emailAttachmentPreviewKind({ name: 'readme.md' }), 'markdown');
  assert.equal(emailAttachmentPreviewKind({ name: 'archive.zip' }), 'unsupported');
  const entry = { id: 'draft', scope: 'workspace', workspaceId: 'work', version: 3,
    attachments: [{ source: 'upload', uploadId: 'frozen.txt', name: 'frozen.txt', mimeType: 'text/plain', size: 6 }] } as EmailReviewEntry;
  const draft = draftEmailAttachmentPreviewItems(entry)[0];
  assert.equal(emailAttachmentPreviewURL(draft), '/api/files/frozen.txt');
  const calls: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(String(url)); assert.equal(init?.signal, controller.signal);
      return String(url).includes('/outbox/') ? Response.json({ success: true, data: { version: 3, attachments: [{ uploadId: 'frozen.txt' }] } })
        : new Response('frozen', { headers: { 'Content-Type': 'text/plain' } });
    };
    const resource = await loadEmailAttachmentPreviewResource(draft, controller.signal);
    assert.equal(resource.text, 'frozen'); assert.equal(resource.size, 6);
    assert.deepEqual(calls, ['/api/workspaces/work/email/outbox/draft', '/api/files/frozen.txt']);
    URL.revokeObjectURL(resource.objectUrl);
    globalThis.fetch = async () => Response.json({ success: true, data: { version: 4, attachments: [{ uploadId: 'frozen.txt' }] } });
    await assert.rejects(loadEmailAttachmentPreviewResource(draft, controller.signal), (error: unknown) => error instanceof EmailAttachmentPreviewError && error.code === 'changed');
    globalThis.fetch = async () => new Response('', { status: 403 });
    await assert.rejects(loadEmailAttachmentPreviewResource(text, controller.signal), (error: unknown) => error instanceof EmailAttachmentPreviewError && error.code === 'forbidden');
    globalThis.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(loadEmailAttachmentPreviewResource(text, controller.signal), (error: unknown) => error instanceof EmailAttachmentPreviewError && error.code === 'unavailable');
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return new Response('unexpected'); };
    await assert.rejects(loadEmailAttachmentPreviewResource({ ...text, size: EMAIL_ATTACHMENT_PREVIEW_MAX_BYTES + 1 }, controller.signal), (error: unknown) => error instanceof EmailAttachmentPreviewError && error.code === 'large');
    assert.equal(fetched, false);
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(EMAIL_ATTACHMENT_PREVIEW_MAX_BYTES + 1)); }, cancel() { cancelled = true; } }));
    await assert.rejects(loadEmailAttachmentPreviewResource({ ...text, size: undefined }, controller.signal), (error: unknown) => error instanceof EmailAttachmentPreviewError && error.code === 'large');
    assert.equal(cancelled, true);
    globalThis.fetch = async () => new Response('a'.repeat(2 * 1024 * 1024 + 10));
    const truncated = await loadEmailAttachmentPreviewResource({ ...text, size: undefined }, controller.signal);
    assert.equal(truncated.truncated, true); assert.equal(truncated.text?.length, 2 * 1024 * 1024);
    URL.revokeObjectURL(truncated.objectUrl);
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.method, 'POST'); assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), 'chosen-workspace');
      assert.deepEqual(JSON.parse(String(init?.body)), { path: 'docs/file.md' });
      return new Response('%PDF-test', { headers: { 'Content-Type': 'application/pdf' } });
    };
    const pdf = await loadEmailAttachmentPreviewResource(workspace, controller.signal);
    assert.equal(pdf.kind, 'pdf'); assert.equal(new TextDecoder().decode(pdf.data), '%PDF-test'); URL.revokeObjectURL(pdf.objectUrl);
  } finally { globalThis.fetch = originalFetch; }
  console.log('email-attachment-preview-test: ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
