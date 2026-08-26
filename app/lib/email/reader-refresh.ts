export type EmailMessageRevisionInput = {
  attachments?: Array<{
    contentType?: string;
    filename: string;
    size?: number;
  }>;
  body?: string;
  bodyHtml?: string;
  cc?: string[] | string;
  date: string;
  folder?: string;
  from: string;
  id: string;
  subject: string;
  to?: string[] | string;
};

export function emailMessageContentRevision(message: EmailMessageRevisionInput): string {
  return JSON.stringify([
    message.folder || '',
    message.id,
    message.from,
    message.to || [],
    message.cc || [],
    message.subject,
    message.date,
    message.body || '',
    message.bodyHtml || '',
    (message.attachments || []).map((attachment) => [attachment.filename, attachment.contentType || '', attachment.size || 0]),
  ]);
}

export function emailMessageListScopeKey({
  accountId,
  filter,
  folder,
  page,
  query,
}: {
  accountId: string;
  filter: string;
  folder: string;
  page: number;
  query: string;
}): string {
  return JSON.stringify([accountId, folder, filter, query, page]);
}
