export interface StudioProviderConfig {
  localApiKeys: {
    gemini: boolean;
    openai: boolean;
    kie: boolean;
  };
  managedMediaAvailable: boolean;
}

export const EMPTY_STUDIO_PROVIDER_CONFIG: StudioProviderConfig = {
  localApiKeys: {
    gemini: false,
    openai: false,
    kie: false,
  },
  managedMediaAvailable: false,
};
