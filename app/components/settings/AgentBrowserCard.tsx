'use client';

import type { ReactNode } from 'react';
import { Globe, Loader2, Power, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AgentSettingsAccordionCard } from './AgentSettingsAccordionCard';

export type AgentBrowserStatus = {
  agentId: string;
  toolEnabled: boolean;
  toolAvailable: boolean;
  requirements: {
    available: boolean;
    checkedAt: string;
    runtime: {
      container: boolean;
      displayAvailable: boolean;
      headless: boolean;
    };
    executablePath: string | null;
    executableSource: string | null;
    attemptedPaths: string[];
    reason: string | null;
  };
  capability: {
    settings: {
      runtimeEnabled: boolean;
      allowAgentBrowserTool: boolean;
      allowBrowserBasedExports: boolean;
      updatedAt: string | null;
      updatedByUserId: string | null;
    };
    availability: 'available' | 'disabled';
    runtimeAvailable: boolean;
    browserToolAvailable: boolean;
    browserExportsAvailable: boolean;
    blockers: string[];
    warnings: string[];
    checkedAt: string;
  };
  profile: {
    scope: 'agent' | 'session' | 'user';
    profileKey: string;
    sessionKey: string;
    userDataDir: string;
    profileDirExists: boolean;
    running: boolean;
    activeSessionCount: number;
    pageCount?: number;
    activeUrl?: string | null;
    activeTitle?: string | null;
    idleCloseMs: number;
    pendingDialog?: {
      type: string;
      message: string;
      defaultValue: string;
      openedAt: string;
    } | null;
  };
  probe?: {
    launchProbe?: {
      checked: true;
      ok: boolean;
      reason: string | null;
      userDataDir: string;
    };
  };
};

type AgentBrowserCardProps = {
  status: AgentBrowserStatus | null;
  loading: boolean;
  pendingAction: string | null;
  error: string | null;
  success: string | null;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onReload: () => void;
  onCloseSession: () => void;
  onDeleteProfile: () => void;
  onLaunchProbe: () => void;
};

function formatBool(value: boolean, yes: string, no: string): string {
  return value ? yes : no;
}

function formatIdleMs(value: number): string {
  const minutes = Math.round(value / 60_000);
  return `${minutes} min`;
}

function statusTone(status: AgentBrowserStatus | null): 'default' | 'secondary' | 'destructive' {
  if (!status) return 'secondary';
  if (!status.toolEnabled) return 'secondary';
  if (!status.toolAvailable) return 'destructive';
  return 'default';
}

export function AgentBrowserCard({
  status,
  loading,
  pendingAction,
  error,
  success,
  isOpen,
  onOpenChange,
  onReload,
  onCloseSession,
  onDeleteProfile,
  onLaunchProbe,
}: AgentBrowserCardProps) {
  const t = useTranslations('settings.agentPanel.browser');
  const summary = loading
    ? t('loadingSummary')
    : !status
      ? t('unknownSummary')
      : !status.toolEnabled
        ? t('disabledSummary')
        : !status.toolAvailable
          ? t('unavailableSummary')
          : status.profile.running
            ? t('runningSummary')
            : t('readySummary');
  const summaryItems: ReactNode[] = [
    <Badge key="status" variant={statusTone(status)}>{summary}</Badge>,
    ...(status?.profile.scope ? [t('scopeSummary', { scope: status.profile.scope })] : []),
  ];
  const launchProbeDisabled = Boolean(pendingAction) || status?.capability.runtimeAvailable === false;

  return (
    <AgentSettingsAccordionCard
      title={t('title')}
      description={t('description')}
      icon={Globe}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={summaryItems}
    >
      {loading ? (
        <div className="flex items-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('loading')}
        </div>
      ) : status ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border bg-muted/20 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="h-4 w-4" />
                {t('requirementsTitle')}
              </div>
              <dl className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between gap-3">
                  <dt>{t('toolEnabled')}</dt>
                  <dd className="text-right text-foreground">{formatBool(status.toolEnabled, t('yes'), t('no'))}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{t('chromiumAvailable')}</dt>
                  <dd className="text-right text-foreground">{formatBool(status.requirements.available, t('yes'), t('no'))}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{t('runtimeMode')}</dt>
                  <dd className="text-right text-foreground">{status.requirements.runtime.headless ? t('headless') : t('visible')}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{t('container')}</dt>
                  <dd className="text-right text-foreground">{formatBool(status.requirements.runtime.container, t('yes'), t('no'))}</dd>
                </div>
                {status.requirements.executablePath && (
                  <div className="space-y-1">
                    <dt>{t('executable')}</dt>
                    <dd className="break-all text-foreground">{status.requirements.executablePath}</dd>
                  </div>
                )}
                {status.requirements.reason && (
                  <div className="space-y-1">
                    <dt>{t('reason')}</dt>
                    <dd className="break-words text-destructive">{status.requirements.reason}</dd>
                  </div>
                )}
              </dl>
            </div>

            <div className="rounded-md border bg-muted/20 p-3">
              <div className="mb-2 text-sm font-medium">{t('profileTitle')}</div>
              <dl className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between gap-3">
                  <dt>{t('profileScope')}</dt>
                  <dd className="text-right text-foreground">{status.profile.scope}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{t('profileExists')}</dt>
                  <dd className="text-right text-foreground">{formatBool(status.profile.profileDirExists, t('yes'), t('no'))}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{t('running')}</dt>
                  <dd className="text-right text-foreground">{formatBool(status.profile.running, t('yes'), t('no'))}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{t('sessions')}</dt>
                  <dd className="text-right text-foreground">{status.profile.activeSessionCount}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{t('idleClose')}</dt>
                  <dd className="text-right text-foreground">{formatIdleMs(status.profile.idleCloseMs)}</dd>
                </div>
                <div className="space-y-1">
                  <dt>{t('profilePath')}</dt>
                  <dd className="break-all text-foreground">{status.profile.userDataDir}</dd>
                </div>
                {status.profile.activeUrl && (
                  <div className="space-y-1">
                    <dt>{t('activeUrl')}</dt>
                    <dd className="break-all text-foreground">{status.profile.activeUrl}</dd>
                  </div>
                )}
                {status.profile.pendingDialog && (
                  <div className="space-y-1">
                    <dt>{t('pendingDialog')}</dt>
                    <dd className="break-words text-foreground">
                      {status.profile.pendingDialog.type}: {status.profile.pendingDialog.message}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t('persistenceHint')}</p>
          <p className="text-xs text-muted-foreground">{t('networkHint')}</p>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-emerald-600">{success}</p>}

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onReload} disabled={Boolean(pendingAction)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('reload')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onLaunchProbe} disabled={launchProbeDisabled}>
              {pendingAction === 'launch_probe' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('launchProbe')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onCloseSession} disabled={Boolean(pendingAction) || !status.profile.running}>
              <Power className="mr-2 h-4 w-4" />
              {t('closeSession')}
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={onDeleteProfile} disabled={Boolean(pendingAction) || (!status.profile.profileDirExists && !status.profile.running)}>
              {pendingAction === 'delete_profile' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {t('deleteProfile')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('unknownSummary')}</p>
      )}
    </AgentSettingsAccordionCard>
  );
}
