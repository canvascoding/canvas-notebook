'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { AgentSettingsPanel } from '@/app/components/settings/AgentSettingsPanel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type EnvScope = 'integrations' | 'agents';

interface EnvEntry {
  key: string;
  value: string;
  encrypted: boolean;
}

interface EnvState {
  scope: EnvScope;
  path: string;
  exists: boolean;
  rawContent: string;
  entries: EnvEntry[];
  encryptionEnabled: boolean;
}

interface DraftEntry {
  id: string;
  key: string;
  value: string;
  encrypted: boolean;
}

type ScopeEditorState = {
  state: EnvState | null;
  draftEntries: DraftEntry[];
  rawContent: string;
  activeTab: 'kv' | 'raw';
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  success: string | null;
  secretVisibilityById: Record<string, boolean>;
};

type ScopeCardConfig = {
  scope: EnvScope;
  emptyPath: string;
  keyHint: string;
};

const DEFAULT_SCOPE_KEYS: Record<EnvScope, string[]> = {
  integrations: ['GEMINI_API_KEY'],
  agents: ['OPENROUTER_API_KEY', 'OLLAMA_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
};

const INITIAL_SCOPE_STATE = (scope: EnvScope): ScopeEditorState => ({
  state: null,
  draftEntries: toDefaultDraftEntries(scope),
  rawContent: '',
  activeTab: 'kv',
  isLoading: true,
  isSaving: false,
  error: null,
  success: null,
  secretVisibilityById: {},
});

const SCOPE_CARDS: ScopeCardConfig[] = [
  {
    scope: 'integrations',
    emptyPath: '/data/secrets/Canvas-Integrations.env',
    keyHint: 'Canvas-Integrations.env',
  },
  {
    scope: 'agents',
    emptyPath: '/data/secrets/Canvas-Agents.env',
    keyHint: 'Canvas-Agents.env',
  },
];

function normalizeKeyForSecretCheck(key: string): string {
  return key.trim().toUpperCase();
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKeyForSecretCheck(key);
  if (normalized.endsWith('_KEY_SOURCE')) {
    return false;
  }
  return (
    normalized.endsWith('_KEY') ||
    normalized.includes('_TOKEN') ||
    normalized.includes('TOKEN') ||
    normalized.includes('SECRET') ||
    normalized.includes('PASSWORD')
  );
}

function createDraftEntry(entry?: Partial<EnvEntry>): DraftEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    key: entry?.key || '',
    value: entry?.value || '',
    encrypted: Boolean(entry?.encrypted),
  };
}

function toDefaultDraftEntries(scope: EnvScope): DraftEntry[] {
  return DEFAULT_SCOPE_KEYS[scope].map((key) => createDraftEntry({ key, value: '', encrypted: false }));
}

function toDraftEntries(scope: EnvScope, entries: EnvEntry[]): DraftEntry[] {
  if (!entries || entries.length === 0) {
    return toDefaultDraftEntries(scope);
  }

  const existingEntries = entries.map((entry) => createDraftEntry(entry));
  const existingKeys = new Set(entries.map((entry) => entry.key.trim().toUpperCase()).filter(Boolean));
  const missingDefaults = DEFAULT_SCOPE_KEYS[scope]
    .filter((key) => !existingKeys.has(key.toUpperCase()))
    .map((key) => createDraftEntry({ key, value: '', encrypted: false }));

  return [...existingEntries, ...missingDefaults];
}

function buildHiddenState(entries: DraftEntry[]): Record<string, boolean> {
  return Object.fromEntries(entries.map((entry) => [entry.id, false])) as Record<string, boolean>;
}

