'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Trash2, UserPlus } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';

type WorkspaceMemberRecord = {
  workspaceId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
};

type WorkspaceMemberCandidate = {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
};

type WorkspaceAccessLevel = 'viewer' | 'editor' | 'manager';

type WorkspaceMembersEditorProps = {
  active: boolean;
  workspace: ClientWorkspaceSummary;
  onChanged?: () => void | Promise<void>;
};

function getAccessLevel(member: Pick<WorkspaceMemberRecord, 'canWrite' | 'canManage'>): WorkspaceAccessLevel {
  if (member.canManage) return 'manager';
  if (member.canWrite) return 'editor';
  return 'viewer';
}

function getAccessInput(accessLevel: WorkspaceAccessLevel) {
  if (accessLevel === 'manager') {
    return { canRead: true, canWrite: true, canManage: true, role: 'admin' };
  }
  if (accessLevel === 'editor') {
    return { canRead: true, canWrite: true, canManage: false, role: 'member' };
  }
  return { canRead: true, canWrite: false, canManage: false, role: 'member' };
}

function getUserLabel(user: { name?: string | null; email?: string | null; userId: string }) {
  const name = user.name?.trim();
  const email = user.email?.trim();
  if (name && email && name !== email) return `${name} · ${email}`;
  return name || email || user.userId;
}

function getUserInitials(user: Pick<WorkspaceMemberRecord, 'name' | 'email' | 'userId'>) {
  const source = user.name?.trim() || user.email?.trim() || user.userId;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
}

function getMemberIdentity(member: WorkspaceMemberRecord) {
  const name = member.name?.trim();
  const email = member.email?.trim();
  if (name && email && name !== email) return { primary: name, secondary: email };
  return { primary: name || email || member.userId, secondary: null };
}

