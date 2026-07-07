'use client';

import { FormEvent, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
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

type CreateWorkspaceType = Extract<ClientWorkspaceType, 'personal' | 'team' | 'project'>;

type ProjectOption = {
  id: string;
  name: string;
  workspaceId?: string | null;
};

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canCreateTeamWorkspace: boolean;
  teamFeaturesEnabled: boolean;
  projectFeaturesEnabled: boolean;
  onCreated: (workspace: ClientWorkspaceSummary) => void | Promise<void>;
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  canCreateTeamWorkspace,
  teamFeaturesEnabled,
  projectFeaturesEnabled,
  onCreated,
}: CreateWorkspaceDialogProps) {
  const t = useTranslations('settings.workspacePanel.management');
  const workspaceTypesT = useTranslations('workspaces.types');
  const nameId = useId();
  const typeId = useId();
  const [name, setName] = useState('');
  const [type, setType] = useState<CreateWorkspaceType>('personal');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadProjects = useCallback(async () => {
    if (!open || !projectFeaturesEnabled || !canCreateTeamWorkspace) return;
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
  }, [canCreateTeamWorkspace, open, projectFeaturesEnabled]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadProjects();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadProjects]);

  const availableProjects = useMemo(
    () => projects.filter((project) => !project.workspaceId),
    [projects],
  );

  const availableTypes = useMemo(() => {
    const options: Array<{ value: CreateWorkspaceType; label: string; disabled?: boolean }> = [
      { value: 'personal', label: workspaceTypesT('personal') },
    ];
    if (canCreateTeamWorkspace) {
      options.push({
        value: 'team',
        label: workspaceTypesT('team'),
        disabled: !teamFeaturesEnabled,
      });
    }
    if (canCreateTeamWorkspace && projectFeaturesEnabled) {
      options.push({
        value: 'project',
        label: workspaceTypesT('project'),
        disabled: projectsLoading || availableProjects.length === 0,
      });
    }
    return options;
  }, [availableProjects.length, canCreateTeamWorkspace, projectFeaturesEnabled, projectsLoading, teamFeaturesEnabled, workspaceTypesT]);

  const resetForm = () => {
    setName('');
    setType('personal');
    setProjectId('');
    setError(null);
    setIsSubmitting(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !isSubmitting) {
      resetForm();
    }
    onOpenChange(nextOpen);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('errors.nameRequired'));
      return;
    }
    if (trimmedName.length > 80) {
      setError(t('errors.nameTooLong'));
      return;
    }
    if (type === 'project' && !projectId) {
      setError(t('errors.projectRequired'));
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, type, projectId: type === 'project' ? projectId : undefined }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success || !payload.workspace) {
        throw new Error(payload.error || t('errors.createFailed'));
      }
      await onCreated(payload.workspace as ClientWorkspaceSummary);
      resetForm();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errors.createFailed');
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
            <DialogTitle>{t('createDialog.title')}</DialogTitle>
            <DialogDescription>{t('createDialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={nameId}>{t('fields.name')}</Label>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                required
                aria-invalid={Boolean(error)}
                placeholder={t('fields.namePlaceholder')}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={typeId}>{t('fields.type')}</Label>
              <select
                id={typeId}
                value={type}
                onChange={(event) => setType(event.target.value as CreateWorkspaceType)}
                className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {availableTypes.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {type === 'team' || type === 'project' ? t('hints.teamProjectAccess') : t('hints.personalOnly')}
              </p>
            </div>

            {type === 'project' ? (
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
                {availableProjects.length === 0 && !projectsLoading ? (
                  <p className="text-xs text-muted-foreground">{t('noProjectsAvailable')}</p>
                ) : null}
              </div>
            ) : null}

            {canCreateTeamWorkspace && !teamFeaturesEnabled ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t('teamFeatureNotEnabled')}
              </p>
            ) : null}
            {canCreateTeamWorkspace && !projectFeaturesEnabled ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t('projectFeatureNotEnabled')}
              </p>
            ) : null}

            {error ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              {t('createDialog.cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting || !name.trim()}>
              {isSubmitting ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Plus data-icon="inline-start" />
              )}
              {t('createWorkspace')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
