'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Inbox, Loader2, Lock, Pencil, Plus, RefreshCw, Star, Trash2, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { CreateWorkspaceDialog } from '@/app/components/settings/CreateWorkspaceDialog';
import { EditWorkspaceDialog } from '@/app/components/settings/EditWorkspaceDialog';
import { WorkspaceMembersDialog } from '@/app/components/settings/WorkspaceMembersDialog';
import { WorkspaceTypeChangeDialog } from '@/app/components/settings/WorkspaceTypeChangeDialog';
import { WorkspaceMailboxAssignmentDialog } from '@/app/components/settings/WorkspaceMailboxAssignmentDialog';
import { WorkspaceIdentityMark } from '@/app/components/workspaces/WorkspaceIdentityMark';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import {
  getWorkspaceKindLabel,
  type WorkspaceKindLabels,
} from '@/app/components/workspaces/workspace-utils';
import { useWorkspaceStore } from '@/app/store/workspace-store';

interface WorkspaceManagementCardProps {
  isAdmin?: boolean;
  teamFeaturesEnabled?: boolean;
  focusManagement?: boolean;
  openCreateDialog?: boolean;
}

function getAccessKey(workspace: ClientWorkspaceSummary): 'manage' | 'write' | 'read' {
  if (workspace.permissions.canManageWorkspace) return 'manage';
  if (workspace.permissions.canWrite) return 'write';
  return 'read';
}

function getDeleteBlockKey(workspace: ClientWorkspaceSummary): string | null {
  if (workspace.isDefault) return 'errors.isDefault';
  if (workspace.status !== 'active') return 'errors.notActive';
  if (workspace.type === 'personal') {
    return workspace.permissions.canWrite ? null : 'errors.noDeletePermission';
  }
  return workspace.permissions.canManageWorkspace ? null : 'errors.noDeletePermission';
}

