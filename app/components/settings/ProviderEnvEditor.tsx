'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, Loader2, Save, Trash2, CheckCircle2, AlertCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProviderHelpInfo } from '@/app/lib/pi/provider-help';

interface EnvVarState {
  name: string;
  description: string;
  scope: 'agents' | 'integrations';
  required: boolean;
  value: string;
  isVisible: boolean;
  isDirty: boolean;
  exists: boolean;
}

interface ProviderEnvEditorProps {
  providerId: string;
  envVars: ProviderHelpInfo['envVars'];
  onSaveComplete?: () => void;
  onProviderActivate?: () => Promise<void>;
}

function getEnvPlaceholder(providerId: string, state: EnvVarState, t: ReturnType<typeof useTranslations>): string {
  if (providerId === 'ollama' && state.name === 'OLLAMA_API_KEY') {
    return t('providerEnv.placeholderOllama');
  }

  return t('providerEnv.placeholderGeneric');
}

function getEnvHelperText(providerId: string, state: EnvVarState, t: ReturnType<typeof useTranslations>): string | null {
  if (providerId === 'ollama' && state.name === 'OLLAMA_API_KEY') {
    return t('providerEnv.helperOllama');
  }

  return null;
}

export function ProviderEnvEditor({ providerId, envVars, onSaveComplete, onProviderActivate }: ProviderEnvEditorProps) {
  const t = useTranslations('settings');
  const [envStates, setEnvStates] = useState<EnvVarState[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Load current values for all env vars
  const loadEnvValues = useCallback(async () => {
    if (!envVars || envVars.length === 0) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const states: EnvVarState[] = await Promise.all(
        envVars.map(async (envVar) => {
          try {
            const response = await fetch(
              `/api/integrations/env?scope=${envVar.scope}&key=${encodeURIComponent(envVar.name)}`,
              { credentials: 'include' }
            );
            const data = await response.json();
            const existingEntry = data.success
              ? data.data.entries.find((e: { key: string }) => e.key === envVar.name)
              : null;

            return {
              name: envVar.name,
              description: envVar.description,
              scope: envVar.scope,
              required: envVar.required,
              value: existingEntry?.value || '',
              isVisible: false,
              isDirty: false,
              exists: !!existingEntry,
            };
          } catch {
            return {
              name: envVar.name,
              description: envVar.description,
              scope: envVar.scope,
              required: envVar.required,
              value: '',
              isVisible: false,
              isDirty: false,
              exists: false,
            };
          }
        })
      );

      setEnvStates(states);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to load env values:', error);
      setMessage({ type: 'error', text: t('providerEnv.errors.load') });
    } finally {
      setLoading(false);
    }
  }, [envVars, t]);

  useEffect(() => {
    loadEnvValues();
  }, [loadEnvValues]);

  const toggleVisibility = (index: number) => {
    setEnvStates((current) =>
      current.map((state, i) =>
        i === index ? { ...state, isVisible: !state.isVisible } : state
      )
    );
  };

  const updateValue = (index: number, newValue: string) => {
    setEnvStates((current) =>
      current.map((state, i) =>
        i === index
          ? { ...state, value: newValue, isDirty: newValue !== state.value }
          : state
      )
    );
    setHasChanges(true);
    setMessage(null);
  };

  const deleteValue = async (index: number) => {
    const state = envStates[index];
    if (!state.exists) {
      // Just clear the local value if it doesn't exist yet
      updateValue(index, '');
      return;
    }

    if (!confirm(t('providerEnv.confirmDelete', { name: state.name }))) {
      return;
    }

    setSaving(true);
    try {
      // Load all current entries for this scope
      const response = await fetch(`/api/integrations/env?scope=${state.scope}`, {
        credentials: 'include',
      });
      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || t('providerEnv.errors.loadCurrentEntries'));
      }

      // Filter out the entry to delete
      const currentEntries = data.data.entries.filter(
        (e: { key: string }) => e.key !== state.name
      );

      // Save filtered entries
      const saveResponse = await fetch('/api/integrations/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          scope: state.scope,
          mode: 'kv',
          entries: currentEntries.map((e: { key: string; value: string }) => ({
            key: e.key,
            value: e.value,
          })),
        }),
      });

      const saveData = await saveResponse.json();

      if (!saveData.success) {
        throw new Error(saveData.error || t('providerEnv.errors.delete'));
      }

      setEnvStates((current) =>
        current.map((s, i) =>
          i === index ? { ...s, value: '', exists: false, isDirty: false } : s
        )
      );

      setMessage({ type: 'success', text: t('providerEnv.deletedSuccess', { name: state.name }) });
      setHasChanges(false);
      onSaveComplete?.();
    } catch (error) {
      console.error('Failed to delete env value:', error);
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : t('providerEnv.errors.delete'),
      });
    } finally {
      setSaving(false);
    }
  };

  const saveAll = async () => {
    const missingRequired = envStates.filter((state) => {
      if (providerId === 'ollama' && state.name === 'OLLAMA_API_KEY') {
        return false;
      }

      return state.required && !state.value.trim();
    });
    if (missingRequired.length > 0) {
      const names = missingRequired.map((state) => state.name).join(', ');
      setMessage({
        type: 'error',
        text: t('providerEnv.fillRequired', { names }),
      });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      // First, activate the provider if callback is provided
      if (onProviderActivate) {
        await onProviderActivate();
      }

      // Group by scope
      const byScope: Record<string, EnvVarState[]> = {};

      envStates.forEach((state) => {
        if (state.value || state.exists) {
          // Only include if value is set or existed before
          if (!byScope[state.scope]) {
            byScope[state.scope] = [];
          }
          byScope[state.scope].push(state);
        }
      });

      // Save each scope
      for (const [scope, states] of Object.entries(byScope)) {
        // Load current entries
        const response = await fetch(`/api/integrations/env?scope=${scope}`, {
          credentials: 'include',
        });
        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || t('providerEnv.errors.loadEntriesForScope', { scope }));
        }

        // Build updated entries map
        const entriesMap = new Map<string, string>();
        data.data.entries.forEach((e: { key: string; value: string }) => {
          entriesMap.set(e.key, e.value);
        });

        // Update with new values
        states.forEach((state) => {
          if (state.value) {
            entriesMap.set(state.name, state.value);
          } else if (state.exists && !state.value) {
            // Remove if value is empty but existed before
            entriesMap.delete(state.name);
          }
        });

        // Save
        const saveResponse = await fetch('/api/integrations/env', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            scope,
            mode: 'kv',
            entries: Array.from(entriesMap.entries()).map(([key, value]) => ({
              key,
              value,
            })),
          }),
        });

        const saveData = await saveResponse.json();

        if (!saveData.success) {
          throw new Error(saveData.error || t('providerEnv.errors.saveScope', { scope }));
        }
      }

      // Update local state
      setEnvStates((current) =>
        current.map((state) => ({
          ...state,
          exists: !!state.value,
          isDirty: false,
        }))
      );

      const ollamaFallbackGenerated =
        providerId === 'ollama' &&
        envStates.some((state) => state.name === 'OLLAMA_API_KEY' && !state.value.trim());

      setMessage({
        type: 'success',
        text: ollamaFallbackGenerated
          ? t('providerEnv.savedOllama')
          : t('providerEnv.saved'),
      });
      setHasChanges(false);
      onSaveComplete?.();
    } catch (error) {
      console.error('Failed to save env values:', error);
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : t('providerEnv.errors.save'),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!envVars || envVars.length === 0) {
    return (
      <div className="rounded border border-border bg-muted/30 p-4">
        <p className="text-sm text-muted-foreground">
          {t('providerEnv.noEnvVars')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Message display */}
      {message && (
        <div
          className={`flex items-center gap-2 rounded border p-3 text-sm ${
            message.type === 'success'
              ? 'border-green-500/30 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-950/30 dark:text-green-400'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          {message.text}
        </div>
      )}

      {/* Dirty warning */}
      {hasChanges && (
        <div className="flex items-center gap-2 rounded border border-yellow-500/30 bg-yellow-50 p-3 text-sm text-yellow-700 dark:border-yellow-500/30 dark:bg-yellow-950/30 dark:text-yellow-400">
          <AlertCircle className="h-4 w-4" />
          {t('providerEnv.unsavedChanges')}
        </div>
      )}

      {/* Loading state */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('providerEnv.loading')}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Env var inputs */}
          {envStates.map((state, index) => (
            <div
              key={state.name}
              className="rounded border border-border bg-background p-3 space-y-2"
            >
              {/* Key display */}
              <div className="flex items-center justify-between">
                <code className="rounded bg-muted px-2 py-1 text-xs font-mono">
                  {state.name}
                  {state.required && (
                    <span className="ml-1 text-destructive">*</span>
                  )}
                </code>
                <span className="text-xs text-muted-foreground">
                  {state.scope === 'agents' ? t('providerEnv.scopeAgentEnvironment') : t('providerEnv.scopeIntegrations')}
                  {state.exists && !state.isDirty && (
                    <span className="ml-2 text-xs text-green-600 dark:text-green-400">
                      ✓ {t('providerEnv.savedIndicator')}
                    </span>
                  )}
                </span>
              </div>

              {/* Description */}
              <p className="text-xs text-muted-foreground">{state.description}</p>

              {/* Value input */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type={state.isVisible ? 'text' : 'password'}
                    value={state.value}
                    onChange={(e) => updateValue(index, e.target.value)}
                    placeholder={getEnvPlaceholder(providerId, state, t)}
                    disabled={saving}
                    className={state.isDirty ? 'border-yellow-500' : ''}
                  />
                  {state.value && (
                    <button
                      type="button"
                      onClick={() => toggleVisibility(index)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      disabled={saving}
                    >
                      {state.isVisible ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  )}
                </div>

                {/* Delete button */}
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => deleteValue(index)}
                  disabled={saving || !state.value}
                  className="shrink-0"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>

              {/* Not configured indicator */}
              {!state.value && !state.exists && (
                <p className="text-xs text-muted-foreground">
                  {providerId === 'ollama' && state.name === 'OLLAMA_API_KEY'
                    ? t('providerEnv.ollamaNotConfigured')
                    : state.required
                      ? t('providerEnv.requiredNotConfigured')
                      : t('providerEnv.notConfigured')}
                </p>
              )}

              {getEnvHelperText(providerId, state, t) && (
                <p className="text-xs text-muted-foreground">{getEnvHelperText(providerId, state, t)}</p>
              )}
            </div>
          ))}

          {/* Save all button */}
          <div className="flex gap-2 pt-2">
            <Button onClick={saveAll} disabled={saving || !hasChanges} className="flex-1">
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('providerEnv.saving')}
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  {t('providerEnv.saveAll')}
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={loadEnvValues}
              disabled={saving}
            >
              {t('providerEnv.reload')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
