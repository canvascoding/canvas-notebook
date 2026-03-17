'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/app/lib/auth-client';
import { toast } from 'sonner';

type Step = 'account' | 'provider' | 'done';

interface ProviderOption {
  id: string;
  label: string;
  description: string;
  envVar: string;
  scope: 'agents';
  placeholder: string;
}

const PROVIDERS: ProviderOption[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Zugang zu hunderten KI-Modellen über einen einzigen API-Key.',
    envVar: 'OPENROUTER_API_KEY',
    scope: 'agents',
    placeholder: 'sk-or-...',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    description: 'Direkter Zugang zu Claude-Modellen von Anthropic.',
    envVar: 'ANTHROPIC_API_KEY',
    scope: 'agents',
    placeholder: 'sk-ant-...',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    description: 'Gemini-Modelle direkt über die Google AI API.',
    envVar: 'GEMINI_API_KEY',
    scope: 'agents',
    placeholder: 'AIza...',
  },
  {
    id: 'ollama',
    label: 'Ollama (lokal)',
    description: 'Lokale KI-Modelle, die auf deinem eigenen Gerät laufen.',
    envVar: '',
    scope: 'agents',
    placeholder: '',
  },
];

export default function OnboardingWizard() {
  const [step, setStep] = useState<Step>('account');

  // Account step
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [accountLoading, setAccountLoading] = useState(false);

  // Provider step
  const [selectedProvider, setSelectedProvider] = useState<ProviderOption | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [providerLoading, setProviderLoading] = useState(false);

  async function handleAccountSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast.error('Passwörter stimmen nicht überein');
      return;
    }

    setAccountLoading(true);
    try {
      // Create account via onboarding API
      const res = await fetch('/api/onboarding/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || 'Account konnte nicht erstellt werden');
        return;
      }

      // Sign in to get a session cookie
      const { error } = await authClient.signIn.email({ email, password });
      if (error) {
        toast.error('Account erstellt, aber Anmeldung fehlgeschlagen: ' + (error.message || ''));
        return;
      }

      setStep('provider');
    } catch {
      toast.error('Unerwarteter Fehler beim Erstellen des Accounts');
    } finally {
      setAccountLoading(false);
    }
  }

  async function handleProviderSave() {
    if (!selectedProvider || !apiKey.trim()) return;

    setProviderLoading(true);
    try {
      // Save API key to agents env scope
      const envRes = await fetch('/api/integrations/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'agents',
          entries: [{ key: selectedProvider.envVar, value: apiKey.trim() }],
        }),
      });

      if (!envRes.ok) {
        toast.error('API-Key konnte nicht gespeichert werden');
        return;
      }

      // Set as active provider
      const configRes = await fetch('/api/agents/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProvider: selectedProvider.id }),
      });

      if (!configRes.ok) {
        toast.error('Provider konnte nicht aktiviert werden');
        return;
      }

      toast.success('Provider eingerichtet!');
      setStep('done');
    } catch {
      toast.error('Fehler beim Speichern des Providers');
    } finally {
      setProviderLoading(false);
    }
  }

  function handleSkipProvider() {
    setStep('done');
  }

  function handleDone() {
    window.location.href = '/';
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg border border-border bg-card p-8 shadow-sm">

        {/* Header */}
        <div className="flex items-center justify-center mb-2">
          <Image src="/logo.jpg" alt="Canvas Logo" width={48} height={48} className="mr-3 border border-border" />
          <h1 className="text-3xl font-bold text-foreground">Canvas Notebook</h1>
        </div>

        {/* Step indicator */}
        <div className="flex justify-center gap-2 mb-8">
          {(['account', 'provider', 'done'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full transition-colors ${step === s ? 'bg-foreground' : 'bg-muted-foreground/30'}`} />
              {i < 2 && <div className="w-6 h-px bg-border" />}
            </div>
          ))}
        </div>

        {/* Step 1: Account */}
        {step === 'account' && (
          <>
            <h2 className="text-xl font-semibold text-foreground mb-1">Willkommen!</h2>
            <p className="text-sm text-muted-foreground mb-6">Erstelle deinen Admin-Account für Canvas Notebook.</p>

            <form onSubmit={handleAccountSubmit} className="space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-foreground/90 mb-1">Name</label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Dein Name"
                  className="placeholder:text-muted-foreground"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-foreground/90 mb-1">E-Mail</label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="du@example.com"
                  className="placeholder:text-muted-foreground"
                  required
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-foreground/90 mb-1">Passwort</label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mindestens 8 Zeichen"
                  className="placeholder:text-muted-foreground"
                  required
                  minLength={8}
                />
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-foreground/90 mb-1">Passwort bestätigen</label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Passwort wiederholen"
                  className="placeholder:text-muted-foreground"
                  required
                  minLength={8}
                />
              </div>

              <Button type="submit" className="w-full mt-2" disabled={accountLoading}>
                {accountLoading ? 'Account wird erstellt...' : 'Account erstellen'}
              </Button>
            </form>
          </>
        )}

        {/* Step 2: Provider */}
        {step === 'provider' && (
          <>
            <h2 className="text-xl font-semibold text-foreground mb-1">KI-Provider einrichten</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Wähle einen Anbieter aus, um den KI-Agenten zu aktivieren. Du kannst dies auch später in den Einstellungen konfigurieren.
            </p>

            <div className="space-y-2 mb-6">
              {PROVIDERS.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => {
                    setSelectedProvider(provider);
                    setApiKey('');
                  }}
                  className={`w-full text-left p-3 border rounded-sm transition-colors ${
                    selectedProvider?.id === provider.id
                      ? 'border-foreground bg-accent'
                      : 'border-border hover:bg-accent/50'
                  }`}
                >
                  <div className="font-medium text-sm text-foreground">{provider.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{provider.description}</div>
                </button>
              ))}
            </div>

            {selectedProvider && selectedProvider.envVar && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-foreground/90 mb-1">
                  {selectedProvider.envVar}
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={selectedProvider.placeholder}
                  className="placeholder:text-muted-foreground"
                  autoFocus
                />
              </div>
            )}

            {selectedProvider && !selectedProvider.envVar && (
              <p className="text-sm text-muted-foreground mb-4 p-3 bg-muted rounded-sm">
                Ollama läuft lokal und benötigt keinen API-Key. Du kannst die Verbindung in den Einstellungen konfigurieren.
              </p>
            )}

            <div className="flex gap-3">
              {selectedProvider && (selectedProvider.envVar ? apiKey.trim() : true) && (
                <Button
                  onClick={handleProviderSave}
                  disabled={providerLoading}
                  className="flex-1"
                >
                  {providerLoading ? 'Speichere...' : 'Speichern & Weiter'}
                </Button>
              )}
              <Button variant="outline" onClick={handleSkipProvider} className={selectedProvider && (selectedProvider.envVar ? apiKey.trim() : true) ? '' : 'w-full'}>
                Später einrichten
              </Button>
            </div>
          </>
        )}

        {/* Step 3: Done */}
        {step === 'done' && (
          <div className="text-center">
            <div className="text-4xl mb-4">✓</div>
            <h2 className="text-xl font-semibold text-foreground mb-2">Einrichtung abgeschlossen</h2>
            <p className="text-sm text-muted-foreground mb-8">
              Dein Account ist bereit. Du kannst den Provider jederzeit in den Einstellungen ändern.
            </p>
            <Button onClick={handleDone} className="w-full">
              Zur App
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
