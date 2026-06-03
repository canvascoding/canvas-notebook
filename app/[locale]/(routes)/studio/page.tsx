import { requirePageSession } from '@/app/lib/auth-guards';
import { StudioClient } from '@/app/apps/studio/components/StudioClient';
import { getStudioProviderConfig } from '@/app/lib/integrations/studio-config';

export default async function StudioPage() {
  await requirePageSession();
  const providerConfig = await getStudioProviderConfig();

  return <StudioClient providerConfig={providerConfig} />;
}
