'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { FileText, LockKeyhole, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fileGuestApi } from '@/app/lib/file-guests/types';
import type { CollaborationSessionResponse } from '@/app/lib/collaboration/types';

const GuestMarkdownEditor = dynamic(() => import('./GuestMarkdownEditor').then((module) => module.GuestMarkdownEditor), { ssr: false });
type GuestDocument = { fileName: string; path: string; markdown: string; assets: string[]; permission: 'read' | 'write'; expiresAt: string | null; session: CollaborationSessionResponse };

export function FileGuestClient({ invitationId }: { invitationId: string }) {
  const [document, setDocument] = useState<GuestDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError(null);
    try {
      const response = await fetch(fileGuestApi(invitationId), { cache: 'no-store' });
      const result = await response.json();
      if (generation.current !== current) return;
      if (!response.ok) {
        setUnavailable(response.status !== 401);
        setNeedsVerification(response.status === 401);
        setError(result.error || 'Diese Einladung ist nicht verfügbar.');
        return;
      }
      setDocument(result); setUnavailable(false); setNeedsVerification(false);
    } catch { if (generation.current === current) setError('Die Verbindung ist unterbrochen. Bitte erneut versuchen.'); }
    finally { if (generation.current === current) setLoading(false); }
  }, [invitationId]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; generation.current += 1; };
  }, [load]);
  const action = async (kind: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`${fileGuestApi(invitationId)}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Der Dateizugang ist momentan nicht verfügbar.');
  };
  const send = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action('challenge'); setSent(true); } catch (error) { setError(error instanceof Error ? error.message : 'Code konnte nicht gesendet werden.'); }
    finally { setBusy(false); }
  };
  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try { await action('verify', { code, displayName: name }); setCode(''); await load(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Code konnte nicht bestätigt werden.'); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true); setError(null);
    try { await action('logout'); setDocument(null); setSent(false); }
    catch { setError('Abmelden fehlgeschlagen. Bitte erneut versuchen.'); }
    finally { setBusy(false); }
  };
  return <main className="h-dvh overflow-y-auto bg-muted/30 px-4 pb-8 text-foreground sm:px-8">
    <header className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 py-6">
      <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight"><FileText className="size-5" aria-hidden="true" />Canvas Notebook</Link>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><LockKeyhole className="size-3.5" aria-hidden="true" />Persönlicher Dateizugang</span>
    </header>
    {document ? <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0"><p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">Mit dir geteilt · {document.permission === 'write' ? 'Bearbeiten erlaubt' : 'Nur lesen'}</p>
          <h1 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl">{document.fileName}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{document.expiresAt ? `Zugang bis ${new Date(document.expiresAt).toLocaleString('de-DE')}` : 'Ohne festes Ablaufdatum · jederzeit widerrufbar'}</p></div>
        <Button variant="ghost" size="sm" onClick={() => void logout()} disabled={busy}>Abmelden</Button>
      </div>
      {error && <p className="mb-3 text-sm text-destructive" role="alert">{error}</p>}
      {needsVerification && <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span>Lade zuerst eine Kopie herunter, wenn du lokale Änderungen sichern möchtest.</span>
        <Button size="sm" variant="outline" onClick={() => { setDocument(null); setSent(false); setError(null); }}>E-Mail erneut bestätigen</Button>
      </div>}
      <GuestMarkdownEditor key={`${document.session.documentId}:${document.session.lifecycleGeneration}:${document.session.token}`} session={document.session} path={document.path}
        fileName={document.fileName} initialMarkdown={document.markdown} assets={document.assets} onReload={() => void load()} />
    </div> : <section className="mx-auto mt-8 max-w-md rounded-2xl border bg-background p-6 shadow-sm sm:mt-16 sm:p-8">
      <Mail className="mb-5 size-7 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-2xl font-semibold tracking-tight">Eine Datei wartet auf dich.</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Bestätige die eingeladene E-Mail-Adresse mit einem Code. Du brauchst dafür kein Notebook-Konto und erhältst Zugang zu genau dieser Datei.</p>
      {loading ? <p className="mt-6 text-sm" role="status">Zugang wird geprüft …</p> : <>
        {error && <p className="mt-5 text-sm text-destructive" role="alert">{error}</p>}
        {unavailable ? <Button className="mt-5" variant="outline" onClick={() => void load()}>Erneut prüfen</Button> : <>
          {sent && <p className="mt-5 text-sm" role="status">Der Code wurde an die eingeladene Adresse gesendet. Bitte auch im Spam-Ordner nachsehen. Er gilt zehn Minuten; bei erneutem Versand gilt nur der neueste Code.</p>}
          <Button className="mt-5 w-full" variant={sent ? 'outline' : 'default'} onClick={() => void send()} disabled={busy}>{busy ? 'Bitte warten …' : sent ? 'Neuen Code anfordern' : 'Code per E-Mail anfordern'}</Button>
          {sent && <form onSubmit={(event) => void verify(event)} className="mt-6 space-y-4">
            <div className="space-y-2"><Label htmlFor="guest-name">Dein Anzeigename</Label><Input id="guest-name" autoComplete="name" maxLength={80} required value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="guest-code">Sechsstelliger Code</Label><Input id="guest-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/gu, ''))} /></div>
            <Button className="w-full" type="submit" disabled={busy}>Datei öffnen</Button>
          </form>}
        </>}
      </>}
      <p className="mt-6 border-t pt-4 text-xs leading-relaxed text-muted-foreground">Der Link allein erlaubt keinen Zugriff. Der Code wird ausschließlich an die vom Einladenden festgelegte Adresse gesendet.</p>
    </section>}
  </main>;
}
