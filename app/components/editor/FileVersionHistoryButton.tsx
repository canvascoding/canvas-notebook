'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileClock, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { resolveFileVersionCenter } from '@/app/lib/file-version-center/client';
import {
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  type FileVersionCapabilitiesV1,
  type FileVersionCenterTargetV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { classifyFileVersionFileV1 } from '@/app/lib/file-version-center/policy-v1';
import { openVersionCenter } from '@/app/store/file-version-center-store';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type CapabilityState =
  | { key: string; state: 'loading' }
  | { key: string; state: 'error' }
  | {
      key: string;
      state: 'ready';
      capabilities: FileVersionCapabilitiesV1;
      target: Extract<FileVersionCenterTargetV1, { kind: 'lineage' }>;
    };

export function isEditorFileVersionSupported(path: string): boolean {
  const fileClass = classifyFileVersionFileV1(path);
  return fileClass === 'markdown' || fileClass === 'text';
}

export function editorFileVersionTarget(input: {
  workspaceId: string;
  path: string;
  documentId?: string | null;
}): FileVersionCenterTargetV1 {
  return input.documentId
    ? { kind: 'document', workspaceId: input.workspaceId, documentId: input.documentId }
    : { kind: 'path', workspaceId: input.workspaceId, pathHint: input.path };
}

export function FileVersionHistoryButton({
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
  const target = useMemo(() => workspaceId ? editorFileVersionTarget({ workspaceId, path, documentId }) : null,
    [documentId, path, workspaceId]);
  const targetKey = target ? JSON.stringify(target) : '';
  const [resolvedCapability, setResolvedCapability] = useState<CapabilityState>({ key: '', state: 'loading' });
  const capability: CapabilityState = resolvedCapability.key === targetKey
    ? resolvedCapability
    : { key: targetKey, state: 'loading' };

  useEffect(() => {
    if (!target || !supported) return;
    const controller = new AbortController();
    void resolveFileVersionCenter({
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      target,
      initialView: 'history',
      source: 'editor',
    }, controller.signal).then((timeline) => {
      if (controller.signal.aborted || timeline.document.workspaceId !== target.workspaceId) return;
      setResolvedCapability({
        key: targetKey,
        state: 'ready',
        capabilities: timeline.capabilities,
        target: {
          kind: 'lineage',
          workspaceId: timeline.document.workspaceId,
          lineageId: timeline.document.lineageId,
        },
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setResolvedCapability({ key: targetKey, state: 'error' });
    });
    return () => controller.abort();
  }, [supported, target, targetKey]);

  if (!supported || !target) return null;
  const loading = capability.state === 'loading';
  const enabled = capability.state === 'ready' && capability.capabilities.history;
  const readOnly = capability.state === 'ready' && capability.capabilities.history
    && !capability.capabilities.restore;
  const label = loading ? t('fileVersionHistoryLoading')
    : capability.state === 'error' || !enabled ? t('fileVersionHistoryUnavailable')
      : readOnly ? t('fileVersionHistoryReadOnly')
        : t('fileVersionHistory');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0 text-xs 2xl:w-auto 2xl:gap-1.5 2xl:px-2"
          disabled={!enabled}
          aria-busy={loading}
          aria-label={label}
          data-file-version-capability={capability.state === 'ready'
            ? capability.capabilities.history ? readOnly ? 'read-only' : 'full' : 'unavailable'
            : capability.state}
          onClick={() => {
            if (capability.state !== 'ready' || !capability.capabilities.history) return;
            openVersionCenter({
              contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
              target: capability.target,
              initialView: 'history',
              source: 'editor',
            });
          }}
        >
          {loading
            ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <FileClock className="h-3.5 w-3.5" aria-hidden="true" />}
          <span className="hidden 2xl:inline">{t('fileVersionHistoryShort')}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
