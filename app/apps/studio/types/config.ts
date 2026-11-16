export interface StudioProviderConfig {
  localApiKeys: {
    gemini: boolean;
    openai: boolean;
    kie: boolean;
  };
  managedMediaAvailable: boolean;
  seedance?: { available: boolean; error?: string; limits: { imageBytes: number; videoBytes: number; audioBytes: number; totalBytes?: number; bodyBytes?: number } };
  canManageCentralCredentials: boolean;
}

export const EMPTY_STUDIO_PROVIDER_CONFIG: StudioProviderConfig = {
  localApiKeys: {
    gemini: false,
    openai: false,
    kie: false,
  },
  managedMediaAvailable: false,
  canManageCentralCredentials: false,
};
