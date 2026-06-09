import { EmailClient } from '@/app/apps/email/components/EmailClient';
import { requirePageSession } from '@/app/lib/auth-guards';

export default async function EmailsPage() {
  await requirePageSession();

  return <EmailClient />;
}
