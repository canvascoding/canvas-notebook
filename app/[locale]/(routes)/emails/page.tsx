import { EmailClient } from '@/app/apps/email/components/EmailClient';
import { requirePageSession } from '@/app/lib/auth-guards';
import type { NotebookEmailContextIntent } from '@/app/lib/notebook/context-surface';

type EmailsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getFirstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function EmailsPage({ searchParams }: EmailsPageProps) {
  await requirePageSession();

  const params: Record<string, string | string[] | undefined> = await (searchParams ?? Promise.resolve({}));
  const accountId = getFirstSearchParam(params.accountId);
  const messageId = getFirstSearchParam(params.messageId);
  const folder = getFirstSearchParam(params.folder);
  const contextIntent: NotebookEmailContextIntent | null = accountId && messageId
    ? {
      kind: 'email',
      toolCallId: null,
      toolName: 'email_read',
      status: 'complete',
      accountId,
      folder,
      messageId,
    }
    : null;

  return <EmailClient contextIntent={contextIntent} />;
}
