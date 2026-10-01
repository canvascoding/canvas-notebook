'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type SecretScope = 'user' | 'organization' | 'system';
type SecretCategory = 'agent-runtime' | 'media' | 'integrations' | 'other';
type CategoryFilter = 'all' | SecretCategory;
type EditorMode = 'keys' | 'raw';

interface SecretEntry {
  key: string;
  value: string;
  categories?: SecretCategory[];
  reserved?: boolean;
}

interface SecretState {
  entries: SecretEntry[];
  rawContent: string;
  revision: string;
  readable?: boolean;
  readinessCode?: string;
}

interface DraftEntry extends SecretEntry {
  id: string;
}

interface ApiResponse {
  success?: boolean;
  data?: SecretState;
  error?: string;
  code?: string;
}

export interface UnifiedSecretsEditorProps {
  language: 'de' | 'en';
  isAdmin: boolean;
  onSaved?: () => void | Promise<void>;
  developerMode?: boolean;
}

const copy = {
  en: {
    title: 'Secrets and variables',
    description: 'Manage API keys and other values for your connections. Changes are saved only when you choose Save.',
    scope: 'Scope',
    user: 'Personal',
    organization: 'Organization',
    system: 'System',
    category: 'Category',
    all: 'All categories',
    'agent-runtime': 'Agent runtime',
    media: 'Media generation',
    integrations: 'Integrations',
    other: 'Other',
    mode: 'Editor',
    keysMode: 'Form',
    rawMode: 'ENV text',
    key: 'Environment variable',
    value: 'Value',
    keyPlaceholder: 'VARIABLE_NAME',
    valuePlaceholder: 'Enter a value',
    add: 'Add variable',
    remove: 'Remove variable',
    save: 'Save changes',
    reload: 'Reload',
    loading: 'Loading environment settings…',
    saving: 'Saving…',
    loadError: 'Could not load environment settings.',
    saveError: 'Could not save environment settings.',
    saved: 'Changes saved.',
    empty: 'No variables in this category.',
    rawDescription: 'Raw editing keeps comments and formatting. Protected settings are preserved by the server.',
    rawLabel: 'Environment file contents',
    reveal: 'Show value',
    conceal: 'Hide value',
    conflict: 'These settings changed since you loaded them. Reload the latest version before saving again.',
    reloadConflict: 'Reload latest version',
    dirtyPrompt: 'Discard unsaved changes and continue?',
    categoryPrompt: 'You have unsaved changes. Continue to another category? Your edits will stay in the editor.',
    invalidKey: 'Use a valid environment variable name for every edited row.',
    duplicateKey: 'Each environment variable name must be unique.',
    unreadable: 'This environment scope cannot be read.',
    loadedNotice: 'The editor is up to date.',
    master_key_missing: 'Saved secrets cannot be read. Ask the instance administrator to restore their original master key in the deployment configuration. Then reload this page.',
    decryption_failed: 'Saved secrets could not be unlocked. Ask the instance administrator to check the original encryption key and restore intact data. Changes are blocked until recovery.',
    invalid_secret_format: 'Saved secret data is damaged or unsupported. Ask the instance administrator to restore an intact backup before making changes.',
    mcp_credential_key_missing: 'The encryption key for existing MCP connections is missing. Ask the instance administrator to restore the original key before connecting.',
    recoveryLink: 'Open Secrets settings',
  },
  de: {
    title: 'Secrets und Variablen',
    description: 'Verwalte API-Schlüssel und weitere Werte für deine Verbindungen. Änderungen werden erst gespeichert, wenn du Speichern auswählst.',
    scope: 'Bereich',
    user: 'Persönlich',
    organization: 'Organisation',
    system: 'System',
    category: 'Kategorie',
    all: 'Alle Kategorien',
    'agent-runtime': 'Agent Runtime',
    media: 'Mediengenerierung',
    integrations: 'Integrationen',
    other: 'Sonstiges',
    mode: 'Editor',
    keysMode: 'Formular',
    rawMode: 'ENV-Text',
    key: 'Umgebungsvariable',
    value: 'Wert',
    keyPlaceholder: 'VARIABLENNAME',
    valuePlaceholder: 'Wert eingeben',
    add: 'Variable hinzufügen',
    remove: 'Variable entfernen',
    save: 'Änderungen speichern',
    reload: 'Neu laden',
    loading: 'Umgebungseinstellungen werden geladen…',
    saving: 'Wird gespeichert…',
    loadError: 'Umgebungseinstellungen konnten nicht geladen werden.',
    saveError: 'Umgebungseinstellungen konnten nicht gespeichert werden.',
    saved: 'Änderungen gespeichert.',
    empty: 'Keine Variablen in dieser Kategorie.',
    rawDescription: 'Die Rohtextbearbeitung erhält Kommentare und Formatierung. Geschützte Einstellungen bewahrt der Server.',
    rawLabel: 'Inhalt der Umgebungsdatei',
    reveal: 'Wert anzeigen',
    conceal: 'Wert ausblenden',
    conflict: 'Diese Einstellungen wurden seit dem Laden geändert. Lade die aktuelle Version, bevor du erneut speicherst.',
    reloadConflict: 'Aktuelle Version laden',
    dirtyPrompt: 'Ungespeicherte Änderungen verwerfen und fortfahren?',
    categoryPrompt: 'Du hast ungespeicherte Änderungen. Zur anderen Kategorie wechseln? Deine Eingaben bleiben im Editor erhalten.',
    invalidKey: 'Verwende für jede bearbeitete Zeile einen gültigen Umgebungsvariablennamen.',
    duplicateKey: 'Jeder Umgebungsvariablenname darf nur einmal vorkommen.',
    unreadable: 'Dieser Umgebungsbereich kann nicht gelesen werden.',
    loadedNotice: 'Der Editor ist aktuell.',
    master_key_missing: 'Gespeicherte Secrets können nicht gelesen werden. Bitte die Instanzadministration, den ursprünglichen Master-Schlüssel in der Deployment-Konfiguration wiederherzustellen. Lade danach diese Seite neu.',
    decryption_failed: 'Gespeicherte Secrets konnten nicht entschlüsselt werden. Bitte die Instanzadministration, den ursprünglichen Schlüssel und die gespeicherten Daten zu prüfen. Änderungen bleiben bis zur Wiederherstellung gesperrt.',
    invalid_secret_format: 'Die gespeicherten Secret-Daten sind beschädigt oder nicht unterstützt. Bitte die Instanzadministration, vor Änderungen ein intaktes Backup wiederherzustellen.',
    mcp_credential_key_missing: 'Der Verschlüsselungsschlüssel für vorhandene MCP-Verbindungen fehlt. Bitte die Instanzadministration, den ursprünglichen Schlüssel vor dem Verbinden wiederherzustellen.',
    recoveryLink: 'Secrets-Einstellungen öffnen',
  },
} as const;

