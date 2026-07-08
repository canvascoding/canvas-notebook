'use client';

import { FormEvent, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ArrowLeftRight, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ClientWorkspaceSummary, ClientWorkspaceType } from '@/app/lib/workspaces/client-types';

type ChangeWorkspaceType = Extract<ClientWorkspaceType, 'personal' | 'team' | 'project'>;

interface WorkspaceTypeChangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: ClientWorkspaceSummary | null;
  teamFeaturesEnabled: boolean;
  projectFeaturesEnabled: boolean;
  onChanged: (workspace: ClientWorkspaceSummary) => void | Promise<void>;
}

type ProjectOption = {
  id: string;
  name: string;
  workspaceId?: string | null;
};

function mapTypeChangeError(code: unknown, fallback: string): string | null {
  if (code === 'WORKSPACE_DEFAULT_TYPE_LOCKED') return 'typeChange.errors.defaultLocked';
  if (code === 'WORKSPACE_ORGANIZATION_TYPE_LOCKED') return 'typeChange.errors.organizationLocked';
  if (code === 'WORKSPACE_ORGANIZATION_TYPE_UNSUPPORTED') return 'typeChange.errors.organizationUnsupported';
  if (code === 'WORKSPACE_PROJECT_NOT_FOUND') return 'typeChange.errors.projectNotFound';
  if (code === 'WORKSPACE_PROJECT_ALREADY_HAS_WORKSPACE') return 'typeChange.errors.projectHasWorkspace';
  if (code === 'WORKSPACE_ROOT_EXISTS') return 'typeChange.errors.rootExists';
  if (code === 'WORKSPACE_TEAM_FEATURES_DISABLED') return 'typeChange.errors.teamDisabled';
  return fallback ? null : 'typeChange.errors.failed';
}

export function WorkspaceTypeChangeDialog({
  open,
  onOpenChange,
  workspace,
  teamFeaturesEnabled,
  projectFeaturesEnabled,
  onChanged,
}: WorkspaceTypeChangeDialogProps) {
  const t = useTranslations('settings.workspacePanel.management');
  const workspaceTypesT = useTranslations('workspaces.types');
  const typeId = useId();
  const confirmId = useId();
  const [targetType, setTargetType] = useState<ChangeWorkspaceType>('personal');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadProjects = useCallback(async () => {
    if (!open || !projectFeaturesEnabled) return;
    setProjectsLoading(true);
    try {
      const response = await fetch('/api/projects', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setProjects([]);
        return;
      }
      setProjects(Array.isArray(payload.projects) ? payload.projects : []);
    } catch {
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, [open, projectFeaturesEnabled]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadProjects();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadProjects]);

  const availableProjects = useMemo(
    () => projects.filter((project) => !project.workspaceId || project.workspaceId === workspace?.id),
    [projects, workspace?.id],
  );

  const availableTypes = useMemo(() => {
    const options: Array<{ value: ChangeWorkspaceType; label: string; disabled?: boolean; note?: string }> = [
      { value: 'personal', label: workspaceTypesT('personal') },
      { value: 'team', label: workspaceTypesT('team'), disabled: !teamFeaturesEnabled, note: !teamFeaturesEnabled ? t('teamFeatureNotEnabled') : undefined },
      {
        value: 'project',
        label: workspaceTypesT('project'),
        disabled: !projectFeaturesEnabled || projectsLoading || availableProjects.length === 0,
        note: !projectFeaturesEnabled
          ? t('projectFeatureNotEnabled')
          : projectsLoading
            ? t('loadingProjects')
          : availableProjects.length === 0
            ? t('noProjectsAvailable')
            : undefined,
      },
    ];
    return options.filter((option) => option.value !== workspace?.type);
  }, [availableProjects.length, projectFeaturesEnabled, projectsLoading, t, teamFeaturesEnabled, workspace?.type, workspaceTypesT]);

  const firstAvailableType = (availableTypes.find((option) => !option.disabled) ?? availableTypes[0])?.value ?? 'personal';
  const effectiveTargetType = availableTypes.some((option) => option.value === targetType)
    ? targetType
    : firstAvailableType;

  const reset = () => {
    setTargetType('personal');
    setProjectId('');
    setConfirmText('');
    setError(null);
    setIsSubmitting(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !isSubmitting) reset();
    onOpenChange(nextOpen);
  };

  const requiresConfirmation = workspace?.type === 'personal' || effectiveTargetType === 'personal';
  const expectedConfirmation = t('typeChange.confirmValue');
  const selectedOption = availableTypes.find((option) => option.value === effectiveTargetType);
  const submitDisabled = Boolean(
    !workspace ||
    selectedOption?.disabled ||
    isSubmitting ||
    (effectiveTargetType === 'project' && !projectId) ||
    (requiresConfirmation && confirmText.trim() !== expectedConfirmation),
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspace || submitDisabled) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: effectiveTargetType, projectId: effectiveTargetType === 'project' ? projectId : undefined }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success || !payload.workspace) {
        const key = mapTypeChangeError(payload.code, payload.error);
        throw new Error(key ? t(key) : payload.error || t('typeChange.errors.failed'));
      }
      await onChanged(payload.workspace as ClientWorkspaceSummary);
      reset();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('typeChange.errors.failed');
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{t('typeChange.title')}</DialogTitle>
            <DialogDescription>{workspace ? t('typeChange.description', { name: workspace.name }) : t('typeChange.descriptionFallback')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {workspace ? t('typeChange.currentType', { type: workspaceTypesT(workspace.type) }) : t('typeChange.noWorkspace')}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={typeId}>{t('typeChange.newType')}</Label>
              <select
                id={typeId}
                value={effectiveTargetType}
                onChange={(event) => {
                  setTargetType(event.target.value as ChangeWorkspaceType);
                  setProjectId('');
                  setConfirmText('');
                }}
                disabled={isSubmitting}
                className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {availableTypes.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </select>
              {selectedOption?.note ? (
                <p className="text-xs text-muted-foreground">{selectedOption.note}</p>
              ) : null}
            </div>

            {effectiveTargetType === 'project' ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${typeId}-project`}>{t('fields.project')}</Label>
                <select
                  id={`${typeId}-project`}
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  disabled={isSubmitting || projectsLoading || availableProjects.length === 0}
                  className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">{projectsLoading ? t('loadingProjects') : t('fields.projectPlaceholder')}</option>
                  {availableProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t('typeChange.warning')}
            </p>

            {requiresConfirmation ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={confirmId}>{t('typeChange.confirmLabel', { value: expectedConfirmation })}</Label>
                <Input
                  id={confirmId}
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  disabled={isSubmitting}
                  autoComplete="off"
                />
              </div>
            ) : null}

            {error ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isSubmitting}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {isSubmitting ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <ArrowLeftRight data-icon="inline-start" />
              )}
              {t('typeChange.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
