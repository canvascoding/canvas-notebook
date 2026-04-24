import { requirePageSession } from '@/app/lib/auth-guards';
import { StudioClient } from '@/app/apps/studio/components/StudioClient';

export default async function StudioPage() {
  await requirePageSession();

  return <StudioClient />;
}
