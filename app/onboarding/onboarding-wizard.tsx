'use client';

import { useState, type FormEvent } from 'react';
import Image from 'next/image';

import { PiProviderSetupCard } from '@/app/components/settings/PiProviderSetupCard';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

type Step = 'account' | 'provider' | 'done';

const STEPS: Step[] = ['account', 'provider', 'done'];

export default function OnboardingWizard() {
  const [step, setStep] = useState<Step>('account');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [accountLoading, setAccountLoading] = useState(false);

  async function handleAccountSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (password !== confirmPassword) {
      toast.error('Passwörter stimmen nicht überein');
      return;
    }

    setAccountLoading(true);
    try {
      const response = await fetch('/api/onboarding/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error || 'Account konnte nicht erstellt werden');
        return;
      }

      setStep('provider');
    } catch {
      toast.error('Unerwarteter Fehler beim Erstellen des Accounts');
    } finally {
      setAccountLoading(false);
    }
  }

  function handleDone() {
    window.location.href = '/';
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-4 sm:px-6">
        <div className="mb-4 flex justify-end">
          <ThemeToggle />
        </div>

        <div className="flex flex-1 items-center justify-center py-4">
          <div className={`w-full ${step === 'provider' ? 'max-w-5xl' : 'max-w-lg'}`}>
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
              <div className="mb-2 flex items-center justify-center">
                <Image
                  src="/logo.jpg"
                  alt="Canvas Logo"
                  width={48}
                  height={48}
                  className="mr-3 border border-border"
                />
                <h1 className="text-3xl font-bold">Canvas Notebook</h1>
              </div>

              <div className="mb-8 flex justify-center gap-2">
                {STEPS.map((currentStep, index) => (
                  <div key={currentStep} className="flex items-center gap-2">
                    <div
                      className={`h-2 w-2 rounded-full transition-colors ${
                        step === currentStep ? 'bg-foreground' : 'bg-muted-foreground/30'
                      }`}
                    />
                    {index < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
                  </div>
                ))}
              </div>

              {step === 'account' && (
                <>
                  <h2 className="mb-1 text-xl font-semibold">Willkommen!</h2>
                  <p className="mb-6 text-sm text-muted-foreground">
                    Erstelle deinen Admin-Account für Canvas Notebook.
                  </p>

                  <form onSubmit={handleAccountSubmit} className="space-y-4">
                    <div>
                      <label htmlFor="name" className="mb-1 block text-sm font-medium text-foreground/90">
                        Name
                      </label>
                      <Input
                        id="name"
                        type="text"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Dein Name"
                        className="placeholder:text-muted-foreground"
                        required
                        autoFocus
                      />
                    </div>

                    <div>
                      <label htmlFor="email" className="mb-1 block text-sm font-medium text-foreground/90">
                        E-Mail
                      </label>
                      <Input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="du@example.com"
                        className="placeholder:text-muted-foreground"
                        required
                      />
                    </div>

                    <div>
                      <label htmlFor="password" className="mb-1 block text-sm font-medium text-foreground/90">
                        Passwort
                      </label>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Mindestens 8 Zeichen"
                        className="placeholder:text-muted-foreground"
                        required
                        minLength={8}
                      />
                    </div>

                    <div>
                      <label htmlFor="confirmPassword" className="mb-1 block text-sm font-medium text-foreground/90">
                        Passwort bestätigen
                      </label>
                      <Input
                        id="confirmPassword"
                        type="password"
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        placeholder="Passwort wiederholen"
                        className="placeholder:text-muted-foreground"
                        required
                        minLength={8}
                      />
                    </div>

                    <Button type="submit" className="mt-2 w-full" disabled={accountLoading}>
                      {accountLoading ? 'Account wird erstellt...' : 'Account erstellen'}
                    </Button>
                  </form>
                </>
              )}

              {step === 'provider' && (
                <div className="space-y-6">
                  <div>
                    <h2 className="mb-1 text-xl font-semibold">KI-Provider einrichten</h2>
                    <p className="text-sm text-muted-foreground">
                      Dieselbe Provider-Konfiguration aus den Settings steht dir hier direkt im Onboarding zur Verfügung.
                      Sessions und Systemprompt-Verwaltung folgen später in den Einstellungen.
                    </p>
                  </div>

                  <PiProviderSetupCard
                    title="Provider & Modell"
                    description="Wähle deinen Provider, richte Authentifizierung ein und speichere dieselbe PI-Konfiguration wie später unter Settings."
                    saveButtonLabel="Provider speichern & weiter"
                    saveSuccessMessage="Provider-Konfiguration gespeichert."
                    onSaved={() => {
                      toast.success('Provider eingerichtet!');
                      setStep('done');
                    }}
                  />

                  <div className="flex justify-end">
                    <Button variant="outline" onClick={() => setStep('done')}>
                      Später einrichten
                    </Button>
                  </div>
                </div>
              )}

              {step === 'done' && (
                <div className="text-center">
                  <div className="mb-4 text-4xl">✓</div>
                  <h2 className="mb-2 text-xl font-semibold">Einrichtung abgeschlossen</h2>
                  <p className="mb-8 text-sm text-muted-foreground">
                    Dein Account ist bereit. Provider, Modelle und weitere Agent-Einstellungen kannst du jederzeit unter
                    Settings anpassen.
                  </p>
                  <Button onClick={handleDone} className="w-full">
                    Zur App
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