function EnvEditorCard(props: {
  card: ScopeCardConfig;
  editor: ScopeEditorState;
  onActiveTabChange: (scope: EnvScope, value: 'kv' | 'raw') => void;
  onLoad: (scope: EnvScope) => Promise<void>;
  onAddEntry: (scope: EnvScope) => void;
  onRemoveEntry: (scope: EnvScope, index: number) => void;
  onUpdateEntry: (scope: EnvScope, index: number, patch: Partial<DraftEntry>) => void;
  onToggleSecret: (scope: EnvScope, entryId: string) => void;
  onRawChange: (scope: EnvScope, value: string) => void;
  onSaveKeyValue: (scope: EnvScope) => Promise<void>;
  onSaveRaw: (scope: EnvScope) => Promise<void>;
}) {
  const t = useTranslations('settings');
  const {
    card,
    editor,
    onActiveTabChange,
    onAddEntry,
    onLoad,
    onRawChange,
    onRemoveEntry,
    onSaveKeyValue,
    onSaveRaw,
    onToggleSecret,
    onUpdateEntry,
  } = props;

  return (
    <Card>
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>{t(`scopes.${card.scope}.title`)}</CardTitle>
        <CardDescription>
          {t(`scopes.${card.scope}.description`)} {t('envCard.fileLocatedAt')}{' '}
          <span className="break-all font-mono">{editor.state?.path || card.emptyPath}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
        {editor.isLoading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('envCard.loadingConfig')}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t('envCard.fileLabel')}: {card.keyHint}</span>
              <span>•</span>
              <span>{t('envCard.formatLabel')}: .env</span>
              <span>•</span>
              <span>{t('envCard.permissionsLabel')}: 0600</span>
              <span>•</span>
              <span>{editor.state?.encryptionEnabled ? t('envCard.encryptionActive') : t('envCard.encryptionInactive')}</span>
            </div>

            {editor.error && <p className="text-sm text-destructive">{editor.error}</p>}
            {editor.success && <p className="text-sm text-primary">{editor.success}</p>}

            <Tabs
              value={editor.activeTab}
              onValueChange={(value) => onActiveTabChange(card.scope, value as 'kv' | 'raw')}
            >
              <TabsList className="grid h-auto w-full grid-cols-2">
                <TabsTrigger value="kv">{t('envCard.tabKeyValue')}</TabsTrigger>
                <TabsTrigger value="raw">{t('envCard.tabRaw')}</TabsTrigger>
              </TabsList>

              <TabsContent value="kv" className="space-y-3">
                <div className="hidden grid-cols-[minmax(220px,0.9fr)_minmax(0,1.6fr)_auto] gap-3 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase md:grid">
                  <span>{t('envCard.columnKey')}</span>
                  <span>{t('envCard.columnValue')}</span>
                  <span className="text-right">{t('envCard.columnAction')}</span>
                </div>

                <div className="space-y-3">
                  {editor.draftEntries.map((entry, index) => {
                    const secret = isSecretKey(entry.key);
                    const visible = Boolean(editor.secretVisibilityById[entry.id]);

                    return (
                      <div
                        key={entry.id}
                        className="grid gap-2 md:grid-cols-[minmax(220px,0.9fr)_minmax(0,1.6fr)_auto] md:items-center"
                      >
                        <Input
                          placeholder={t('envCard.placeholderKeyName')}
                          value={entry.key}
                          onChange={(event) => onUpdateEntry(card.scope, index, { key: event.target.value })}
                          disabled={editor.isSaving}
                        />
                        <div className="relative min-w-0">
                          <Input
                            type={secret && !visible ? 'password' : 'text'}
                            placeholder={entry.encrypted ? t('envCard.placeholderEncryptedValue') : t('envCard.placeholderValue')}
                            value={entry.value}
                            onChange={(event) => onUpdateEntry(card.scope, index, { value: event.target.value })}
                            disabled={editor.isSaving}
                            className={secret ? 'pr-11' : undefined}
                          />
                          {secret && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="absolute right-1 top-1/2 -translate-y-1/2"
                              aria-label={visible ? t('envCard.hideSecret') : t('envCard.showSecret')}
                              onClick={() => onToggleSecret(card.scope, entry.id)}
                              disabled={editor.isSaving}
                            >
                              {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label={t('envCard.deleteRow')}
                          onClick={() => onRemoveEntry(card.scope, index)}
                          disabled={editor.isSaving}
                          className="justify-self-start md:justify-self-end"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" onClick={() => onAddEntry(card.scope)} disabled={editor.isSaving}>
                    <Plus className="mr-1 h-4 w-4" />
                    {t('envCard.addRow')}
                  </Button>
                  <Button type="button" onClick={() => void onSaveKeyValue(card.scope)} disabled={editor.isSaving || editor.isLoading}>
                    {editor.isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('envCard.save')}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void onLoad(card.scope)} disabled={editor.isSaving}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('envCard.reload')}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="raw" className="space-y-2">
                <textarea
                  className="min-h-[360px] w-full rounded-md border border-input bg-background p-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={editor.rawContent}
                  onChange={(event) => onRawChange(card.scope, event.target.value)}
                  spellCheck={false}
                  disabled={editor.isSaving}
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void onSaveRaw(card.scope)} disabled={editor.isSaving || editor.isLoading}>
                    {editor.isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('envCard.saveRaw')}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void onLoad(card.scope)} disabled={editor.isSaving}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('envCard.reload')}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsSettingsClient() {
  const t = useTranslations('settings');
  const searchParams = useSearchParams();

  const [settingsTab, setSettingsTab] = useState<'integrations' | 'agent-settings'>('integrations');
  const [editors, setEditors] = useState<Record<EnvScope, ScopeEditorState>>({
    integrations: INITIAL_SCOPE_STATE('integrations'),
    agents: INITIAL_SCOPE_STATE('agents'),
  });

  const loadState = useCallback(async (scope: EnvScope) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        isLoading: true,
        error: null,
      },
    }));

    try {
      const response = await fetch(`/api/integrations/env?scope=${scope}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('envCard.errors.loadEnvFile'));
      }

      const nextState: EnvState = payload.data;
      const nextDraftEntries = toDraftEntries(scope, nextState.entries);
      setEditors((current) => ({
        ...current,
        [scope]: {
          ...current[scope],
          state: nextState,
          draftEntries: nextDraftEntries,
          rawContent: nextState.rawContent,
          isLoading: false,
          error: null,
          success: null,
          secretVisibilityById: buildHiddenState(nextDraftEntries),
        },
      }));
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : t('envCard.errors.loadEnvFile');
      setEditors((current) => ({
        ...current,
        [scope]: {
          ...current[scope],
          isLoading: false,
          error: message,
        },
      }));
    }
  }, [t]);

  useEffect(() => {
    void Promise.all(SCOPE_CARDS.map((card) => loadState(card.scope)));
  }, [loadState]);

  useEffect(() => {
    if (searchParams.get('tab') === 'agent-settings') {
      setSettingsTab('agent-settings');
    }
  }, [searchParams]);

  const saveScope = async (scope: EnvScope, payload: { mode: 'kv'; entries: Array<{ key: string; value: string }> } | { mode: 'raw'; rawContent: string }) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        isSaving: true,
        error: null,
        success: null,
      },
    }));

    try {
      const response = await fetch('/api/integrations/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          scope,
          ...payload,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || t('envCard.errors.saveEnvFile'));
      }

      const nextState: EnvState = result.data;
      const nextDraftEntries = toDraftEntries(scope, nextState.entries);
      setEditors((current) => ({
        ...current,
        [scope]: {
          ...current[scope],
          state: nextState,
          draftEntries: nextDraftEntries,
          rawContent: nextState.rawContent,
          isSaving: false,
          error: null,
          success: payload.mode === 'raw' ? t('envCard.rawSaved') : t('envCard.saved'),
          secretVisibilityById: buildHiddenState(nextDraftEntries),
        },
      }));
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : t('envCard.errors.saveEnvFile');
      setEditors((current) => ({
        ...current,
        [scope]: {
          ...current[scope],
          isSaving: false,
          error: message,
        },
      }));
    }
  };

  const setActiveTab = (scope: EnvScope, value: 'kv' | 'raw') => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        activeTab: value,
      },
    }));
  };

  const updateDraftEntry = (scope: EnvScope, index: number, patch: Partial<DraftEntry>) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        draftEntries: current[scope].draftEntries.map((entry, currentIndex) =>
          currentIndex === index ? { ...entry, ...patch } : entry
        ),
      },
    }));
  };

  const toggleSecretVisibility = (scope: EnvScope, entryId: string) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        secretVisibilityById: {
          ...current[scope].secretVisibilityById,
          [entryId]: !current[scope].secretVisibilityById[entryId],
        },
      },
    }));
  };

  const addDraftEntry = (scope: EnvScope) => {
    const entry = createDraftEntry();
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        draftEntries: [...current[scope].draftEntries, entry],
        secretVisibilityById: {
          ...current[scope].secretVisibilityById,
          [entry.id]: false,
        },
      },
    }));
  };

  const removeDraftEntry = (scope: EnvScope, index: number) => {
    setEditors((current) => {
      const editor = current[scope];
      const target = editor.draftEntries[index];
      if (editor.draftEntries.length <= 1) {
        const fallback = createDraftEntry();
        return {
          ...current,
          [scope]: {
            ...editor,
            draftEntries: [fallback],
            secretVisibilityById: { [fallback.id]: false },
          },
        };
      }

      const nextVisibility = { ...editor.secretVisibilityById };
      if (target) {
        delete nextVisibility[target.id];
      }

      return {
        ...current,
        [scope]: {
          ...editor,
          draftEntries: editor.draftEntries.filter((_, currentIndex) => currentIndex !== index),
          secretVisibilityById: nextVisibility,
        },
      };
    });
  };

  const setRawContent = (scope: EnvScope, value: string) => {
    setEditors((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        rawContent: value,
      },
    }));
  };

  const saveKeyValue = async (scope: EnvScope) => {
    const editor = editors[scope];
    await saveScope(scope, {
      mode: 'kv',
      entries: editor.draftEntries
        .map((entry) => ({ key: entry.key.trim(), value: entry.value }))
        .filter((entry) => entry.key.length > 0),
    });
  };

  const saveRaw = async (scope: EnvScope) => {
    await saveScope(scope, {
      mode: 'raw',
      rawContent: editors[scope].rawContent,
    });
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-6">
      <Tabs
        value={settingsTab}
        onValueChange={(value) => setSettingsTab(value as 'integrations' | 'agent-settings')}
        className="space-y-4"
      >
        <TabsList className="grid h-auto w-full grid-cols-1 gap-2 bg-transparent p-0 sm:grid-cols-2">
          <TabsTrigger value="integrations" className="min-h-9 border border-border data-[state=active]:bg-muted">
            {t('tabs.integrations')}
          </TabsTrigger>
          <TabsTrigger value="agent-settings" className="min-h-9 border border-border data-[state=active]:bg-muted">
            {t('tabs.agentSettings')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="integrations" className="space-y-4">
          {SCOPE_CARDS.map((card) => (
            <EnvEditorCard
              key={card.scope}
              card={card}
              editor={editors[card.scope]}
              onActiveTabChange={setActiveTab}
              onLoad={loadState}
              onAddEntry={addDraftEntry}
              onRemoveEntry={removeDraftEntry}
              onUpdateEntry={updateDraftEntry}
              onToggleSecret={toggleSecretVisibility}
              onRawChange={setRawContent}
              onSaveKeyValue={saveKeyValue}
              onSaveRaw={saveRaw}
            />
          ))}
        </TabsContent>

        <TabsContent value="agent-settings" className="space-y-4">
          <AgentSettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
