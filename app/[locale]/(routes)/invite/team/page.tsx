import { TeamInvitationAcceptancePanel } from '@/app/components/invitations/TeamInvitationAcceptancePanel';

export const dynamic = 'force-dynamic';

export default async function TeamInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; request?: string }>;
}) {
  const query = await searchParams;
  return (
    <TeamInvitationAcceptancePanel
      token={typeof query.token === 'string' ? query.token : ''}
      initialRequestId={typeof query.request === 'string' ? query.request : null}
    />
  );
}
