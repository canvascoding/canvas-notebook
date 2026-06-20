import type { EnvStorageScope } from '@/app/lib/integrations/env-config';

export async function getTelegramConfig(): Promise<{
  botToken: string | null;
  channelEnabled: boolean;
}> {
  const { getTelegramConfigFromIntegrations } = await import('@/app/lib/integrations/env-config');
  return getTelegramConfigFromIntegrations({ secretScope: 'legacy' } satisfies EnvStorageScope);
}
