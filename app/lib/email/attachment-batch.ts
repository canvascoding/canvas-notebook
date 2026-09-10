import 'server-only';

import {
  readInboundEmailAttachmentStream,
  type EmailMessageAttachment,
} from '@/app/lib/email/inbound-attachments';
import { downloadEmailAttachment, readEmailMessage } from '@/app/lib/email/service';
import {
  EMAIL_ATTACHMENT_BATCH_MAX_BYTES,
  EmailAttachmentBatchError,
  nextUniqueEmailAttachmentFilename,
  selectDownloadableEmailAttachments,
} from '@/app/lib/email/attachment-batch-core';

export {
  EMAIL_ATTACHMENT_BATCH_MAX_BYTES,
  EMAIL_ATTACHMENT_BATCH_MAX_COUNT,
  EmailAttachmentBatchError,
  emailAttachmentArchiveFilename,
  selectDownloadableEmailAttachments,
} from '@/app/lib/email/attachment-batch-core';

export type DownloadedEmailAttachmentBatchItem = {
  attachment: EmailMessageAttachment;
  content: Buffer;
};

export type DownloadedEmailAttachmentBatch = {
  attachments: DownloadedEmailAttachmentBatchItem[];
  subject: string;
  totalBytes: number;
};

export async function downloadEmailAttachmentBatch(input: {
  userId: string;
  accountId: string;
  messageId: string;
  folder?: string;
  attachmentIds?: readonly string[];
  readPolicy?: Parameters<typeof readEmailMessage>[4];
}): Promise<DownloadedEmailAttachmentBatch> {
  const detail = await readEmailMessage(
    input.userId,
    input.accountId,
    input.messageId,
    input.folder,
    input.readPolicy,
  );
  const selected = selectDownloadableEmailAttachments(detail, input.attachmentIds);
  const usedNames = new Set<string>();
  const attachments: DownloadedEmailAttachmentBatchItem[] = [];
  let totalBytes = 0;

  for (const metadata of selected.attachments) {
    const downloaded = await downloadEmailAttachment(
      input.userId,
      input.accountId,
      input.messageId,
      metadata.id,
      input.folder,
      input.readPolicy,
    );
    const content = await readInboundEmailAttachmentStream(downloaded.content);
    totalBytes += content.length;
    if (totalBytes > EMAIL_ATTACHMENT_BATCH_MAX_BYTES) {
      throw new EmailAttachmentBatchError(
        'Selected email attachments exceed the 100 MB batch limit.',
        413,
        'EMAIL_ATTACHMENT_BATCH_TOO_LARGE',
      );
    }
    attachments.push({
      attachment: {
        ...downloaded.attachment,
        filename: nextUniqueEmailAttachmentFilename(downloaded.attachment.filename, usedNames),
        size: content.length,
      },
      content,
    });
  }

  return { attachments, subject: selected.subject, totalBytes };
}
