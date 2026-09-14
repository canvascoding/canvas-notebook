'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  FileVersionCenterClientError,
  resolveFileVersionCenter,
  updateFileReviewPolicy,
} from '@/app/lib/file-version-center/client';
import {
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  type FileReviewPolicyV1,
  type FileVersionCenterTargetV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import {
  editorFileVersionTarget,
  isEditorFileVersionSupported,
} from './FileVersionHistoryButton';

type ResolvedPolicy = {
  key: string;
  state: 'ready';
  available: boolean;
  policy: FileReviewPolicyV1 | null;
  target: Extract<FileVersionCenterTargetV1, { kind: 'lineage' }>;
};

type PolicyState =
  | { key: string; state: 'loading' | 'error' }
  | ResolvedPolicy;

export function fileReviewPolicyControlState(input: {
  state: PolicyState['state'];
  available?: boolean;
  policy?: FileReviewPolicyV1 | null;
  busy: boolean;
}): {
  checked: boolean;
  disabled: boolean;
  visualState: 'loading' | 'error' | 'unavailable' | 'forced' | 'review_required' | 'safe_direct';
} {
  if (input.state === 'loading') return { checked: true, disabled: true, visualState: 'loading' };
  if (input.state === 'error') return { checked: true, disabled: true, visualState: 'error' };
  if (!input.available || !input.policy) return { checked: true, disabled: true, visualState: 'unavailable' };
  if (input.policy.locked) return { checked: true, disabled: true, visualState: 'forced' };
  return {
    checked: input.policy.effectiveMode === 'review_required',
    disabled: input.busy,
    visualState: input.policy.effectiveMode,
  };
}

export function FileReviewPolicyControl({
  workspaceId,
  path,
  documentId,
}: {
  workspaceId: string | null;
  path: string;
  documentId?: string | null;
}) {
  const t = useTranslations('notebook');
  const supported = isEditorFileVersionSupported(path);
  const target = useMemo(() => workspaceId
    ? editorFileVersionTarget({ workspaceId, path, documentId })
    : null, [documentId, path, workspaceId]);
  const targetKey = target ? JSON.stringify(target) : '';
  const [resolved, setResolved] = useState<PolicyState>({ key: '', state: 'loading' });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ key: string; value: 'saved' | 'conflict' } | null>(null);
  const requestSequence = useRef(0);
  const current = resolved.key === targetKey ? resolved : { key: targetKey, state: 'loading' as const };
  const busy = busyKey === targetKey;
  const currentMessage = message?.key === targetKey ? message.value : null;

  const load = useCallback(async (signal?: AbortSignal, nextMessage: 'conflict' | null = null) => {
    if (!target || !supported || signal?.aborted) return;
    const sequence = ++requestSequence.current;
    try {
      const timeline = await resolveFileVersionCenter({
        contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
        target,
        initialView: 'history',
        source: 'editor',
      }, signal);
      if (signal?.aborted || sequence !== requestSequence.current
        || timeline.document.workspaceId !== target.workspaceId) return;
      setResolved({
        key: targetKey,
        state: 'ready',
        available: timeline.capabilities.agentReviewPolicy,
        policy: timeline.policy ?? null,
        target: {
          kind: 'lineage',
          workspaceId: timeline.document.workspaceId,
          lineageId: timeline.document.lineageId,
        },
      });
      setMessage(nextMessage ? { key: targetKey, value: nextMessage } : null);
    } catch (error) {
      if (signal?.aborted || sequence !== requestSequence.current
        || (error instanceof DOMException && error.name === 'AbortError')) return;
      setResolved({ key: targetKey, state: 'error' });
      setMessage(null);
    }
  }, [supported, target, targetKey]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  if (!supported || !target) return null;
  const presentation = fileReviewPolicyControlState({
    state: current.state,
    available: current.state === 'ready' ? current.available : undefined,
    policy: current.state === 'ready' ? current.policy : undefined,
    busy,
  });
  const label = presentation.visualState === 'loading' ? t('fileReviewPolicyLoading')
    : presentation.visualState === 'error' ? t('fileReviewPolicyError')
      : presentation.visualState === 'unavailable' ? t('fileReviewPolicyUnavailable')
        : presentation.visualState === 'forced' ? t('fileReviewPolicyForced')
          : presentation.checked ? t('fileReviewPolicyRequired')
            : t('fileReviewPolicyDirect');

  const change = async (checked: boolean) => {
    if (current.state !== 'ready' || !current.available || !current.policy
      || current.policy.locked || busy) return;
    const sequence = ++requestSequence.current;
    setBusyKey(targetKey);
    setMessage(null);
    try {
      const policy = await updateFileReviewPolicy({
        contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
        target: current.target,
        requestedMode: checked ? 'review_required' : 'safe_direct',
        expectedRevision: current.policy.revision,
      });
      if (sequence !== requestSequence.current || targetKey !== current.key) return;
      setResolved({ ...current, policy });
      setMessage({ key: targetKey, value: 'saved' });
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      if (error instanceof FileVersionCenterClientError
        && error.code === FILE_VERSION_CENTER_ERROR_CODES.policyConflict) {
        setBusyKey((key) => key === targetKey ? null : key);
        setResolved({ key: targetKey, state: 'loading' });
        await load(undefined, 'conflict');
      } else {
        setResolved({ key: targetKey, state: 'error' });
        setMessage(null);
      }
    } finally {
      setBusyKey((key) => key === targetKey ? null : key);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1 text-xs text-muted-foreground"
          data-file-review-policy={presentation.visualState}
        >
          {presentation.visualState === 'loading' || busy
            ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : presentation.visualState === 'error'
                ? <ShieldAlert className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                : <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
          <span className="hidden 2xl:inline">{t('fileReviewPolicyShort')}</span>
          <Switch
            size="sm"
            className="relative after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] sm:after:inset-0"
            checked={presentation.checked}
            disabled={presentation.disabled}
            aria-label={label}
            aria-describedby={`file-review-policy-note-${targetKey.length}`}
            onCheckedChange={(checked) => void change(checked)}
          />
          {presentation.visualState === 'error' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              aria-label={t('fileReviewPolicyRetry')}
              onClick={() => void load()}
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            </Button>
          ) : null}
          <span id={`file-review-policy-note-${targetKey.length}`} className="sr-only">
            {t('fileReviewPolicyFutureHint')}
          </span>
          <span className="sr-only" role="status" aria-live="polite">
            {currentMessage === 'saved' ? t('fileReviewPolicySaved')
              : currentMessage === 'conflict' ? t('fileReviewPolicyConflict') : ''}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span>{label}</span>
        <span className="block max-w-64 text-[11px] opacity-80">{currentMessage === 'conflict'
          ? t('fileReviewPolicyConflict') : t('fileReviewPolicyFutureHint')}</span>
      </TooltipContent>
    </Tooltip>
  );
}
