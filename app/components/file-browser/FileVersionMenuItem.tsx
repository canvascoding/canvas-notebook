'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileClock, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  FileVersionCenterClientError,
  resolveFileVersionCenterWhenReady,
} from '@/app/lib/file-version-center/client';
import {
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  type FileVersionCapabilitiesV1,
  type FileVersionCenterRequestV1,
  type FileVersionCenterTargetV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { openVersionCenter } from '@/app/store/file-version-center-store';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

type ResolvedMenuCapability = {
  key: string;
  state: 'ready';
  capabilities: FileVersionCapabilitiesV1;
  target: Extract<FileVersionCenterTargetV1, { kind: 'lineage' }>;
};

type MenuCapabilityState =
  | { key: string; state: 'loading' }
  | { key: string; state: 'missing' | 'error' }
  | ResolvedMenuCapability;

export type FileVersionMenuSource = Extract<
  FileVersionCenterRequestV1['source'],
  'editor' | 'file_browser'
>;

export function fileVersionMenuTarget(input: {
  workspaceId: string;
  path: string;
  lineageId?: string | null;
}): FileVersionCenterTargetV1 {
  return input.lineageId
    ? { kind: 'lineage', workspaceId: input.workspaceId, lineageId: input.lineageId }
    : { kind: 'path', workspaceId: input.workspaceId, pathHint: input.path };
}

export function FileVersionMenuItem({
  workspaceId,
  path,
  lineageId,
  source,
}: {
  workspaceId: string | null;
  path: string;
  lineageId?: string | null;
  source: FileVersionMenuSource;
}) {
  const t = useTranslations('notebook');
  const requestedTarget = useMemo(() => workspaceId
    ? fileVersionMenuTarget({ workspaceId, path, lineageId })
    : null, [lineageId, path, workspaceId]);
  const targetKey = requestedTarget ? JSON.stringify(requestedTarget) : '';
  const [resolvedCapability, setResolvedCapability] = useState<MenuCapabilityState>({
    key: '',
    state: 'loading',
  });
  const capability: MenuCapabilityState = resolvedCapability.key === targetKey
    ? resolvedCapability
    : { key: targetKey, state: requestedTarget ? 'loading' : 'error' };

  useEffect(() => {
    if (!requestedTarget) return;
    const controller = new AbortController();
    void resolveFileVersionCenterWhenReady({
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      target: requestedTarget,
      initialView: 'history',
      source,
    }, controller.signal).then((timeline) => {
      if (controller.signal.aborted || timeline.document.workspaceId !== requestedTarget.workspaceId) return;
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
      setResolvedCapability({
        key: targetKey,
        state: error instanceof FileVersionCenterClientError
          && error.code === FILE_VERSION_CENTER_ERROR_CODES.notFound
          ? 'missing'
          : 'error',
      });
    });
    return () => controller.abort();
  }, [requestedTarget, source, targetKey]);

  if (capability.state === 'ready'
    && !capability.capabilities.history
    && capability.capabilities.reason === 'unsupported_type') return null;

  const loading = capability.state === 'loading';
  const enabled = capability.state === 'ready' && capability.capabilities.history;
  const readOnly = enabled && !capability.capabilities.restore;
  const label = loading
    ? t('fileVersionChangesLoading')
    : capability.state === 'missing'
      ? t('fileVersionChangesMissing')
      : !enabled
        ? t('fileVersionChangesUnavailable')
        : readOnly
          ? t('fileVersionChangesReadOnly')
          : t('fileVersionChanges');

  return (
    <DropdownMenuItem
      disabled={!enabled}
      aria-busy={loading}
      aria-label={label}
      data-testid="file-version-menu-item"
      data-file-version-capability={capability.state === 'ready'
        ? enabled ? readOnly ? 'read-only' : 'full' : 'unavailable'
        : capability.state}
      onSelect={() => {
        if (capability.state !== 'ready' || !capability.capabilities.history) return;
        openVersionCenter({
          contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
          target: capability.target,
          initialView: 'history',
          source,
        });
      }}
    >
      {loading
        ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : <FileClock className="h-4 w-4" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{t('fileVersionChanges')}</span>
      {readOnly ? (
        <span className="ml-3 shrink-0 text-[11px] text-muted-foreground">
          {t('fileVersionChangesReadOnlyHint')}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}