const categoryOrder: CategoryFilter[] = ['all', 'agent-runtime', 'media', 'integrations', 'other'];

function createDraft(entries: SecretEntry[]): DraftEntry[] {
  return entries.map((entry, index) => ({ ...entry, id: `${entry.key}:${index}` }));
}

function responseError(payload: ApiResponse, fallback: string): string {
  return typeof payload.error === 'string' && payload.error.trim() ? payload.error : fallback;
}

export function UnifiedSecretsEditor({ language, isAdmin, onSaved, developerMode = false }: UnifiedSecretsEditorProps) {
  const t = copy[language];
  const instanceId = useId();
  const [secretScope, setSecretScope] = useState<SecretScope>('user');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [mode, setMode] = useState<EditorMode>('keys');
  const [state, setState] = useState<SecretState | null>(null);
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [rawDraft, setRawDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const requestId = useRef(0);
  const copyRef = useRef(t);

  useEffect(() => { copyRef.current = t; }, [t]);
  useEffect(() => {
    if (developerMode) return;
    const timer = window.setTimeout(() => setMode('keys'), 0);
    return () => window.clearTimeout(timer);
  }, [developerMode]);
  const editorMode: EditorMode = developerMode ? mode : 'keys';

  const dirty = useMemo(() => {
    if (!state) return false;
    if (editorMode === 'raw') return rawDraft !== state.rawContent;
    return JSON.stringify(draft.map(({ id: _id, ...entry }) => entry)) !== JSON.stringify(createDraft(state.entries).map(({ id: _id, ...entry }) => entry));
  }, [draft, editorMode, rawDraft, state]);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setSaved(false);
    setConflict(false);
    try {
      const query = new URLSearchParams({ scope: 'all', secretScope });
      const response = await fetch(`/api/integrations/env?${query.toString()}`, { credentials: 'include', cache: 'no-store' });
      const payload = await response.json() as ApiResponse;
      if (current !== requestId.current) return;
      setErrorCode(payload.code || payload.data?.readinessCode || null);
      if (!response.ok || !payload.success || !payload.data) throw new Error(responseError(payload, copyRef.current.loadError));
      if (current !== requestId.current) return;
      if (payload.data.readable === false) throw new Error(copyRef.current.unreadable);
      const next = payload.data;
      setState(next);
      setDraft(createDraft(next.entries ?? []));
      setRawDraft(next.rawContent ?? '');
      setRevealed({});
    } catch (loadError) {
      if (current === requestId.current) {
        setState(null);
        setDraft([]);
        setRawDraft('');
        setError(loadError instanceof Error ? loadError.message : copyRef.current.loadError);
      }
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, [secretScope]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => {
      window.clearTimeout(timer);
      requestId.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const onExternalSave = (event: Event) => {
      const detail = (event as CustomEvent<{ secretScope?: SecretScope; origin?: string }>).detail;
      if (detail?.origin === instanceId || detail?.secretScope !== secretScope) return;
      if (dirty) setConflict(true);
      else void load();
    };
    window.addEventListener('canvas_secrets_updated', onExternalSave);
    return () => window.removeEventListener('canvas_secrets_updated', onExternalSave);
  }, [dirty, instanceId, load, secretScope]);

  const confirmDiscard = useCallback(() => !dirty || window.confirm(t.dirtyPrompt), [dirty, t.dirtyPrompt]);

  const changeScope = (next: SecretScope) => {
    if (next === secretScope || (next !== 'user' && !isAdmin) || !confirmDiscard()) return;
    setState(null);
    setDraft([]);
    setRawDraft('');
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setSecretScope(next);
  };

  const changeMode = (next: EditorMode) => {
    if (next === 'raw' && !developerMode) return;
    if (next === mode || !confirmDiscard()) return;
    if (state) {
      setDraft(createDraft(state.entries));
      setRawDraft(state.rawContent);
    }
    setMode(next);
    setError(null);
    setErrorCode(null);
    setConflict(false);
  };

  const changeCategory = (next: CategoryFilter) => {
    if (next === category || (dirty && !window.confirm(t.categoryPrompt))) return;
    setCategory(next);
    setError(null);
    setErrorCode(null);
  };

  const updateEntry = (id: string, patch: Partial<SecretEntry>) => {
    setDraft(entries => entries.map(entry => entry.id === id ? { ...entry, ...patch } : entry));
    setSaved(false);
  };

  const addEntry = () => {
    setDraft(entries => [...entries, { id: `new:${Date.now()}:${entries.length}`, key: '', value: '', categories: [category === 'all' ? 'other' : category] }]);
    setSaved(false);
  };

  const removeEntry = (id: string) => {
    setDraft(entries => entries.filter(entry => entry.id !== id));
    setSaved(false);
  };

  const save = async () => {
    if (!state || saving || !dirty) return;
    setSaving(true);
    setError(null);
    setErrorCode(null);
    setSaved(false);
    setConflict(false);
    try {
      const body = editorMode === 'raw'
        ? { scope: 'all', secretScope, mode: 'raw', rawContent: rawDraft, baseRevision: state.revision }
        : (() => {
            if (draft.some(entry => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.key.trim()))) throw new Error(t.invalidKey);
            const nextEntries = draft.map(({ id: _id, ...entry }) => ({ ...entry, key: entry.key.trim() }));
            const uniqueKeys = new Set(nextEntries.map(entry => entry.key));
            if (uniqueKeys.size !== nextEntries.length) throw new Error(t.duplicateKey);
            const before = new Map(state.entries.map(entry => [entry.key, entry.value]));
            const after = new Map(nextEntries.map(entry => [entry.key, entry.value]));
            const changes = new Map<string, string | null>();
            for (const key of before.keys()) if (!after.has(key)) changes.set(key, null);
            for (const [key, value] of after) if (before.get(key) !== value) changes.set(key, value);
            return { scope: 'all', secretScope, mode: 'patch', baseRevision: state.revision, patches: [...changes].map(([key, value]) => ({ key, value })) };
          })();
      const response = await fetch('/api/integrations/env', {
        method: editorMode === 'raw' ? 'PUT' : 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as ApiResponse;
      setErrorCode(payload.code || payload.data?.readinessCode || null);
      if (response.status === 409 && payload.code === 'SECRETS_REVISION_CONFLICT') {
        setConflict(true);
        return;
      }
      if (!response.ok || !payload.success || !payload.data) throw new Error(responseError(payload, t.saveError));
      setState(payload.data);
      setDraft(createDraft(payload.data.entries ?? []));
      setRawDraft(payload.data.rawContent ?? '');
      setSaved(true);
      window.dispatchEvent(new CustomEvent('canvas_secrets_updated', { detail: { secretScope, origin: instanceId } }));
      await onSaved?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t.saveError);
    } finally {
      setSaving(false);
    }
  };

  const visibleEntries = draft.filter(entry => !entry.reserved && (category === 'all' || entry.categories?.includes(category)));
  const recoveryMessage = errorCode && ['master_key_missing', 'decryption_failed', 'invalid_secret_format', 'mcp_credential_key_missing'].includes(errorCode) ? t[errorCode as keyof typeof t] : null;

  return (
    <Card data-testid="unified-secrets-editor" className="gap-0">
      <CardHeader className="gap-3">
        <div>
          <CardTitle>{t.title}</CardTitle>
          <CardDescription className="mt-1">{t.description}</CardDescription>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="unified-secrets-scope">{t.scope}</Label>
            <select id="unified-secrets-scope" data-testid="secret-scope" value={secretScope} onChange={event => changeScope(event.target.value as SecretScope)} disabled={loading || saving} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="user">{t.user}</option>
              {isAdmin && <option value="organization">{t.organization}</option>}
              {isAdmin && <option value="system">{t.system}</option>}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="unified-secrets-category">{t.category}</Label>
            <select id="unified-secrets-category" data-testid="secret-category" value={category} onChange={event => changeCategory(event.target.value as CategoryFilter)} disabled={loading || saving || editorMode === 'raw'} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              {categoryOrder.map(item => <option key={item} value={item}>{t[item]}</option>)}
            </select>
          </div>
          {developerMode && (
            <div className="grid gap-1.5">
              <Label htmlFor="unified-secrets-mode">{t.mode}</Label>
              <select id="unified-secrets-mode" data-testid="secret-editor-mode" value={mode} onChange={event => changeMode(event.target.value as EditorMode)} disabled={loading || saving} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="keys">{t.keysMode}</option>
                <option value="raw">{t.rawMode}</option>
              </select>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t.loading}</div> : null}
        {!loading && error ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{recoveryMessage || error}</p>{recoveryMessage && <Link href="/settings?tab=secrets" className="inline-block underline underline-offset-4">{t.recoveryLink}</Link>}</div> : null}
        {!loading && conflict ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>{t.conflict}</span>
            <Button type="button" variant="outline" onClick={() => { if (confirmDiscard()) void load(); }}>{t.reloadConflict}</Button>
          </div>
        ) : null}
        {!loading && saved ? <p role="status" className="text-sm text-primary">{t.saved}</p> : null}
        {!loading && state && editorMode === 'raw' && developerMode ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t.rawDescription}</p>
            <Label htmlFor="unified-secrets-raw">{t.rawLabel}</Label>
            <Textarea id="unified-secrets-raw" data-testid="secret-raw-content" value={rawDraft} onChange={event => { setRawDraft(event.target.value); setSaved(false); }} disabled={saving} rows={18} spellCheck={false} className="min-h-72 font-mono text-xs" />
          </div>
        ) : null}
        {!loading && state && editorMode === 'keys' ? (
          <div className="space-y-4">
            <div className="hidden grid-cols-[minmax(180px,0.8fr)_minmax(0,1.5fr)_auto] gap-3 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid">
              <span>{t.key}</span><span>{t.value}</span><span className="sr-only">{t.remove}</span>
            </div>
            {visibleEntries.length ? <div className="space-y-3">
              {visibleEntries.map((entry, index) => {
                const shown = Boolean(revealed[entry.id]);
                const isMultiline = /[\r\n]/u.test(entry.value);
                const inputValue = isMultiline && !shown ? entry.value.replace(/[\r\n]+/gu, ' ') : entry.value;
                const keyId = `secret-key-${index}`;
                const valueId = `secret-value-${index}`;
                return <div key={entry.id} data-testid="secret-entry" className="grid gap-2 sm:grid-cols-[minmax(180px,0.8fr)_minmax(0,1.5fr)_auto] sm:items-end">
                  <div className="grid min-w-0 gap-1.5">
                    <Label htmlFor={keyId} className="sm:sr-only">{t.key}</Label>
                    <Input id={keyId} data-testid="secret-entry-key" value={entry.key} placeholder={t.keyPlaceholder} onChange={event => updateEntry(entry.id, { key: event.target.value })} disabled={saving || entry.reserved} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                  </div>
                  <div className="relative min-w-0">
                    <Label htmlFor={valueId} className="mb-1.5 block sm:sr-only">{t.value}</Label>
                    {isMultiline && shown ? (
                      <Textarea id={valueId} data-testid="secret-entry-value" value={entry.value} placeholder={t.valuePlaceholder} onChange={event => updateEntry(entry.id, { value: event.target.value })} disabled={saving || entry.reserved} rows={Math.min(8, Math.max(3, entry.value.split(/\r?\n/u).length + 1))} className="min-h-16 pr-11 text-sm" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                    ) : (
                      <Input id={valueId} data-testid="secret-entry-value" type={shown ? 'text' : 'password'} value={inputValue} placeholder={t.valuePlaceholder} onChange={event => updateEntry(entry.id, { value: event.target.value })} readOnly={isMultiline} disabled={saving || entry.reserved} className="pr-11" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                    )}
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={shown ? t.conceal : t.reveal} onClick={() => setRevealed(current => ({ ...current, [entry.id]: !current[entry.id] }))} disabled={saving} className={isMultiline && shown ? 'absolute right-1 top-2' : 'absolute right-1 top-1/2 -translate-y-1/2'}><span className="sr-only">{shown ? t.conceal : t.reveal}</span>{shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button>
                  </div>
                  <Button type="button" variant="outline" size="icon-sm" aria-label={t.remove} data-testid="secret-entry-remove" onClick={() => removeEntry(entry.id)} disabled={saving || entry.reserved} className="justify-self-start sm:justify-self-end"><Trash2 className="h-4 w-4" /></Button>
                  {entry.categories?.length ? <div className="sm:col-span-3 flex flex-wrap gap-1">{entry.categories.map(item => <Badge key={item} variant="secondary" className="text-[10px]">{t[item]}</Badge>)}</div> : null}
                </div>;
              })}
            </div> : <p className="text-sm text-muted-foreground">{t.empty}</p>}
            <Button type="button" variant="outline" data-testid="secret-add-entry" onClick={addEntry} disabled={saving}><Plus className="mr-1 h-4 w-4" />{t.add}</Button>
          </div>
        ) : null}
        {!loading && state ? <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button type="button" data-testid="secret-save" onClick={() => void save()} disabled={saving || loading || !dirty || conflict}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{saving ? t.saving : t.save}
          </Button>
          <Button type="button" variant="outline" data-testid="secret-reload" onClick={() => { if (confirmDiscard()) void load(); }} disabled={saving || loading}><RefreshCw className="mr-2 h-4 w-4" />{t.reload}</Button>
        </div> : null}
      </CardContent>
    </Card>
  );
}
