'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Ban, CheckCircle2, KeyRound, Loader2, Plus, RefreshCw, Search, Shield, UserCog, UserMinus } from 'lucide-react';

import { authClient } from '@/app/lib/auth-client';
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const PAGE_SIZE = 20;

type ManagedUser = {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean | null;
  image?: string | null;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type ListUsersResponse = {
  users: ManagedUser[];
  total: number;
  limit?: number;
  offset?: number;
};

type AuthError = {
  code?: string;
  message?: string;
  status?: number;
  statusText?: string;
};

type AuthResult<T> = {
  data: T | null;
  error: AuthError | null;
};

type CreateUserDraft = {
  name: string;
  email: string;
  password: string;
  isAdmin: boolean;
};

type RoleChangeTarget = {
  user: ManagedUser;
  nextRole: 'admin' | 'user';
};

type OffboardingFinding = {
  severity: 'blocker' | 'warning' | 'info';
  category: string;
  message: string;
  count?: number;
  action?: string;
};

type OffboardingPreflight = {
  canApply: boolean;
  blockers: OffboardingFinding[];
  warnings: OffboardingFinding[];
  info: OffboardingFinding[];
  counts: Record<string, number>;
  personalWorkspace: {
    id: string;
    status: string;
    rootRelativePath: string;
  } | null;
};

function unwrapAuthResult<T>(result: unknown, fallbackMessage: string): T {
  const typed = result as AuthResult<T>;
  if (typed?.error) {
    throw new Error(typed.error.message || typed.error.code || fallbackMessage);
  }
  if (typed?.data === null || typed?.data === undefined) {
    throw new Error(fallbackMessage);
  }
  return typed.data;
}

function normalizeRole(role: string | null | undefined): 'admin' | 'user' {
  return role?.split(',').map((part) => part.trim()).includes('admin') ? 'admin' : 'user';
}

function formatDate(value: Date | string | null | undefined, locale: string): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function createEmptyDraft(): CreateUserDraft {
  return {
    name: '',
    email: '',
    password: '',
    isAdmin: false,
  };
}

function getRoleDialogCopy(locale: string, target: RoleChangeTarget | null): {
  title: string;
  description: string;
  submit: string;
} {
  if (!target) {
    return {
      title: '',
      description: '',
      submit: '',
    };
  }

  const isGerman = locale.toLowerCase().startsWith('de');
  const roleLabel = target.nextRole === 'admin'
    ? isGerman ? 'Admin' : 'administrator'
    : isGerman ? 'User' : 'regular user';

  if (isGerman) {
    return {
      title: 'Rolle ändern',
      description: `${target.user.email} wird zu ${roleLabel} geändert. Bitte bestätige diese Berechtigungsänderung.`,
      submit: 'Rolle ändern',
    };
  }

  return {
    title: 'Change role',
    description: `${target.user.email} will be changed to ${roleLabel}. Confirm this permission change before continuing.`,
    submit: 'Change role',
  };
}

export function UserManagementPanel({
  currentUserId,
  isAdmin,
}: {
  currentUserId: string;
  isAdmin: boolean;
}) {
  const t = useTranslations('settings.users');
  const locale = useLocale();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState('');
  const [searchValue, setSearchValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateUserDraft>(() => createEmptyDraft());
  const [passwordTarget, setPasswordTarget] = useState<ManagedUser | null>(null);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [roleTarget, setRoleTarget] = useState<RoleChangeTarget | null>(null);
  const [banTarget, setBanTarget] = useState<ManagedUser | null>(null);
  const [banReason, setBanReason] = useState('');
  const [offboardingTarget, setOffboardingTarget] = useState<ManagedUser | null>(null);
  const [offboardingPreflight, setOffboardingPreflight] = useState<OffboardingPreflight | null>(null);
  const [isOffboardingPreflightLoading, setIsOffboardingPreflightLoading] = useState(false);
  const [offboardingAcknowledge, setOffboardingAcknowledge] = useState(false);
  const [offboardingReason, setOffboardingReason] = useState('');

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canGoPrevious = offset > 0;
  const canGoNext = offset + PAGE_SIZE < total;

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return;

    setIsLoading(true);
    setError(null);
    try {
      const query: Record<string, string | number> = {
        limit: PAGE_SIZE,
        offset,
        sortBy: 'createdAt',
        sortDirection: 'desc',
      };
      if (searchValue) {
        query.searchValue = searchValue;
        query.searchField = 'email';
        query.searchOperator = 'contains';
      }

      const data = unwrapAuthResult<ListUsersResponse>(
        await authClient.admin.listUsers({ query }),
        t('errors.load'),
      );

      setUsers(Array.isArray(data.users) ? data.users : []);
      setTotal(typeof data.total === 'number' ? data.total : 0);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [isAdmin, offset, searchValue, t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadUsers();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadUsers]);

  const resetTransientState = () => {
    setError(null);
    setMessage(null);
  };

  const runAction = async (actionKey: string, action: () => Promise<void>, successMessage: string) => {
    setActiveAction(actionKey);
    resetTransientState();
    try {
      await action();
      setMessage(successMessage);
      await loadUsers();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('errors.action'));
    } finally {
      setActiveAction(null);
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setOffset(0);
    setSearchValue(searchDraft.trim());
  };

  const createUser = async () => {
    const name = createDraft.name.trim();
    const email = createDraft.email.trim().toLowerCase();
    const password = createDraft.password;

    if (!name || !email || password.length < 8) {
      setError(t('errors.createValidation'));
      return;
    }

    await runAction(
      'create',
      async () => {
        unwrapAuthResult<{ user: ManagedUser }>(
          await authClient.admin.createUser({
            name,
            email,
            password,
            role: createDraft.isAdmin ? 'admin' : 'user',
          }),
          t('errors.create'),
        );
        setCreateOpen(false);
        setCreateDraft(createEmptyDraft());
      },
      t('messages.created', { email }),
    );
  };

  const changeRole = async () => {
    if (!roleTarget) return;
    const { user, nextRole } = roleTarget;
    if (user.id === currentUserId) {
      setError(t('errors.selfRole'));
      return;
    }

    await runAction(
      `role:${user.id}`,
      async () => {
        unwrapAuthResult<{ user: ManagedUser }>(
          await authClient.admin.setRole({ userId: user.id, role: nextRole }),
          t('errors.role'),
        );
        setRoleTarget(null);
      },
      t('messages.roleUpdated', { email: user.email }),
    );
  };

  const savePassword = async () => {
    if (!passwordTarget) return;
    if (passwordDraft.length < 8) {
      setError(t('errors.passwordLength'));
      return;
    }

    const user = passwordTarget;
    await runAction(
      `password:${user.id}`,
      async () => {
        unwrapAuthResult<unknown>(
          await authClient.admin.setUserPassword({
            userId: user.id,
            newPassword: passwordDraft,
          }),
          t('errors.password'),
        );
        setPasswordTarget(null);
        setPasswordDraft('');
      },
      t('messages.passwordUpdated', { email: user.email }),
    );
  };

  const banUser = async () => {
    if (!banTarget) return;
    const user = banTarget;
    await runAction(
      `ban:${user.id}`,
      async () => {
        unwrapAuthResult<{ user: ManagedUser }>(
          await authClient.admin.banUser({
            userId: user.id,
            banReason: banReason.trim() || t('defaultBanReason'),
          }),
          t('errors.ban'),
        );
        setBanTarget(null);
        setBanReason('');
      },
      t('messages.banned', { email: user.email }),
    );
  };

  const unbanUser = async (user: ManagedUser) => {
    await runAction(
      `unban:${user.id}`,
      async () => {
        unwrapAuthResult<{ user: ManagedUser }>(
          await authClient.admin.unbanUser({ userId: user.id }),
          t('errors.unban'),
        );
      },
      t('messages.unbanned', { email: user.email }),
    );
  };

  const loadOffboardingPreflight = async (user: ManagedUser) => {
    setIsOffboardingPreflightLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/organization/users/${encodeURIComponent(user.id)}/offboarding`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        const preflight = payload.preflight || payload.data;
        if (preflight) {
          setOffboardingPreflight(preflight as OffboardingPreflight);
        }
        throw new Error(payload.error || t('errors.offboardingPreflight'));
      }
      setOffboardingPreflight(payload.data as OffboardingPreflight);
    } catch (preflightError) {
      setError(preflightError instanceof Error ? preflightError.message : t('errors.offboardingPreflight'));
    } finally {
      setIsOffboardingPreflightLoading(false);
    }
  };

  const openOffboardingDialog = (user: ManagedUser) => {
    setOffboardingTarget(user);
    setOffboardingPreflight(null);
    setOffboardingAcknowledge(false);
    setOffboardingReason('');
    resetTransientState();
    void loadOffboardingPreflight(user);
  };

  const offboardUser = async () => {
    if (!offboardingTarget) return;
    const user = offboardingTarget;
    await runAction(
      `offboard:${user.id}`,
      async () => {
        const response = await fetch(`/api/admin/organization/users/${encodeURIComponent(user.id)}/offboarding`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: offboardingReason.trim() || undefined,
            acknowledgeWarnings: offboardingAcknowledge,
          }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          const preflight = payload.preflight || payload.data;
          if (preflight) {
            setOffboardingPreflight(preflight as OffboardingPreflight);
          }
          throw new Error(payload.error || t('errors.offboarding'));
        }
        setOffboardingTarget(null);
        setOffboardingPreflight(null);
        setOffboardingAcknowledge(false);
        setOffboardingReason('');
      },
      t('messages.offboarded', { email: user.email }),
    );
  };

  const userRows = useMemo(() => users, [users]);
  const roleDialogCopy = getRoleDialogCopy(locale, roleTarget);
  const renderOffboardingFindings = (title: string, findings: OffboardingFinding[], tone: 'blocker' | 'warning' | 'info') => {
    if (findings.length === 0) return null;
    const toneClassName = tone === 'blocker'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : tone === 'warning'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
        : 'border-border bg-muted/40 text-muted-foreground';

    return (
      <div className={`rounded-md border p-3 ${toneClassName}`}>
        <p className="text-sm font-medium">{title}</p>
        <ul className="mt-2 space-y-1 text-sm">
          {findings.map((finding, index) => (
            <li key={`${finding.category}:${index}`} className="flex gap-2">
              <span aria-hidden="true">-</span>
              <span>
                {finding.message}
                {typeof finding.count === 'number' ? ` (${finding.count})` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  };
  const offboardingHasWarnings = Boolean(offboardingPreflight && offboardingPreflight.warnings.length > 0);
  const offboardingCanSubmit = Boolean(
    offboardingTarget &&
    offboardingPreflight?.canApply &&
    !isOffboardingPreflightLoading &&
    !activeAction?.startsWith('offboard:') &&
    (!offboardingHasWarnings || offboardingAcknowledge),
  );

  const renderUserActions = (user: ManagedUser, options: { compact?: boolean } = {}) => {
    const role = normalizeRole(user.role);
    const isSelf = user.id === currentUserId;
    const isRowBusy = activeAction?.endsWith(user.id) ?? false;
    const isBanned = Boolean(user.banned);
    const buttonClassName = options.compact ? 'w-full min-w-0' : undefined;
    const wrapperClassName = options.compact
      ? 'grid grid-cols-2 gap-2'
      : 'flex flex-wrap justify-end gap-2';

    return (
      <div className={wrapperClassName}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={buttonClassName}
          onClick={() => {
            setRoleTarget({ user, nextRole: role === 'admin' ? 'user' : 'admin' });
            resetTransientState();
          }}
          disabled={isSelf || isRowBusy || activeAction !== null}
        >
          <Shield data-icon="inline-start" />
          {role === 'admin' ? t('actions.makeUser') : t('actions.makeAdmin')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={buttonClassName}
          onClick={() => {
            setPasswordTarget(user);
            setPasswordDraft('');
            resetTransientState();
          }}
          disabled={isRowBusy || activeAction !== null}
        >
          <KeyRound data-icon="inline-start" />
          {t('actions.password')}
        </Button>
        {isBanned ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={buttonClassName}
            onClick={() => void unbanUser(user)}
            disabled={isRowBusy || activeAction !== null}
          >
            <CheckCircle2 data-icon="inline-start" />
            {t('actions.unban')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={buttonClassName}
            onClick={() => {
              setBanTarget(user);
              setBanReason('');
              resetTransientState();
            }}
            disabled={isSelf || isRowBusy || activeAction !== null}
          >
            <Ban data-icon="inline-start" />
            {t('actions.ban')}
          </Button>
        )}
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className={buttonClassName}
          onClick={() => openOffboardingDialog(user)}
          disabled={isSelf || isRowBusy || activeAction !== null}
        >
          <UserMinus data-icon="inline-start" />
          {t('actions.offboard')}
        </Button>
      </div>
    );
  };

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('forbidden')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <CardTitle>{t('title')}</CardTitle>
              <CardDescription>{t('description')}</CardDescription>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void loadUsers()} disabled={isLoading || activeAction !== null}>
                {isLoading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
                {t('reload')}
              </Button>
              <Button type="button" onClick={() => setCreateOpen(true)} disabled={activeAction !== null}>
                <Plus data-icon="inline-start" />
                {t('createUser')}
              </Button>
            </div>
          </div>
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submitSearch}>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                className="pl-9"
                placeholder={t('searchPlaceholder')}
              />
            </div>
            <Button type="submit" variant="outline">
              <Search data-icon="inline-start" />
              {t('search')}
            </Button>
            {searchValue && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSearchDraft('');
                  setSearchValue('');
                  setOffset(0);
                }}
              >
                {t('clearSearch')}
              </Button>
            )}
          </form>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium text-foreground">{t('provisioningNoteTitle')}</p>
            <p className="mt-1 text-muted-foreground">{t('provisioningNoteDescription')}</p>
          </div>
          {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
          {message && <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{message}</div>}

          <div className="flex flex-col gap-3 md:hidden">
            {isLoading ? (
              <div className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="animate-spin" />
                  {t('loading')}
                </span>
              </div>
            ) : userRows.length === 0 ? (
              <div className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
                {t('empty')}
              </div>
            ) : (
              userRows.map((user) => {
                const role = normalizeRole(user.role);
                const isSelf = user.id === currentUserId;
                const isBanned = Boolean(user.banned);

                return (
                  <div key={user.id} className="rounded-md border bg-background p-3">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">{user.name || t('unnamed')}</span>
                          {isSelf && <Badge variant="secondary">{t('self')}</Badge>}
                        </div>
                        <p className="mt-1 break-all text-xs text-muted-foreground">{user.email}</p>
                      </div>
                      <Badge variant={role === 'admin' ? 'default' : 'outline'} className="shrink-0">
                        {role === 'admin' ? t('roles.admin') : t('roles.user')}
                      </Badge>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between gap-3">
                        <span>{t('columns.status')}</span>
                        <div className="flex min-w-0 flex-col items-end gap-1">
                          <Badge variant={isBanned ? 'destructive' : 'secondary'}>
                            {isBanned ? t('status.banned') : t('status.active')}
                          </Badge>
                          {isBanned && user.banReason && (
                            <span className="max-w-44 truncate">{user.banReason}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>{t('columns.created')}</span>
                        <span className="text-right">{formatDate(user.createdAt, locale)}</span>
                      </div>
                    </div>
                    <div className="mt-3">
                      {renderUserActions(user, { compact: true })}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.user')}</TableHead>
                  <TableHead>{t('columns.role')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.created')}</TableHead>
                  <TableHead className="text-right">{t('columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="animate-spin" />
                        {t('loading')}
                      </span>
                    </TableCell>
                  </TableRow>
                ) : userRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      {t('empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  userRows.map((user) => {
                    const role = normalizeRole(user.role);
                    const isSelf = user.id === currentUserId;
                    const isBanned = Boolean(user.banned);

                    return (
                      <TableRow key={user.id}>
                        <TableCell className="min-w-60 whitespace-normal">
                          <div className="flex min-w-0 flex-col gap-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-medium">{user.name || t('unnamed')}</span>
                              {isSelf && <Badge variant="secondary">{t('self')}</Badge>}
                            </div>
                            <span className="break-all text-xs text-muted-foreground">{user.email}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={role === 'admin' ? 'default' : 'outline'}>
                            {role === 'admin' ? t('roles.admin') : t('roles.user')}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <Badge variant={isBanned ? 'destructive' : 'secondary'}>
                              {isBanned ? t('status.banned') : t('status.active')}
                            </Badge>
                            {isBanned && user.banReason && (
                              <span className="max-w-56 truncate text-xs text-muted-foreground">{user.banReason}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(user.createdAt, locale)}
                        </TableCell>
                        <TableCell>
                          {renderUserActions(user)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>{t('pagination.summary', { total, page, totalPages })}</span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={!canGoPrevious || isLoading}>
                {t('pagination.previous')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={!canGoNext || isLoading}>
                {t('pagination.next')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('createDialog.title')}</DialogTitle>
            <DialogDescription>{t('createDialog.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="user-create-name">{t('fields.name')}</Label>
              <Input
                id="user-create-name"
                value={createDraft.name}
                onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
                disabled={activeAction === 'create'}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="user-create-email">{t('fields.email')}</Label>
              <Input
                id="user-create-email"
                type="email"
                value={createDraft.email}
                onChange={(event) => setCreateDraft((current) => ({ ...current, email: event.target.value }))}
                disabled={activeAction === 'create'}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="user-create-password">{t('fields.password')}</Label>
              <Input
                id="user-create-password"
                type="password"
                value={createDraft.password}
                onChange={(event) => setCreateDraft((current) => ({ ...current, password: event.target.value }))}
                disabled={activeAction === 'create'}
              />
              <p className="text-xs text-muted-foreground">{t('createDialog.passwordHint')}</p>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <Label htmlFor="user-create-admin">{t('createDialog.adminLabel')}</Label>
                <p className="text-xs text-muted-foreground">{t('createDialog.adminDescription')}</p>
              </div>
              <Switch
                id="user-create-admin"
                checked={createDraft.isAdmin}
                onCheckedChange={(checked) => setCreateDraft((current) => ({ ...current, isAdmin: checked }))}
                disabled={activeAction === 'create'}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={activeAction === 'create'}>
              {t('cancel')}
            </Button>
            <Button type="button" onClick={() => void createUser()} disabled={activeAction === 'create'}>
              {activeAction === 'create' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <UserCog data-icon="inline-start" />}
              {t('createDialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(roleTarget)} onOpenChange={(open) => !open && setRoleTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{roleDialogCopy.title}</AlertDialogTitle>
            <AlertDialogDescription>{roleDialogCopy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={activeAction?.startsWith('role:')}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={activeAction?.startsWith('role:')} onClick={() => void changeRole()}>
              {roleDialogCopy.submit}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(passwordTarget)} onOpenChange={(open) => !open && setPasswordTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('passwordDialog.title')}</DialogTitle>
            <DialogDescription>
              {passwordTarget ? t('passwordDialog.description', { email: passwordTarget.email }) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="user-reset-password">{t('fields.newPassword')}</Label>
            <Input
              id="user-reset-password"
              type="password"
              value={passwordDraft}
              onChange={(event) => setPasswordDraft(event.target.value)}
              disabled={activeAction?.startsWith('password:')}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPasswordTarget(null)} disabled={activeAction?.startsWith('password:')}>
              {t('cancel')}
            </Button>
            <Button type="button" onClick={() => void savePassword()} disabled={activeAction?.startsWith('password:')}>
              {activeAction?.startsWith('password:') ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <KeyRound data-icon="inline-start" />}
              {t('passwordDialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(banTarget)} onOpenChange={(open) => !open && setBanTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('banDialog.title')}</DialogTitle>
            <DialogDescription>
              {banTarget ? t('banDialog.description', { email: banTarget.email }) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="user-ban-reason">{t('banDialog.reason')}</Label>
            <Input
              id="user-ban-reason"
              value={banReason}
              onChange={(event) => setBanReason(event.target.value)}
              placeholder={t('defaultBanReason')}
              disabled={activeAction?.startsWith('ban:')}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBanTarget(null)} disabled={activeAction?.startsWith('ban:')}>
              {t('cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void banUser()} disabled={activeAction?.startsWith('ban:')}>
              {activeAction?.startsWith('ban:') ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Ban data-icon="inline-start" />}
              {t('banDialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(offboardingTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setOffboardingTarget(null);
            setOffboardingPreflight(null);
            setOffboardingAcknowledge(false);
            setOffboardingReason('');
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('offboardingDialog.title')}</DialogTitle>
            <DialogDescription>
              {offboardingTarget ? t('offboardingDialog.description', { email: offboardingTarget.email }) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
            {isOffboardingPreflightLoading ? (
              <div className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="animate-spin" />
                  {t('offboardingDialog.loading')}
                </span>
              </div>
            ) : offboardingPreflight ? (
              <>
                <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">{t('offboardingDialog.summaryTitle')}</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <span>{t('offboardingDialog.summary.sessions', { count: offboardingPreflight.counts.activeSessions || 0 })}</span>
                    <span>{t('offboardingDialog.summary.automations', {
                      count: (offboardingPreflight.counts.personalAutomations || 0)
                        + (offboardingPreflight.counts.organizationResponsibleAutomations || 0)
                        + (offboardingPreflight.counts.organizationReviewAutomations || 0),
                    })}</span>
                    <span>{t('offboardingDialog.summary.todos', { count: offboardingPreflight.counts.openAssignedTodos || 0 })}</span>
                    <span>{t('offboardingDialog.summary.credentials', {
                      count: (offboardingPreflight.counts.authAccounts || 0) + (offboardingPreflight.counts.activeEmailAccounts || 0),
                    })}</span>
                  </div>
                </div>

                {renderOffboardingFindings(t('offboardingDialog.blockers'), offboardingPreflight.blockers, 'blocker')}
                {renderOffboardingFindings(t('offboardingDialog.warnings'), offboardingPreflight.warnings, 'warning')}
                {renderOffboardingFindings(t('offboardingDialog.info'), offboardingPreflight.info, 'info')}

                <div className="flex flex-col gap-2">
                  <Label htmlFor="user-offboarding-reason">{t('offboardingDialog.reason')}</Label>
                  <Input
                    id="user-offboarding-reason"
                    value={offboardingReason}
                    onChange={(event) => setOffboardingReason(event.target.value)}
                    placeholder={t('offboardingDialog.reasonPlaceholder')}
                    disabled={activeAction?.startsWith('offboard:')}
                  />
                </div>

                {offboardingHasWarnings && (
                  <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={offboardingAcknowledge}
                      onChange={(event) => setOffboardingAcknowledge(event.target.checked)}
                      disabled={activeAction?.startsWith('offboard:')}
                    />
                    <span className="text-muted-foreground">
                      {t('offboardingDialog.acknowledgeWarnings')}
                    </span>
                  </label>
                )}

                {!offboardingPreflight.canApply && (
                  <div className="inline-flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{t('offboardingDialog.blockedHint')}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
                {t('offboardingDialog.empty')}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOffboardingTarget(null)}
              disabled={activeAction?.startsWith('offboard:')}
            >
              {t('cancel')}
            </Button>
            {offboardingTarget && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => void offboardUser()}
                disabled={!offboardingCanSubmit}
              >
                {activeAction?.startsWith('offboard:') ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <UserMinus data-icon="inline-start" />}
                {t('offboardingDialog.submit')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
