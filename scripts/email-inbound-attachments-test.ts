import assert from 'node:assert/strict';

import {
  assertInboundEmailAttachmentSize,
  decodeGmailAttachmentData,
  gmailMessageAttachmentParts,
  microsoftMessageAttachments,
  sanitizeInboundEmailAttachmentFilename,
} from '../app/lib/email/inbound-attachments';

assert.equal(sanitizeInboundEmailAttachmentFilename('../../invoice.pdf'), 'invoice.pdf');
assert.equal(sanitizeInboundEmailAttachmentFilename('..\\..\\report.csv'), 'report.csv');
assert.equal(sanitizeInboundEmailAttachmentFilename('\u0000\r\n'), 'attachment');

const gmail = gmailMessageAttachmentParts({
  mimeType: 'multipart/mixed',
  parts: [
    { partId: '1', mimeType: 'text/plain', body: { data: 'SGVsbG8=' } },
    {
      partId: '2',
      mimeType: 'application/pdf',
      filename: '../../invoice.pdf',
      headers: [{ name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' }],
      body: { attachmentId: 'provider-attachment', size: 123 },
    },
    {
      partId: '3',
      mimeType: 'image/png',
      filename: 'logo.png',
      headers: [
        { name: 'Content-Disposition', value: 'inline; filename="logo.png"' },
        { name: 'Content-ID', value: '<logo@example.test>' },
      ],
      body: { data: 'cG5n', size: 3 },
    },
  ],
});
assert.deepEqual(gmail.map((part) => part.attachment), [
  {
    id: 'gmail-attachment:provider-attachment',
    filename: 'invoice.pdf',
    contentType: 'application/pdf',
    size: 123,
    inline: false,
    downloadable: true,
  },
  {
    id: 'gmail-part:3',
    filename: 'logo.png',
    contentType: 'image/png',
    size: 3,
    inline: true,
    downloadable: true,
    contentId: 'logo@example.test',
  },
]);
assert.equal(decodeGmailAttachmentData('SGVsbG8td29ybGQ').toString('utf8'), 'Hello-world');

assert.deepEqual(microsoftMessageAttachments([
  {
    '@odata.type': '#microsoft.graph.fileAttachment',
    id: 'file-1',
    name: 'brief.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 512,
    isInline: false,
  },
  {
    '@odata.type': '#microsoft.graph.referenceAttachment',
    id: 'link-1',
    name: 'cloud-file',
    size: 10,
  },
]), [
  {
    id: 'file-1',
    filename: 'brief.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 512,
    inline: false,
    downloadable: true,
  },
  {
    id: 'link-1',
    filename: 'cloud-file',
    contentType: 'application/octet-stream',
    size: 10,
    inline: false,
    downloadable: false,
  },
]);

assert.doesNotThrow(() => assertInboundEmailAttachmentSize(25 * 1024 * 1024));
assert.throws(() => assertInboundEmailAttachmentSize(25 * 1024 * 1024 + 1), /25 MB/u);

console.log('email-inbound-attachments-test: ok');
