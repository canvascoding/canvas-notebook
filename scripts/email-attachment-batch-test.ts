import assert from 'node:assert/strict';

import {
  EMAIL_ATTACHMENT_BATCH_MAX_COUNT,
  EmailAttachmentBatchError,
  emailAttachmentArchiveFilename,
  selectDownloadableEmailAttachments,
} from '../app/lib/email/attachment-batch-core';

const detail = {
  message: {
    subject: 'Quarterly / review',
    attachments: [
      { id: 'a-1', filename: '../review.pdf', contentType: 'application/pdf', size: 42, downloadable: true },
      { id: 'a-2', filename: 'cloud-link', contentType: 'text/uri-list', size: null, downloadable: false },
      { id: 'a-3', filename: 'notes.txt', contentType: 'text/plain', size: 10 },
    ],
  },
};

assert.deepEqual(
  selectDownloadableEmailAttachments(detail).attachments.map((attachment) => attachment.id),
  ['a-1', 'a-3'],
);
assert.equal(selectDownloadableEmailAttachments(detail, ['a-3', 'a-3']).attachments.length, 1);
assert.equal(selectDownloadableEmailAttachments(detail, ['a-1']).attachments[0]?.filename, 'review.pdf');
assert.equal(emailAttachmentArchiveFilename('Quarterly / review'), 'review-attachments.zip');

assert.throws(
  () => selectDownloadableEmailAttachments(detail, ['missing']),
  (error) => error instanceof EmailAttachmentBatchError && error.code === 'EMAIL_ATTACHMENT_NOT_FOUND',
);
assert.throws(
  () => selectDownloadableEmailAttachments(detail, ['a-2']),
  (error) => error instanceof EmailAttachmentBatchError && error.code === 'EMAIL_ATTACHMENT_UNAVAILABLE',
);
assert.throws(
  () => selectDownloadableEmailAttachments({ message: { attachments: [] } }),
  (error) => error instanceof EmailAttachmentBatchError && error.status === 404,
);
assert.throws(
  () => selectDownloadableEmailAttachments(detail, Array.from({ length: EMAIL_ATTACHMENT_BATCH_MAX_COUNT + 1 }, (_, index) => `a-${index}`)),
  (error) => error instanceof EmailAttachmentBatchError && error.code === 'EMAIL_ATTACHMENT_BATCH_TOO_MANY',
);

console.log('email-attachment-batch-test: ok');