export function WorkspaceMembersEditor({ active, workspace, onChanged }: WorkspaceMembersEditorProps) {
  const t = useTranslations('settings.workspacePanel.management.members');
  const idPrefix = useId();
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([]);
  const [candidates, setCandidates] = useState<WorkspaceMemberCandidate[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [newAccessLevel, setNewAccessLevel] = useState<WorkspaceAccessLevel>('viewer');
  const [isLoading, setIsLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceMemberRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.load'));
      }
      setMembers(Array.isArray(payload.members) ? payload.members : []);
      setCandidates(Array.isArray(payload.candidates) ? payload.candidates : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [workspace.id, t]);

  useEffect(() => {
    if (!active) return;
    const timeout = window.setTimeout(() => {
      void loadMembers();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [active, loadMembers]);

  const availableCandidates = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.userId));
    return candidates.filter((candidate) => !memberIds.has(candidate.userId));
  }, [candidates, members]);

  const updateMember = async (
    userId: string,
    input: { canRead: boolean; canWrite: boolean; canManage: boolean; role?: string },
  ) => {
    setActiveAction(`update:${userId}`);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          role: input.role || 'member',
          canRead: input.canRead,
          canWrite: input.canWrite,
          canManage: input.canManage,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.save'));
      }
      await loadMembers();
      setSelectedUserId('');
      setNewAccessLevel('viewer');
      await Promise.resolve(onChanged?.()).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.save'));
    } finally {
      setActiveAction(null);
    }
  };

  const removeMember = async (member: WorkspaceMemberRecord) => {
    setActiveAction(`remove:${member.userId}`);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(member.userId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        const message = payload.code === 'WORKSPACE_LAST_MANAGER'
          ? t('errors.lastManager')
          : payload.error || t('errors.remove');
        throw new Error(message);
      }
      setRemoveTarget(null);
      await loadMembers();
      await Promise.resolve(onChanged?.()).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.remove'));
    } finally {
      setActiveAction(null);
    }
  };

  const memberUserId = `${idPrefix}-user`;
  const memberAccessId = `${idPrefix}-access`;

  return (
    <>
      <div className="flex w-full flex-col gap-6">
        <section aria-labelledby={`${idPrefix}-members-heading`} aria-busy={isLoading}>
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h3 id={`${idPrefix}-members-heading`} className="text-base font-semibold tracking-tight">{t('currentMembers')}</h3>
              <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">{t('currentMembersDescription')}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 self-start sm:self-auto"
              onClick={() => void loadMembers()}
              disabled={isLoading || activeAction !== null}
            >
              {isLoading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
              {t('refresh')}
            </Button>
          </div>

          {error ? (
            <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {isLoading && members.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
              <Loader2 data-icon="inline-start" className="animate-spin" />
              {t('loading')}
            </div>
          ) : members.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
              {t('noMembers')}
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="hidden grid-cols-[minmax(0,1fr)_10.5rem_auto] items-center gap-4 border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                <span>{t('person')}</span>
                <span>{t('accessLevel')}</span>
                <span className="sr-only">{t('actions')}</span>
              </div>
              <div className="divide-y divide-border">
                {members.map((member) => {
                  const busy = activeAction?.endsWith(member.userId) ?? false;
                  const accessLevel = getAccessLevel(member);
                  const identity = getMemberIdentity(member);
                  const selectId = `${idPrefix}-${member.userId}-access`;
                  return (
                    <div key={member.userId} className="grid gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_10.5rem_auto] sm:items-center">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
                          {getUserInitials(member)}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{identity.primary}</p>
                          {identity.secondary ? <p className="mt-0.5 truncate text-sm text-muted-foreground">{identity.secondary}</p> : null}
                        </div>
                      </div>

                      <div className="grid gap-1.5">
                        <Label htmlFor={selectId} className="text-xs font-medium text-muted-foreground sm:sr-only">{t('accessLevel')}</Label>
                        <select
                          id={selectId}
                          value={accessLevel}
                          disabled={busy || activeAction !== null}
                          onChange={(event) => {
                            const nextAccessLevel = event.target.value as WorkspaceAccessLevel;
                            if (nextAccessLevel === accessLevel) return;
                            void updateMember(member.userId, getAccessInput(nextAccessLevel));
                          }}
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="viewer">{t('accessLevels.viewer')}</option>
                          <option value="editor">{t('accessLevels.editor')}</option>
                          <option value="manager">{t('accessLevels.manager')}</option>
                        </select>
                      </div>

                      <div className="flex sm:justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={busy || activeAction !== null}
                          onClick={() => setRemoveTarget(member)}
                        >
                          {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Trash2 data-icon="inline-start" />}
                          {t('removeMember')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border bg-muted/20 p-4 sm:p-5" aria-labelledby={`${idPrefix}-add-heading`}>
          <div>
            <h3 id={`${idPrefix}-add-heading`} className="text-base font-semibold tracking-tight">{t('addMember')}</h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{t('addMemberDescription')}</p>
          </div>

          {availableCandidates.length === 0 ? (
            <p className="mt-4 rounded-md border border-dashed border-border bg-background/60 px-3 py-3 text-sm text-muted-foreground">
              {t('noCandidatesDescription')}
            </p>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_10.5rem_auto] sm:items-end">
              <div className="grid gap-2">
                <Label htmlFor={memberUserId}>{t('selectUser')}</Label>
                <select
                  id={memberUserId}
                  value={selectedUserId}
                  onChange={(event) => setSelectedUserId(event.target.value)}
                  disabled={activeAction !== null}
                  className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">{t('selectUser')}</option>
                  {availableCandidates.map((candidate) => (
                    <option key={candidate.userId} value={candidate.userId}>{getUserLabel(candidate)}</option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor={memberAccessId}>{t('accessLevel')}</Label>
                <select
                  id={memberAccessId}
                  value={newAccessLevel}
                  onChange={(event) => setNewAccessLevel(event.target.value as WorkspaceAccessLevel)}
                  disabled={activeAction !== null}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="viewer">{t('accessLevels.viewer')}</option>
                  <option value="editor">{t('accessLevels.editor')}</option>
                  <option value="manager">{t('accessLevels.manager')}</option>
                </select>
              </div>

              <Button
                type="button"
                className="sm:min-w-32"
                disabled={!selectedUserId || activeAction !== null}
                onClick={() => void updateMember(selectedUserId, getAccessInput(newAccessLevel))}
              >
                <UserPlus data-icon="inline-start" />
                {t('addMember')}
              </Button>
            </div>
          )}
        </section>
      </div>

      <AlertDialog open={Boolean(removeTarget)} onOpenChange={(nextOpen) => {
        if (!nextOpen) setRemoveTarget(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget ? t('removeDialog.description', { name: getMemberIdentity(removeTarget).primary }) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (removeTarget) void removeMember(removeTarget);
              }}
            >
              {t('removeDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
