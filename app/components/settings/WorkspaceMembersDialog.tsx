'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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

interface WorkspaceMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: ClientWorkspaceSummary | null;
}

function getUserLabel(user: { name?: string | null; email?: string | null; userId: string }) {
  return user.email || user.name || user.userId;
}

export function WorkspaceMembersDialog({
  open,
  onOpenChange,
  workspace,
}: WorkspaceMembersDialogProps) {
  const t = useTranslations('settings.workspacePanel.management.members');
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([]);
  const [candidates, setCandidates] = useState<WorkspaceMemberCandidate[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [newCanRead, setNewCanRead] = useState(true);
  const [newCanWrite, setNewCanWrite] = useState(false);
  const [newCanManage, setNewCanManage] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetDraft = () => {
    setSelectedUserId('');
    setNewCanRead(true);
    setNewCanWrite(false);
    setNewCanManage(false);
    setError(null);
  };

  const loadMembers = useCallback(async () => {
    if (!workspace) return;
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
      const message = err instanceof Error ? err.message : t('errors.load');
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [workspace, t]);

  useEffect(() => {
    if (!open || !workspace) return;
    const timeout = window.setTimeout(() => {
      void loadMembers();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [open, workspace, loadMembers]);

  const availableCandidates = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.userId));
    return candidates.filter((candidate) => !memberIds.has(candidate.userId));
  }, [candidates, members]);

  const updateMember = async (
    userId: string,
    input: { canRead: boolean; canWrite: boolean; canManage: boolean; role?: string },
  ) => {
    if (!workspace) return;
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
      resetDraft();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errors.save');
      setError(message);
    } finally {
      setActiveAction(null);
    }
  };

  const removeMember = async (member: WorkspaceMemberRecord) => {
    if (!workspace) return;
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
      await loadMembers();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errors.remove');
      setError(message);
    } finally {
      setActiveAction(null);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetDraft();
      setMembers([]);
      setCandidates([]);
      setActiveAction(null);
    }
    onOpenChange(nextOpen);
  };

  const title = workspace ? t('title', { name: workspace.name }) : t('titleFallback');

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent layout="viewport">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{t('currentMembers')}</h3>
                <p className="text-sm text-muted-foreground">{t('currentMembersDescription')}</p>
              </div>
              <Button type="button" variant="outline" onClick={() => void loadMembers()} disabled={isLoading || activeAction !== null}>
                {isLoading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
                {t('refresh')}
              </Button>
            </div>

            {error ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            {isLoading && members.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
                <Loader2 data-icon="inline-start" className="animate-spin" />
                {t('loading')}
              </div>
            ) : members.length === 0 ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
                {t('noMembers')}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {members.map((member) => {
                  const busy = activeAction?.endsWith(member.userId) ?? false;
                  const nextRead = member.canRead;
                  const nextWrite = member.canWrite;
                  const nextManage = member.canManage;
                  return (
                    <div key={member.userId} className="grid gap-3 rounded-md border border-border px-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate text-sm font-medium">{getUserLabel(member)}</span>
                          <Badge variant={member.canManage ? 'default' : 'outline'}>{t(`roles.${member.role}`)}</Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{member.userId}</p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[repeat(3,7rem)_auto] sm:items-center">
                        {(['canRead', 'canWrite', 'canManage'] as const).map((key) => {
                          const checked = key === 'canRead' ? nextRead : key === 'canWrite' ? nextWrite : nextManage;
                          return (
                            <label key={key} className="flex items-center justify-between gap-2 text-sm">
                              <span>{t(`permissions.${key}`)}</span>
                              <Switch
                                checked={checked}
                                disabled={busy || activeAction !== null}
                                onCheckedChange={(checkedValue) => {
                                  const canManage = key === 'canManage' ? checkedValue : nextManage;
                                  const canWrite = canManage || (key === 'canWrite' ? checkedValue : nextWrite);
                                  const canRead = canManage || canWrite || (key === 'canRead' ? checkedValue : nextRead);
                                  void updateMember(member.userId, {
                                    canRead,
                                    canWrite,
                                    canManage,
                                    role: canManage ? 'admin' : member.role,
                                  });
                                }}
                              />
                            </label>
                          );
                        })}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={busy || activeAction !== null}
                          onClick={() => void removeMember(member)}
                          aria-label={t('removeMember')}
                          title={t('removeMember')}
                        >
                          {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="rounded-md border border-border px-3 py-3">
              <div className="flex flex-col gap-3">
                <div>
                  <h3 className="text-sm font-semibold">{t('addMember')}</h3>
                  <p className="text-sm text-muted-foreground">{t('addMemberDescription')}</p>
                </div>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_repeat(3,7rem)_auto] lg:items-end">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="workspace-member-user">{t('selectUser')}</Label>
                    <select
                      id="workspace-member-user"
                      value={selectedUserId}
                      onChange={(event) => setSelectedUserId(event.target.value)}
                      disabled={activeAction !== null || availableCandidates.length === 0}
                      className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">{availableCandidates.length === 0 ? t('noCandidates') : t('selectUser')}</option>
                      {availableCandidates.map((candidate) => (
                        <option key={candidate.userId} value={candidate.userId}>
                          {getUserLabel(candidate)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {[
                    ['canRead', newCanRead, setNewCanRead],
                    ['canWrite', newCanWrite, setNewCanWrite],
                    ['canManage', newCanManage, setNewCanManage],
                  ].map(([key, checked, setChecked]) => (
                    <label key={String(key)} className="flex items-center justify-between gap-2 text-sm">
                      <span>{t(`permissions.${key}`)}</span>
                      <Switch
                        checked={Boolean(checked)}
                        disabled={activeAction !== null}
                        onCheckedChange={(value) => {
                          const updater = setChecked as (next: boolean) => void;
                          updater(value);
                          if (key === 'canManage' && value) {
                            setNewCanWrite(true);
                            setNewCanRead(true);
                          }
                          if (key === 'canWrite' && value) {
                            setNewCanRead(true);
                          }
                        }}
                      />
                    </label>
                  ))}
                  <Button
                    type="button"
                    disabled={!selectedUserId || activeAction !== null}
                    onClick={() => void updateMember(selectedUserId, {
                      canRead: newCanRead,
                      canWrite: newCanWrite,
                      canManage: newCanManage,
                      role: newCanManage ? 'admin' : 'member',
                    })}
                  >
                    <UserPlus data-icon="inline-start" />
                    {t('addMember')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border px-5 py-4">
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