export function WorkspaceManagementCard({
  isAdmin = false,
  teamFeaturesEnabled = false,
  focusManagement = false,
  openCreateDialog = false,
}: WorkspaceManagementCardProps) {
  const t = useTranslations('settings.workspacePanel.management');
  const workspaceTypesT = useTranslations('workspaces.types');
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDeeplinkDismissed, setCreateDeeplinkDismissed] = useState(false);
  const [editTarget, setEditTarget] = useState<ClientWorkspaceSummary | null>(null);
  const [membersTarget, setMembersTarget] = useState<ClientWorkspaceSummary | null>(null);
  const [typeChangeTarget, setTypeChangeTarget] = useState<ClientWorkspaceSummary | null>(null);
  const [mailboxTarget, setMailboxTarget] = useState<ClientWorkspaceSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClientWorkspaceSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const isLoading = useWorkspaceStore((state) => state.isLoading);
  const initialized = useWorkspaceStore((state) => state.initialized);
  const error = useWorkspaceStore((state) => state.error);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const refreshWorkspaces = useWorkspaceStore((state) => state.refreshWorkspaces);
  const storeTeamFeaturesEnabled = useWorkspaceStore((state) => state.teamFeaturesEnabled);
  const projectFeaturesEnabled = useWorkspaceStore((state) => state.projectFeaturesEnabled);

  const effectiveTeamFeaturesEnabled = teamFeaturesEnabled || storeTeamFeaturesEnabled;
  const hasOrganizationWorkspace = workspaces.some(
    (workspace) => workspace.type === 'organization' && workspace.status === 'active',
  );
  const kindLabels = {
    personal: workspaceTypesT('personal'),
    organization: workspaceTypesT('organization'),
    team: workspaceTypesT('team'),
    project: workspaceTypesT('project'),
  } satisfies WorkspaceKindLabels;

  useEffect(() => {
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  useEffect(() => {
    if (!focusManagement) return;
    window.requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      cardRef.current?.focus({ preventScroll: true });
    });
  }, [focusManagement]);

  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((left, right) => {
      if (Boolean(left.isDefault) !== Boolean(right.isDefault)) return left.isDefault ? -1 : 1;
      const order = { personal: 0, organization: 1, team: 2, project: 3 };
      return order[left.type] - order[right.type] || left.name.localeCompare(right.name);
    }),
    [workspaces],
  );

  const handleCreated = useCallback(async () => {
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  const handleTypeChanged = useCallback(async () => {
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  const handleWorkspaceUpdated = useCallback(async () => {
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  const isCreateDialogOpen = createOpen || (openCreateDialog && !createDeeplinkDismissed);
  const handleCreateOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && openCreateDialog) {
      setCreateDeeplinkDismissed(true);
    }
    setCreateOpen(nextOpen);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(deleteTarget.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        const key = payload.code === 'WORKSPACE_IS_DEFAULT'
          ? 'errors.isDefault'
          : payload.code === 'WORKSPACE_HAS_AUTOMATIONS'
              ? 'errors.hasAutomations'
              : null;
        throw new Error(key ? t(key) : payload.error || t('errors.deleteFailed'));
      }
      setDeleteTarget(null);
      await refreshWorkspaces();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errors.deleteFailed');
      setDeleteError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <Card ref={cardRef} tabIndex={-1} className="outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <CardHeader className="px-4 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <CardTitle>{t('title')}</CardTitle>
              <CardDescription>{t('description')}</CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="outline"
                className="w-full justify-center sm:w-auto"
                onClick={() => void refreshWorkspaces()}
                disabled={isLoading}
              >
                <RefreshCw data-icon="inline-start" className={isLoading ? 'animate-spin' : undefined} />
                {t('refresh')}
              </Button>
              <Button
                type="button"
                className="w-full justify-center sm:w-auto"
                onClick={() => setCreateOpen(true)}
              >
                <Plus data-icon="inline-start" />
                {t('createWorkspace')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4 pb-4 sm:px-6 sm:pb-6">
          {isLoading && !initialized ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 data-icon="inline-start" className="animate-spin" />
              {t('loading')}
            </div>
          ) : error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : sortedWorkspaces.length === 0 ? (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
              {t('empty')}
            </p>
          ) : (
            <TooltipProvider>
              <div className="flex flex-col gap-2">
                {sortedWorkspaces.map((workspace) => {
                  const deleteBlockKey = getDeleteBlockKey(workspace);
                  const deleteDisabled = Boolean(deleteBlockKey);
                  const deleteButton = (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      disabled={deleteDisabled}
                      onClick={() => {
                        if (deleteDisabled) return;
                        setDeleteTarget(workspace);
                        setDeleteError(null);
                      }}
                      aria-label={t('deleteWorkspace', { name: workspace.name })}
                      title={deleteBlockKey ? t(deleteBlockKey) : t('deleteWorkspace', { name: workspace.name })}
                    >
                      {deleteDisabled ? <Lock /> : <Trash2 />}
                    </Button>
                  );

                  return (
                    <div
                      key={workspace.id}
                      className="grid min-w-0 gap-3 rounded-md border border-border px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <WorkspaceIdentityMark workspace={workspace} className="h-8 w-8" iconClassName="h-4 w-4" />
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="min-w-0 truncate text-sm font-medium">{workspace.name}</span>
                            {workspace.isDefault ? (
                              <Badge variant="secondary" className="gap-1">
                                <Star className="h-3 w-3" />
                                {t('badges.default')}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                            <Badge variant="outline">{getWorkspaceKindLabel(workspace, kindLabels)}</Badge>
                            <Badge variant="outline">{t(`access.${getAccessKey(workspace)}`)}</Badge>
                            {workspace.status !== 'active' ? (
                              <Badge variant="secondary">{workspace.status}</Badge>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div className="flex min-w-0 flex-wrap items-center justify-start gap-1 sm:justify-end">
                        {workspace.permissions.canManageWorkspace ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            onClick={() => setEditTarget(workspace)}
                          >
                            <Pencil data-icon="inline-start" />
                            {t('editWorkspace')}
                          </Button>
                        ) : null}
                        {(workspace.type === 'team' || workspace.type === 'project') && workspace.permissions.canManageWorkspace ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            onClick={() => setMembersTarget(workspace)}
                          >
                            <Users data-icon="inline-start" />
                            {t('members.manageAccess')}
                          </Button>
                        ) : null}
                        {workspace.permissions.canManageWorkspace ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            onClick={() => setMailboxTarget(workspace)}
                          >
                            <Inbox data-icon="inline-start" />
                            {t('mailbox.action')}
                          </Button>
                        ) : null}
                        {isAdmin && !workspace.isDefault && workspace.type !== 'organization' && workspace.permissions.canManageWorkspace ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            onClick={() => setTypeChangeTarget(workspace)}
                          >
                            <ArrowLeftRight data-icon="inline-start" />
                            {t('typeChange.action')}
                          </Button>
                        ) : null}
                        {deleteBlockKey ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">{deleteButton}</span>
                            </TooltipTrigger>
                            <TooltipContent side="left">{t(deleteBlockKey)}</TooltipContent>
                          </Tooltip>
                        ) : (
                          deleteButton
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </TooltipProvider>
          )}
        </CardContent>
      </Card>

      <CreateWorkspaceDialog
        open={isCreateDialogOpen}
        onOpenChange={handleCreateOpenChange}
        canCreateSharedWorkspace={isAdmin}
        hasOrganizationWorkspace={hasOrganizationWorkspace}
        teamFeaturesEnabled={effectiveTeamFeaturesEnabled}
        projectFeaturesEnabled={projectFeaturesEnabled}
        onCreated={handleCreated}
      />

      <EditWorkspaceDialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        workspace={editTarget}
        onChanged={handleWorkspaceUpdated}
      />

      <WorkspaceMembersDialog
        open={Boolean(membersTarget)}
        onOpenChange={(open) => {
          if (!open) setMembersTarget(null);
        }}
        workspace={membersTarget}
      />

      <WorkspaceTypeChangeDialog
        open={Boolean(typeChangeTarget)}
        onOpenChange={(open) => {
          if (!open) setTypeChangeTarget(null);
        }}
        workspace={typeChangeTarget}
        teamFeaturesEnabled={effectiveTeamFeaturesEnabled}
        projectFeaturesEnabled={projectFeaturesEnabled}
        onChanged={handleTypeChanged}
      />

      <WorkspaceMailboxAssignmentDialog
        open={Boolean(mailboxTarget)}
        onOpenChange={(open) => {
          if (!open) setMailboxTarget(null);
        }}
        workspace={mailboxTarget ? { id: mailboxTarget.id, name: mailboxTarget.name } : null}
      />

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => {
        if (!open && !isDeleting) {
          setDeleteTarget(null);
          setDeleteError(null);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? t('confirmDelete', { name: deleteTarget.name }) : t('confirmDeleteFallback')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {isDeleting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Trash2 data-icon="inline-start" />}
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
