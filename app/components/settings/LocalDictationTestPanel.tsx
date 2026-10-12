'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { DictationControl } from '@/app/components/canvas-agent-chat/DictationControl';
import type { LocalPreparation } from '@/app/lib/dictation/preparation-contract';

type PreparationResponse = { success: boolean; data?: LocalPreparation | null; error?: string };

export function LocalDictationTestPanel({ model, language, modelInstalled, modelBytes, disabled, onReady }: {
  model: string; language: string; modelInstalled: boolean; modelBytes?: number; disabled: boolean; onReady: () => void;
}) {
  const t = useTranslations('dictation');
  const [job, setJob] = useState<LocalPreparation | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordedText, setRecordedText] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const notifiedId = useRef<string | null>(null);
  const running = job?.state === 'running';
  const matching = job?.model === model;
  const passed = matching && job?.state === 'succeeded';

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const response = await fetch('/api/admin/dictation/local-test', { cache: 'no-store' });
        const body = await response.json() as PreparationResponse;
        if (!response.ok || !body.success) throw new Error(body.error || t('loadError'));
        if (active) { setJob(body.data ?? null); setError(null); }
        if (active && body.data?.state === 'running') timer = setTimeout(() => void refresh(), 1_000);
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : t('loadError'));
          timer = setTimeout(() => void refresh(), 3_000);
        }
      }
    };
    void refresh();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [refreshToken, t]);

  useEffect(() => {
    if (passed && job && job.id !== notifiedId.current) { notifiedId.current = job.id; onReady(); }
  }, [passed, job, onReady]);

  const start = async () => {
    setStarting(true); setError(null); setRecordedText('');
    try {
      const response = await fetch('/api/admin/dictation/local-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
      const body = await response.json() as PreparationResponse;
      if (!response.ok || !body.data) throw new Error(body.error || t('installError'));
      setJob(body.data); setRefreshToken(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('installError')); }
    finally { setStarting(false); }
  };

  const total = job?.totalBytes ?? modelBytes;
  const bytes = job?.downloadedBytes ?? 0;
  const determinate = running && job?.phase === 'downloading' && total !== undefined && total > 0;
  const percent = determinate ? Math.min(100, Math.floor(bytes / total! * 100)) : null;
  const megabytes = (value: number) => (value / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 });

  return <div className="space-y-3 rounded-md border border-border p-3" data-testid="local-dictation-test">
    <div><h4 className="text-sm font-medium">{t('localTestTitle')}</h4><p className="text-xs text-muted-foreground">{t('localTestDescription')}</p></div>
    {!running && !passed && modelBytes !== undefined && <p className="text-xs text-muted-foreground">{t('modelDownloadSize', { size: megabytes(modelBytes) })}</p>}
    <Button type="button" variant="outline" size="sm" onClick={() => void start()} disabled={disabled || starting || running} data-testid="local-model-prepare">
      {(starting || running) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {passed ? t('localTestAgain') : job?.state === 'failed' && matching ? t('localTestRetry') : t('localPrepareTest')}
    </Button>
    {running && job && <div className="space-y-2" data-testid="local-model-progress">
      <p role="status" className="text-sm">{t(`localPhases.${job.phase}`, { model: job.model })}</p>
      <div role="progressbar" aria-label={t('localProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
        className="h-2 overflow-hidden rounded-full bg-primary/20">
        <div className={`h-full bg-primary transition-all ${percent === null ? 'w-1/3 animate-pulse' : ''}`} style={percent !== null ? { width: `${percent}%` } : undefined} />
      </div>
      {percent !== null && <p className="text-xs text-muted-foreground">{percent}% · {megabytes(bytes)} / {megabytes(total!)} MB</p>}
      <p className="text-xs text-muted-foreground">{t('localContinues')}</p>
    </div>}
    {matching && job?.state === 'failed' && <InlineNotice variant="destructive" size="compact">{job.message || t('installError')}</InlineNotice>}
    {passed && job?.result && <InlineNotice variant="success" size="compact" data-testid="local-model-test-success">
      <p>{t('localTestPassed', { model })}</p>
      <p className="mt-1 text-xs">{t('localTestTiming', { seconds: (job.result.durationMs / 1000).toFixed(1), time: new Date(job.result.checkedAt).toLocaleString() })}</p>
      <p className="mt-2 whitespace-pre-wrap break-words" data-testid="local-model-test-transcript">{job.result.text}</p>
    </InlineNotice>}
    {error && <InlineNotice variant="destructive" size="compact">{error}</InlineNotice>}
    {(passed || modelInstalled) && !running && <div className="space-y-2 border-t pt-3">
      <p className="text-sm font-medium">{t('localRecordingTest')}</p>
      <p className="text-xs text-muted-foreground">{t('localRecordingDescription')}</p>
      <DictationControl key={`${model}:${language}`} availability disabled={disabled} testId="local-test-microphone"
        transcribeUrl="/api/admin/dictation/local-test/recording" formFields={{ model, language }} onTranscript={setRecordedText} />
      {recordedText && <p className="whitespace-pre-wrap break-words text-sm" data-testid="local-recording-transcript">{recordedText}</p>}
    </div>}
  </div>;
}
