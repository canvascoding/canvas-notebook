'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { useTranslations } from 'next-intl';

type StatusResponse = { success: boolean; data?: { available: boolean } };
type TranscriptResponse = { success: boolean; data?: { text: string }; error?: string };

export function DictationControl({ disabled, onTranscript }: { disabled: boolean; onTranscript: (text: string) => void }) {
  const t = useTranslations('dictation');
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void fetch('/api/dictation/status', { cache: 'no-store' })
        .then((response) => response.json() as Promise<StatusResponse>)
        .then((body) => { if (mounted.current) setAvailable(Boolean(body.success && body.data?.available)); })
        .catch(() => { if (mounted.current) setAvailable(false); });
    };
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(interval);
      recorder.current?.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function transcribe(blob: Blob) {
    if (!mounted.current) return;
    setPhase('transcribing');
    try {
      const form = new FormData();
      form.set('audio', blob, blob.type.startsWith('audio/mp4') ? 'recording.m4a' : 'recording.webm');
      const response = await fetch('/api/dictation/transcribe', { method: 'POST', body: form });
      const result = await response.json() as TranscriptResponse;
      if (!response.ok || !result.success) throw new Error(result.error || t('transcriptionError'));
      if (!result.data?.text?.trim()) throw new Error(t('emptyTranscript'));
      if (mounted.current) onTranscript(result.data.text.trim());
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('transcriptionError'));
    } finally {
      if (mounted.current) setPhase('idle');
    }
  }

  async function start() {
    if (phase !== 'idle') return;
    setError(null);
    if (window.isSecureContext === false) {
      setError(t('microphoneInsecure'));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(t('unsupportedBrowser'));
      return;
    }
    const policyDocument = document as Document & {
      permissionsPolicy?: { allowsFeature: (feature: string) => boolean };
      featurePolicy?: { allowsFeature: (feature: string) => boolean };
    };
    const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy;
    if (policy && !policy.allowsFeature('microphone')) {
      setError(t('microphonePolicyBlocked'));
      return;
    }
    setPhase('requesting');
    let microphoneGranted = false;
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneGranted = true;
      if (!mounted.current) { audioStream.getTracks().forEach((track) => track.stop()); return; }
      stream.current = audioStream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const options = mimeType ? { mimeType } : undefined;
      const active = new MediaRecorder(audioStream, options);
      recorder.current = active;
      const chunks: Blob[] = [];
      active.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      active.onerror = () => { if (mounted.current) { setError(t('recordingError')); setPhase('idle'); } audioStream.getTracks().forEach((track) => track.stop()); };
      active.onstop = () => {
        audioStream.getTracks().forEach((track) => track.stop());
        stream.current = null;
        recorder.current = null;
        if (mounted.current && chunks.length) void transcribe(new Blob(chunks, { type: active.mimeType || 'audio/webm' }));
        else if (mounted.current) { setError(t('emptyRecording')); setPhase('idle'); }
      };
      active.start();
      setPhase('recording');
    } catch (cause) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      recorder.current = null;
      if (!mounted.current) return;
      const name = cause instanceof DOMException ? cause.name : '';
      const errorKey = microphoneGranted ? 'recordingError'
        : name === 'NotAllowedError' || name === 'SecurityError' ? 'microphonePermissionDenied'
        : name === 'NotFoundError' ? 'microphoneNotFound'
        : name === 'NotReadableError' || name === 'AbortError' ? 'microphoneBusy'
        : 'microphoneError';
      setError(t(errorKey));
      setPhase('idle');
    }
  }

  if (!available) return null;
  return <div className="flex flex-col items-center gap-1">
    <button
      type="button"
      data-testid="chat-dictation"
      aria-label={phase === 'recording' ? t('stopRecording') : phase === 'requesting' ? t('microphoneRequesting') : phase === 'transcribing' ? t('transcribing') : t('startRecording')}
      title={phase === 'recording' ? t('stopRecording') : phase === 'requesting' ? t('microphoneRequesting') : phase === 'transcribing' ? t('transcribing') : t('startRecording')}
      disabled={disabled || phase === 'requesting' || phase === 'transcribing'}
      onClick={() => { if (phase === 'recording') recorder.current?.stop(); else void start(); }}
      className="border border-transparent p-2.5 text-muted-foreground transition-colors hover:border-border hover:bg-accent disabled:opacity-50"
    >
      {phase === 'recording' ? <Square className="h-5 w-5 fill-red-500 text-red-500" /> : phase === 'requesting' || phase === 'transcribing' ? <Loader2 className="h-5 w-5 animate-spin" /> : <Mic className="h-5 w-5" />}
    </button>
    {error && <span role="alert" className="max-w-32 text-center text-[10px] text-destructive">{error}</span>}
  </div>;
}
