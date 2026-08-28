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
  const t = useTranslations('settings.workspacePanel.management.mcp');
  const [isEnabled, setIsEnabled] = useState(enabled ?? false);
  const [isManager, setIsManager] = useState(canManage ?? false);
  const [isLoading, setIsLoading] = useState(enabled === undefined);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (enabled !== undefined) {
      setIsEnabled(enabled);
      setIsManager(Boolean(canManage));
      setIsLoading(false);
      return;
    }

    let active = true;
    setIsLoading(true);
    setError(null);
    void fetch(`/api/integrations/mcp-server/workspaces?${new URLSearchParams({ workspace_id: workspaceId })}`, {
      credentials: 'include',
      cache: 'no-store',
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !payload.success || typeof payload.data?.workspace?.enabled !== 'boolean') {
        throw new Error(payload.error || t('errors.load'));
      }
      if (!active) return;
      setIsEnabled(payload.data.workspace.enabled);
      setIsManager(payload.data.workspace.canManage === true);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [canManage, enabled, t, workspaceId]);

  const update = async (nextEnabled: boolean) => {
    if (!isManager || isSaving || isLoading) return;
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
        {isSaving || isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
        <Switch
          checked={isEnabled}
          onCheckedChange={(nextEnabled) => void update(nextEnabled)}
          disabled={!isManager || isSaving || isLoading}
          aria-label={t('switchLabel')}
        />
      </div>
      {error ? <p role="alert" className="mt-2 max-w-64 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
