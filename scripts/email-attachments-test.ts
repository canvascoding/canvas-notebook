import assert from 'node:assert/strict';
import Module from 'node:module';

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

async function main() {
  const {
    inferEmailAttachmentMimeType,
    isMarkdownEmailAttachmentName,
    markdownEmailAttachmentPdfName,
  } = await import('../app/lib/email/attachment-types');
  const { normalizeEmailAttachmentInputs } = await import('../app/lib/email/attachments');

  assert.equal(isMarkdownEmailAttachmentName('note.md'), true);
  assert.equal(isMarkdownEmailAttachmentName('note.mdx'), true);
  assert.equal(isMarkdownEmailAttachmentName('note.markdown'), true);
  assert.equal(isMarkdownEmailAttachmentName('note.txt'), false);
  assert.equal(markdownEmailAttachmentPdfName('note.md'), 'note.pdf');
  assert.equal(markdownEmailAttachmentPdfName('note.mdx'), 'note.pdf');
  assert.equal(markdownEmailAttachmentPdfName('note.markdown'), 'note.pdf');
  assert.equal(inferEmailAttachmentMimeType('note.markdown'), 'text/markdown');
  assert.equal(inferEmailAttachmentMimeType('note.mdx'), 'text/markdown');

  assert.deepEqual(normalizeEmailAttachmentInputs([
    {
      source: 'workspace',
      name: 'note.md',
      path: 'notes/note.md',
      deliveryFormat: 'pdf',
      size: 120,
    },
    {
      source: 'upload',
      name: 'raw.md',
      uploadId: 'upload-1',
      deliveryFormat: 'original',
      size: 80,
    },
    {
      source: 'workspace',
      name: 'ignored.txt',
      path: 'ignored.txt',
      deliveryFormat: 'unsupported',
    },
  ]), [
    {
      source: 'workspace',
      contentId: undefined,
      disposition: 'attachment',
      name: 'note.md',
      mimeType: undefined,
      path: 'notes/note.md',
      uploadId: undefined,
      deliveryFormat: 'pdf',
      size: 120,
    },
    {
      source: 'upload',
      contentId: undefined,
      disposition: 'attachment',
      name: 'raw.md',
      mimeType: undefined,
      path: undefined,
      uploadId: 'upload-1',
      deliveryFormat: 'original',
      size: 80,
    },
    {
      source: 'workspace',
      contentId: undefined,
      disposition: 'attachment',
      name: 'ignored.txt',
      mimeType: undefined,
      path: 'ignored.txt',
      uploadId: undefined,
      deliveryFormat: undefined,
      size: undefined,
    },
  ]);

  assert.deepEqual(normalizeEmailAttachmentInputs([
    {
      source: 'upload',
      uploadId: 'upload-2',
      name: 'inline.png',
      contentId: 'cid:<hero-image>',
      disposition: 'inline',
    },
    {
      source: 'upload',
      uploadId: 'upload-3',
      name: 'bad-inline.png',
      contentId: 'bad id',
      disposition: 'inline',
    },
  ]), [
    {
      source: 'upload',
      contentId: 'hero-image',
      disposition: 'inline',
      name: 'inline.png',
      mimeType: undefined,
      path: undefined,
      uploadId: 'upload-2',
      deliveryFormat: undefined,
      size: undefined,
    },
    {
      source: 'upload',
      contentId: undefined,
      disposition: 'attachment',
      name: 'bad-inline.png',
      mimeType: undefined,
      path: undefined,
      uploadId: 'upload-3',
      deliveryFormat: undefined,
      size: undefined,
    },
  ]);

  console.log('Email attachment metadata test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
