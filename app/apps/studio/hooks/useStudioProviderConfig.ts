'use client';

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { StudioProviderConfig } from '../types/config';
import { studioApiFetch } from '../utils/studio-api';

export type StudioProviderRequirement = 'gemini' | 'openai' | 'kie';
export type StudioProviderConfigStatus = 'checking' | 'ready' | 'failed';

function getProviderRequirement(mode: 'image' | 'video' | 'sound', provider: string): StudioProviderRequirement | null {
  if (mode === 'video' && provider === 'bytedance') return 'kie';
  if (mode === 'image' && provider === 'openai') return 'openai';
  if (((mode === 'image' || mode === 'sound') && provider === 'gemini') || (mode === 'video' && provider === 'veo')) return 'gemini';
  return null;
}

function hasProviderAccess(config: StudioProviderConfig, provider: StudioProviderRequirement): boolean {
  return config.localApiKeys[provider] || config.managedMediaAvailable;
}

export function getMissingProviderRequirement(
  config: StudioProviderConfig,
  mode: 'image' | 'video' | 'sound',
  provider: string,
): StudioProviderRequirement | null {
  const requirement = getProviderRequirement(mode, provider);
  return requirement && !hasProviderAccess(config, requirement) ? requirement : null;
}

export function canUseStudioProvider(
  config: StudioProviderConfig,
  status: StudioProviderConfigStatus,
  mode: 'image' | 'video' | 'sound',
  provider: string,
): boolean {
  const requirement = getProviderRequirement(mode, provider);
  // A failed refresh must not discard access already confirmed by the server.
  return requirement ? hasProviderAccess(config, requirement) : status === 'ready';
}

export function parseStudioProviderConfig(value: unknown): StudioProviderConfig | null {
  if (!value || typeof value !== 'object') return null;
  const config = value as Partial<StudioProviderConfig>;
  if (!config.localApiKeys || typeof config.localApiKeys !== 'object') return null;
  if (!['gemini', 'openai', 'kie'].every((provider) => typeof config.localApiKeys?.[provider as StudioProviderRequirement] === 'boolean')) return null;
  if (typeof config.managedMediaAvailable !== 'boolean' || typeof config.canManageCentralCredentials !== 'boolean') return null;
  return config as StudioProviderConfig;
}

export function useStudioProviderConfig(initialProviderConfig: StudioProviderConfig) {
  const [providerConfig, setProviderConfig] = useState(initialProviderConfig);
  const [providerConfigStatus, setProviderConfigStatus] = useState<StudioProviderConfigStatus>('checking');
  const request = useRef<AbortController | null>(null);

  const refreshProviderConfig = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setProviderConfigStatus('checking');
    try {
      const response = await studioApiFetch('/api/studio/config', { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error('Studio provider configuration is unavailable');
      const payload = await response.json();
      const config = payload?.success === true ? parseStudioProviderConfig(payload.config) : null;
      if (!config) throw new Error('Studio provider configuration is invalid');
      if (controller.signal.aborted) return;
      setProviderConfig(config);
      setProviderConfigStatus('ready');
    } catch {
      if (!controller.signal.aborted) setProviderConfigStatus('failed');
    }
  }, []);

  useEffect(() => {
    startTransition(() => { void refreshProviderConfig(); });
    return () => request.current?.abort();
  }, [refreshProviderConfig]);

  return { providerConfig, providerConfigStatus, refreshProviderConfig };
}
