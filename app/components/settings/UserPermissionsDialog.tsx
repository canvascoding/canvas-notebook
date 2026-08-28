'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Save, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type ManagedUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
};

type OrganizationRole = 'owner' | 'admin' | 'member' | 'external';
type OrganizationStatus = 'active' | 'disabled' | 'archived' | 'recovery_locked';

const PERMISSION_KEYS = [
  'canWriteTeamWorkspace',
  'canCreatePublicLinks',
  'canCreateTeamAutomations',
  'canSharePluginsAndSkills',
  'canExport',
  'canDeleteTeamFiles',
  'canDeleteStudioAssets',
  'canManageBackups',
  'canManageOrganizationMemory',
  'canMigrateDatabase',
  'canEnableKnowledge',
  'canRecoverWorkspaces',
] as const;

type PermissionKey = typeof PERMISSION_KEYS[number];
type PermissionDraft = Record<PermissionKey, boolean>;

type PermissionDetails = {
  userId: string;
  name: string | null;
  email: string | null;
  role: OrganizationRole;
  status: OrganizationStatus;
  permissions: PermissionDraft;
};

type PermissionResponse = {
  success?: boolean;
  user?: PermissionDetails;
  externalUsersEnabled?: boolean;
  error?: string;
};

const PERMISSION_GROUPS: Array<{
  key: string;
  permissions: PermissionKey[];
}> = [
  {
    key: 'workspace',
    permissions: ['canWriteTeamWorkspace', 'canDeleteTeamFiles', 'canCreatePublicLinks'],
  },
  {
    key: 'automations',
    permissions: ['canCreateTeamAutomations'],
  },
  {
    key: 'plugins',
    permissions: ['canSharePluginsAndSkills'],
  },
  {
    key: 'studio',
    permissions: ['canDeleteStudioAssets'],
  },
  {
    key: 'admin',
    permissions: ['canExport', 'canManageBackups', 'canManageOrganizationMemory', 'canMigrateDatabase', 'canEnableKnowledge', 'canRecoverWorkspaces'],
  },
];

function defaultPermissionsForRole(role: OrganizationRole): PermissionDraft {
  const isAdminLike = role === 'owner' || role === 'admin';
  const isInternal = role !== 'external';
  return {
    canWriteTeamWorkspace: isAdminLike,
    canCreatePublicLinks: isInternal,
    canCreateTeamAutomations: isAdminLike,
    canSharePluginsAndSkills: isAdminLike,
    canExport: isAdminLike,
    canDeleteTeamFiles: isAdminLike,
    canDeleteStudioAssets: isInternal,
    canManageBackups: isAdminLike,
    canManageOrganizationMemory: false,
    canMigrateDatabase: isAdminLike,
    canEnableKnowledge: isAdminLike,
    canRecoverWorkspaces: isAdminLike,
  };
}

function emptyPermissions(): PermissionDraft {
  return defaultPermissionsForRole('external');
}

