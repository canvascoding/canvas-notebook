'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Switch } from '@/components/ui/switch';

type DirectMcpWorkspaceAccessSwitchProps = {
  workspaceId: string;
  enabled?: boolean;
  canManage?: boolean;
  onUpdated?: (enabled: boolean) => void | Promise<void>;
};

export function DirectMcpWorkspaceAccessSwitch({
  workspaceId,
  enabled,
  canManage,
  onUpdated,
}: DirectMcpWorkspaceAccessSwitchProps) {
  if (enabled !== undefined) {
    return (
      <WorkspaceAccessSwitchControl
        key={`${workspaceId}:${enabled}:${Boolean(canManage)}`}
        workspaceId={workspaceId}
        initialEnabled={enabled}
        initialManager={Boolean(canManage)}
        onUpdated={onUpdated}
      />
    );
  }

  return <WorkspaceAccessSwitchLoader workspaceId={workspaceId} onUpdated={onUpdated} />;
}

function WorkspaceAccessSwitchLoader({
  workspaceId,
  onUpdated,
}: Pick<DirectMcpWorkspaceAccessSwitchProps, 'workspaceId' | 'onUpdated'>) {
  const t = useTranslations('settings.workspacePanel.management.mcp');
  const [configuration, setConfiguration] = useState<{ enabled: boolean; canManage: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch(`/api/integrations/mcp-server/workspaces?${new URLSearchParams({ workspace_id: workspaceId })}`, {
      credentials: 'include',
      cache: 'no-store',
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !payload.success || typeof payload.data?.workspace?.enabled !== 'boolean') {
        throw new Error(payload.error || t('errors.load'));
      }
      if (!active) return;
      setConfiguration({
        enabled: payload.data.workspace.enabled,
        canManage: payload.data.workspace.canManage === true,
      });
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    });
    return () => {
      active = false;
    };
  }, [t, workspaceId]);

  if (!configuration) {
    return (
      <div className="shrink-0">
        <div className="flex items-center justify-end gap-2">
          {error ? null : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
          <Switch checked={false} disabled aria-label={t('switchLabel')} />
        </div>
        {error ? <p role="alert" className="mt-2 max-w-64 text-right text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <WorkspaceAccessSwitchControl
      key={`${workspaceId}:${configuration.enabled}:${configuration.canManage}`}
      workspaceId={workspaceId}
      initialEnabled={configuration.enabled}
      initialManager={configuration.canManage}
      onUpdated={onUpdated}
    />
  );
}

type WorkspaceAccessSwitchControlProps = {
  workspaceId: string;
  initialEnabled: boolean;
  initialManager: boolean;
  onUpdated?: (enabled: boolean) => void | Promise<void>;
};

function WorkspaceAccessSwitchControl({
  workspaceId,
  initialEnabled,
  initialManager,
  onUpdated,
}: WorkspaceAccessSwitchControlProps) {
  const t = useTranslations('settings.workspacePanel.management.mcp');
  const [isEnabled, setIsEnabled] = useState(initialEnabled);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = async (nextEnabled: boolean) => {
    if (!initialManager || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/integrations/mcp-server/workspaces', {
        method: 'PUT',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, enabled: nextEnabled }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success || typeof payload.data?.enabled !== 'boolean') {
        throw new Error(payload.error || t('errors.update'));
      }
      setIsEnabled(payload.data.enabled);
      try {
        await onUpdated?.(payload.data.enabled);
      } catch {
        // The server update succeeded. Keep the local switch state even if a
        // background refresh of surrounding UI state cannot complete.
      }
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : t('errors.update'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="shrink-0">
      <div className="flex items-center justify-end gap-2">
        {isSaving ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
        <Switch
          checked={isEnabled}
          onCheckedChange={(nextEnabled) => void update(nextEnabled)}
          disabled={!initialManager || isSaving}
          aria-label={t('switchLabel')}
        />
      </div>
      {error ? <p role="alert" className="mt-2 max-w-64 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
