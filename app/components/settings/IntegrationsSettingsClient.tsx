'use client';

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface EnvEntry {
  key: string;
  value: string;
  encrypted: boolean;
}

interface EnvState {
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

const DEFAULT_KEYS = ['GOOGLE_API_KEY', 'API_KEY', 'GEMINI_API_KEY', 'NANO_BANANA_API_KEY'];

function createDraftEntry(entry?: Partial<EnvEntry>): DraftEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    key: entry?.key || '',
    value: entry?.value || '',
    encrypted: Boolean(entry?.encrypted),
  };
}

function toDefaultDraftEntries(): DraftEntry[] {
  return DEFAULT_KEYS.map((key) => createDraftEntry({ key, value: '', encrypted: false }));
}

function toDraftEntries(entries: EnvEntry[]): DraftEntry[] {
  if (!entries || entries.length === 0) {
    return toDefaultDraftEntries();
  }
  return entries.map((entry) => createDraftEntry(entry));
}

export function IntegrationsSettingsClient() {
  const [state, setState] = useState<EnvState | null>(null);
  const [draftEntries, setDraftEntries] = useState<DraftEntry[]>(toDefaultDraftEntries);
  const [rawContent, setRawContent] = useState('');
  const [activeTab, setActiveTab] = useState<'kv' | 'raw'>('kv');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadState = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/integrations/env', { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to load integrations env');
      }
      const nextState: EnvState = payload.data;
      setState(nextState);
      setDraftEntries(toDraftEntries(nextState.entries));
      setRawContent(nextState.rawContent);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load integrations env';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadState();
  }, []);

  const saveKeyValue = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch('/api/integrations/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode: 'kv',
          entries: draftEntries
            .map((entry) => ({ key: entry.key.trim(), value: entry.value }))
            .filter((entry) => entry.key.length > 0),
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to save integrations env');
      }
      const nextState: EnvState = payload.data;
      setState(nextState);
      setDraftEntries(toDraftEntries(nextState.entries));
      setRawContent(nextState.rawContent);
      setSuccess('Einstellungen gespeichert.');
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Failed to save integrations env';
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const saveRaw = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch('/api/integrations/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode: 'raw',
          rawContent,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to save raw env');
      }
      const nextState: EnvState = payload.data;
      setState(nextState);
      setDraftEntries(toDraftEntries(nextState.entries));
      setRawContent(nextState.rawContent);
      setSuccess('Raw-Env gespeichert.');
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Failed to save raw env';
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const updateDraftEntry = (index: number, patch: Partial<DraftEntry>) => {
    setDraftEntries((current) =>
      current.map((entry, currentIndex) => (currentIndex === index ? { ...entry, ...patch } : entry))
    );
  };

  const removeDraftEntry = (index: number) => {
    setDraftEntries((current) => {
      if (current.length <= 1) {
        return [createDraftEntry()];
      }
      return current.filter((_, currentIndex) => currentIndex !== index);
    });
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Integrations Settings</CardTitle>
          <CardDescription>
            API-Keys und Env-Variablen für VEO 3 und Nano Banana. Datei liegt unter{' '}
            <span className="font-mono">{state?.path || '/home/node/canvas-integrations.env'}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Lade Konfiguration...
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Format: .env</span>
                <span>•</span>
                <span>Berechtigung: 0600</span>
                <span>•</span>
                <span>{state?.encryptionEnabled ? 'Verschlüsselung aktiv' : 'Verschlüsselung inaktiv'}</span>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
              {success && <p className="text-sm text-primary">{success}</p>}

              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'kv' | 'raw')}>
                <TabsList>
                  <TabsTrigger value="kv">Key / Value</TabsTrigger>
                  <TabsTrigger value="raw">Raw .env</TabsTrigger>
                </TabsList>

                <TabsContent value="kv" className="space-y-2">
                  <div className="space-y-2">
                    {draftEntries.map((entry, index) => (
                      <div key={entry.id} className="flex items-center gap-2">
                        <Input
                          placeholder="KEY_NAME"
                          value={entry.key}
                          onChange={(event) => updateDraftEntry(index, { key: event.target.value })}
                          disabled={isSaving}
                        />
                        <Input
                          placeholder={entry.encrypted ? 'Encrypted value' : 'value'}
                          value={entry.value}
                          onChange={(event) => updateDraftEntry(index, { value: event.target.value })}
                          disabled={isSaving}
                        />
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label="Delete row"
                          onClick={() => removeDraftEntry(index)}
                          disabled={isSaving}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setDraftEntries((current) => [...current, createDraftEntry()])}
                      disabled={isSaving}
                    >
                      <Plus className="mr-1 h-4 w-4" />
                      Zeile hinzufügen
                    </Button>
                    <Button type="button" onClick={() => void saveKeyValue()} disabled={isSaving || isLoading}>
                      {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Speichern
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="raw" className="space-y-2">
                  <textarea
                    className="min-h-[360px] w-full border border-input bg-background p-3 font-mono text-sm"
                    value={rawContent}
                    onChange={(event) => setRawContent(event.target.value)}
                    spellCheck={false}
                    disabled={isSaving}
                  />
                  <div className="flex gap-2">
                    <Button type="button" onClick={() => void saveRaw()} disabled={isSaving || isLoading}>
                      {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Raw speichern
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void loadState()} disabled={isSaving}>
                      Neu laden
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
