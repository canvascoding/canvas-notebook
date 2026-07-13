import 'server-only';

import { EMPTY_STUDIO_PROVIDER_CONFIG, type StudioProviderConfig } from '@/app/apps/studio/types/config';
import type { EnvStorageScope } from '@/app/lib/integrations/env-config';
import { isManagedMediaFallbackAvailable } from '@/app/lib/integrations/managed-media-client';
import { resolveStudioProviderCredential } from '@/app/lib/integrations/studio-provider-credentials';

export async function getStudioProviderConfig(storageScope?: EnvStorageScope | null): Promise<StudioProviderConfig> {
  try {
    const [geminiApiKey, openaiApiKey, kieApiKey] = await Promise.all([
      resolveStudioProviderCredential('gemini', storageScope),
      resolveStudioProviderCredential('openai', storageScope),
      resolveStudioProviderCredential('kie', storageScope),
    ]);

    return {
      localApiKeys: {
        gemini: Boolean(geminiApiKey),
        openai: Boolean(openaiApiKey),
        kie: Boolean(kieApiKey),
      },
      managedMediaAvailable: isManagedMediaFallbackAvailable(),
      canManageCentralCredentials: false,
    };
  } catch (error) {
    console.error('[Studio Config] Failed to resolve provider config:', error);
    return EMPTY_STUDIO_PROVIDER_CONFIG;
  }
}
