'use client';

import { useId, useState } from 'react';
import { Loader2, RefreshCw, Trash2, UserPlus } from 'lucide-react';

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

export type MemberAccessPerson<TAccessLevel extends string> = {
  userId: string;
  name: string | null;
  email: string | null;
  accessLevel: TAccessLevel;
};

export type MemberAccessCandidate = {
  userId: string;
  name: string | null;
  email: string | null;
};

type MemberAccessLabels = {
  currentMembers: string;
  currentMembersDescription: string;
  addMember: string;
  addMemberDescription: string;
  selectUser: string;
  accessLevel: string;
  person: string;
  actions: string;
  removeMember: string;
  refresh: string;
  loading: string;
  noMembers: string;
  noCandidatesDescription: string;
  cancel: string;
  removeTitle: string;
  removeDescription: (name: string) => string;
  removeConfirm: string;
};

type MemberAccessEditorProps<TAccessLevel extends string> = {
  members: Array<MemberAccessPerson<TAccessLevel>>;
  candidates: MemberAccessCandidate[];
  accessLevels: Array<{ value: TAccessLevel; label: string }>;
  selectedUserId: string;
  newAccessLevel: TAccessLevel;
  isLoading: boolean;
  activeAction: string | null;
  error: string | null;
  labels: MemberAccessLabels;
  onRefresh: () => void;
  onSelectedUserIdChange: (userId: string) => void;
  onNewAccessLevelChange: (accessLevel: TAccessLevel) => void;
  onUpdateMember: (userId: string, accessLevel: TAccessLevel) => void;
  onRemoveMember: (member: MemberAccessPerson<TAccessLevel>) => void;
};

function getUserLabel(user: MemberAccessCandidate) {
  const name = user.name?.trim();
  const email = user.email?.trim();
  if (name && email && name !== email) return `${name} · ${email}`;
  return name || email || user.userId;
}

function getUserInitials(user: MemberAccessCandidate) {
  const source = user.name?.trim() || user.email?.trim() || user.userId;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
}

function getMemberIdentity(member: MemberAccessCandidate) {
  const name = member.name?.trim();
  const email = member.email?.trim();
  if (name && email && name !== email) return { primary: name, secondary: email };
  return { primary: name || email || member.userId, secondary: null };
}

export function MemberAccessEditor<TAccessLevel extends string>({
  members,
  candidates,
  accessLevels,
  selectedUserId,
  newAccessLevel,
  isLoading,
  activeAction,
  error,
  labels,
  onRefresh,
  onSelectedUserIdChange,
  onNewAccessLevelChange,
  onUpdateMember,
  onRemoveMember,
}: MemberAccessEditorProps<TAccessLevel>) {
  const idPrefix = useId();
  const [removeTarget, setRemoveTarget] = useState<MemberAccessPerson<TAccessLevel> | null>(null);
  const userSelectId = `${idPrefix}-user`;
  const accessSelectId = `${idPrefix}-access`;

  return (
    <>
      <div className="flex w-full flex-col gap-6">
        <section aria-labelledby={`${idPrefix}-members-heading`} aria-busy={isLoading}>
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h3 id={`${idPrefix}-members-heading`} className="text-base font-semibold tracking-tight">{labels.currentMembers}</h3>
              <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">{labels.currentMembersDescription}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 self-start sm:self-auto"
              onClick={onRefresh}
              disabled={isLoading || activeAction !== null}
            >
              {isLoading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
              {labels.refresh}
            </Button>
          </div>

          {error ? (
            <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          ) : null}

          {isLoading && members.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
              <Loader2 data-icon="inline-start" className="animate-spin" />
              {labels.loading}
            </div>
          ) : members.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-5 text-sm text-muted-foreground">{labels.noMembers}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="hidden grid-cols-[minmax(0,1fr)_10.5rem_auto] items-center gap-4 border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                <span>{labels.person}</span>
                <span>{labels.accessLevel}</span>
                <span className="sr-only">{labels.actions}</span>
              </div>
              <div className="divide-y divide-border">
                {members.map((member) => {
                  const busy = activeAction?.endsWith(member.userId) ?? false;
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
                        <Label htmlFor={selectId} className="text-xs font-medium text-muted-foreground sm:sr-only">{labels.accessLevel}</Label>
                        <select
                          id={selectId}
                          value={member.accessLevel}
                          disabled={busy || activeAction !== null}
                          onChange={(event) => {
                            const nextLevel = event.target.value as TAccessLevel;
                            if (nextLevel !== member.accessLevel) onUpdateMember(member.userId, nextLevel);
                          }}
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {accessLevels.map((accessLevel) => (
                            <option key={accessLevel.value} value={accessLevel.value}>{accessLevel.label}</option>
                          ))}
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
                          {labels.removeMember}
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
          <h3 id={`${idPrefix}-add-heading`} className="text-base font-semibold tracking-tight">{labels.addMember}</h3>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{labels.addMemberDescription}</p>

          {candidates.length === 0 ? (
            <p className="mt-4 rounded-md border border-dashed border-border bg-background/60 px-3 py-3 text-sm text-muted-foreground">{labels.noCandidatesDescription}</p>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_10.5rem_auto] sm:items-end">
              <div className="grid gap-2">
                <Label htmlFor={userSelectId}>{labels.selectUser}</Label>
                <select
                  id={userSelectId}
                  value={selectedUserId}
                  onChange={(event) => onSelectedUserIdChange(event.target.value)}
                  disabled={activeAction !== null}
                  className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">{labels.selectUser}</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.userId} value={candidate.userId}>{getUserLabel(candidate)}</option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor={accessSelectId}>{labels.accessLevel}</Label>
                <select
                  id={accessSelectId}
                  value={newAccessLevel}
                  onChange={(event) => onNewAccessLevelChange(event.target.value as TAccessLevel)}
                  disabled={activeAction !== null}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {accessLevels.map((accessLevel) => (
                    <option key={accessLevel.value} value={accessLevel.value}>{accessLevel.label}</option>
                  ))}
                </select>
              </div>

              <Button
                type="button"
                className="sm:min-w-32"
                disabled={!selectedUserId || activeAction !== null}
                onClick={() => onUpdateMember(selectedUserId, newAccessLevel)}
              >
                <UserPlus data-icon="inline-start" />
                {labels.addMember}
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
            <AlertDialogTitle>{labels.removeTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget ? labels.removeDescription(getMemberIdentity(removeTarget).primary) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{labels.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (removeTarget) {
                  onRemoveMember(removeTarget);
                  setRemoveTarget(null);
                }
              }}
            >
              {labels.removeConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
