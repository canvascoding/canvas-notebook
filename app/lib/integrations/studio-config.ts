import 'server-only';

import { EMPTY_STUDIO_PROVIDER_CONFIG, type StudioProviderConfig } from '@/app/apps/studio/types/config';
import {
  getGeminiApiKeyFromIntegrations,
  getKieApiKeyFromIntegrations,
  getOpenAIApiKeyFromIntegrations,
  type EnvStorageScope,
} from '@/app/lib/integrations/env-config';
import { isManagedMediaFallbackAvailable } from '@/app/lib/integrations/managed-media-client';

export async function getStudioProviderConfig(storageScope?: EnvStorageScope | null): Promise<StudioProviderConfig> {
  try {
    const [geminiApiKey, openaiApiKey, kieApiKey] = await Promise.all([
      getGeminiApiKeyFromIntegrations(storageScope),
      getOpenAIApiKeyFromIntegrations(storageScope),
      getKieApiKeyFromIntegrations(storageScope),
    ]);

    return {
      localApiKeys: {
        gemini: Boolean(geminiApiKey),
        openai: Boolean(openaiApiKey),
        kie: Boolean(kieApiKey),
      },
      managedMediaAvailable: isManagedMediaFallbackAvailable(),
    };
  } catch (error) {
    console.error('[Studio Config] Failed to resolve provider config:', error);
    return EMPTY_STUDIO_PROVIDER_CONFIG;
  }
}