export function UserPermissionsDialog({
  open,
  onOpenChange,
  user,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: ManagedUser | null;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations('settings.users');
  const permissionsT = useTranslations('settings.users.permissionsDialog');
  const [details, setDetails] = useState<PermissionDetails | null>(null);
  const [externalUsersEnabled, setExternalUsersEnabled] = useState(false);
  const [roleDraft, setRoleDraft] = useState<OrganizationRole>('member');
  const [permissionDraft, setPermissionDraft] = useState<PermissionDraft>(() => emptyPermissions());
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPermissions = useCallback(async () => {
    if (!open || !user) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/organization/users/${encodeURIComponent(user.id)}/permissions`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json() as PermissionResponse;
      if (!response.ok || !payload.success || !payload.user) {
        throw new Error(payload.error || t('errors.permissionsLoad'));
      }
      setDetails(payload.user);
      setExternalUsersEnabled(payload.externalUsersEnabled === true);
      setRoleDraft(payload.user.role);
      setPermissionDraft(payload.user.permissions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.permissionsLoad'));
    } finally {
      setIsLoading(false);
    }
  }, [open, t, user]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadPermissions();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadPermissions]);

  const displayName = details?.name || user?.name || t('unnamed');
  const displayEmail = details?.email || user?.email || '';
  const canEdit = Boolean(details && details.status === 'active' && details.role !== 'owner');
  const effectivePermissions = roleDraft === 'external' ? emptyPermissions() : permissionDraft;

  const hasChanges = useMemo(() => {
    if (!details) return false;
    if (details.role !== roleDraft) return true;
    return PERMISSION_KEYS.some((key) => details.permissions[key] !== effectivePermissions[key]);
  }, [details, effectivePermissions, roleDraft]);

  const save = async () => {
    if (!details || !user || !canEdit) return;
    setIsSaving(true);
    setError(null);
    try {
      let saved = details;
      if (roleDraft !== details.role) {
        const roleResponse = await fetch(`/api/admin/organization/users/${encodeURIComponent(user.id)}/role`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: roleDraft }),
        });
        const rolePayload = await roleResponse.json() as PermissionResponse;
        if (!roleResponse.ok || !rolePayload.success || !rolePayload.user) {
          throw new Error(rolePayload.error || t('errors.role'));
        }
        saved = rolePayload.user;
        setExternalUsersEnabled(rolePayload.externalUsersEnabled === true);
      }

      const permissionResponse = await fetch(`/api/admin/organization/users/${encodeURIComponent(user.id)}/permissions`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(effectivePermissions),
      });
      const permissionPayload = await permissionResponse.json() as PermissionResponse;
      if (!permissionResponse.ok || !permissionPayload.success || !permissionPayload.user) {
        throw new Error(permissionPayload.error || t('errors.permissionsSave'));
      }
      saved = permissionPayload.user;
      setDetails(saved);
      setRoleDraft(saved.role);
      setPermissionDraft(saved.permissions);
      await onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.permissionsSave'));
    } finally {
      setIsSaving(false);
    }
  };

  const setRole = (role: OrganizationRole) => {
    setRoleDraft(role);
    setPermissionDraft(defaultPermissionsForRole(role));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)]">
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <DialogTitle>{permissionsT('title', { name: displayName })}</DialogTitle>
              <DialogDescription className="break-all">{displayEmail}</DialogDescription>
            </div>
            {details ? (
              <Badge variant={details.status === 'active' ? 'secondary' : 'outline'} className="w-fit shrink-0">
                {permissionsT(`status.${details.status}`)}
              </Badge>
            ) : null}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {isLoading ? (
            <div className="rounded-md border px-3 py-8 text-center text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="animate-spin" />
                {permissionsT('loading')}
              </span>
            </div>
          ) : details ? (
            <div className="flex flex-col gap-4">
              {error ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <div className="grid gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center">
                <div className="min-w-0">
                  <Label htmlFor="user-permissions-role">{permissionsT('role')}</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {details.role === 'owner' ? permissionsT('ownerLocked') : permissionsT('roleDescription')}
                  </p>
                </div>
                <select
                  id="user-permissions-role"
                  value={roleDraft}
                  onChange={(event) => setRole(event.target.value as OrganizationRole)}
                  disabled={!canEdit || isSaving}
                  className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {details.role === 'owner' ? <option value="owner">{permissionsT('roles.owner')}</option> : null}
                  <option value="admin">{permissionsT('roles.admin')}</option>
                  <option value="member">{permissionsT('roles.member')}</option>
                  <option value="external" disabled={!externalUsersEnabled}>
                    {permissionsT('roles.external')}
                  </option>
                </select>
              </div>

              {!externalUsersEnabled ? (
                <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {permissionsT('roles.externalDisabled')}
                </p>
              ) : null}

              {roleDraft === 'external' ? (
                <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {permissionsT('externalPermissionsDisabled')}
                </p>
              ) : null}

              <div className="grid gap-3 lg:grid-cols-2">
                {PERMISSION_GROUPS.map((group) => (
                  <section key={group.key} className="rounded-md border p-3">
                    <div className="mb-3 flex items-center gap-2">
                      <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
                      <h3 className="text-sm font-medium">{permissionsT(`groups.${group.key}`)}</h3>
                    </div>
                    <div className="flex flex-col divide-y">
                      {group.permissions.map((key) => (
                        <div key={key} className="flex min-h-12 items-center justify-between gap-3 py-2">
                          <Label htmlFor={`user-permission-${key}`} className="min-w-0 text-sm leading-snug">
                            {permissionsT(`permissions.${key}`)}
                          </Label>
                          <Switch
                            id={`user-permission-${key}`}
                            checked={effectivePermissions[key]}
                            onCheckedChange={(checked) => {
                              setPermissionDraft((current) => ({ ...current, [key]: checked }));
                            }}
                            disabled={!canEdit || isSaving || roleDraft === 'external'}
                          />
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-md border px-3 py-8 text-center text-sm text-muted-foreground">
              {error || t('errors.permissionsLoad')}
            </div>
          )}
        </div>

        <DialogFooter className="border-t px-4 py-4 sm:px-6">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canEdit || !hasChanges || isSaving || isLoading}>
            {isSaving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
            {permissionsT('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
