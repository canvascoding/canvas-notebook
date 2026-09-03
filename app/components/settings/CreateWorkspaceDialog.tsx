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
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceMembersEditor } from '@/app/components/settings/WorkspaceMembersEditor';
import { WorkspaceColorPicker } from '@/app/components/workspaces/WorkspaceColorPicker';
import { WorkspaceIconPicker } from '@/app/components/workspaces/WorkspaceIconPicker';
import type { ClientWorkspaceSummary, ClientWorkspaceType } from '@/app/lib/workspaces/client-types';
import { DEFAULT_WORKSPACE_COLOR, type WorkspaceColor } from '@/app/lib/workspaces/colors';
import { WORKSPACE_DESCRIPTION_MAX_LENGTH } from '@/app/lib/workspaces/description';
import { getDefaultWorkspaceIcon, type WorkspaceIcon } from '@/app/lib/workspaces/icons';

type CreateWorkspaceType = Extract<ClientWorkspaceType, 'personal' | 'organization' | 'team' | 'project'>;

type ProjectOption = {
  id: string;
  name: string;
  workspaceId?: string | null;
};

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canCreateSharedWorkspace: boolean;
  hasOrganizationWorkspace: boolean;
  teamFeaturesEnabled: boolean;
  projectFeaturesEnabled: boolean;
  onCreated: (workspace: ClientWorkspaceSummary) => void | Promise<void>;
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  canCreateSharedWorkspace,
  hasOrganizationWorkspace,
  teamFeaturesEnabled,
  projectFeaturesEnabled,
  onCreated,
}: CreateWorkspaceDialogProps) {
  const t = useTranslations('settings.workspacePanel.management');
  const workspaceTypesT = useTranslations('workspaces.types');
  const nameId = useId();
  const descriptionId = useId();
  const typeId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<CreateWorkspaceType>('personal');
  const [icon, setIcon] = useState<WorkspaceIcon>(getDefaultWorkspaceIcon('personal'));
  const [color, setColor] = useState<WorkspaceColor>(DEFAULT_WORKSPACE_COLOR);
  const [iconCustomized, setIconCustomized] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdWorkspace, setCreatedWorkspace] = useState<ClientWorkspaceSummary | null>(null);

  const loadProjects = useCallback(async () => {
    if (!open || !projectFeaturesEnabled || !canCreateSharedWorkspace) return;
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
  }, [canCreateSharedWorkspace, open, projectFeaturesEnabled]);

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
    if (canCreateSharedWorkspace) {
      options.push({
        value: 'organization',
        label: workspaceTypesT('organization'),
        disabled: !teamFeaturesEnabled || hasOrganizationWorkspace,
      });
      options.push({
        value: 'team',
        label: workspaceTypesT('team'),
        disabled: !teamFeaturesEnabled,
      });
    }
    if (canCreateSharedWorkspace && projectFeaturesEnabled) {
      options.push({
        value: 'project',
        label: workspaceTypesT('project'),
        disabled: projectsLoading || availableProjects.length === 0,
      });
    }
    return options;
  }, [
    availableProjects.length,
    canCreateSharedWorkspace,
    hasOrganizationWorkspace,
    projectFeaturesEnabled,
    projectsLoading,
    teamFeaturesEnabled,
    workspaceTypesT,
  ]);

  const resetForm = () => {
    setName('');
    setDescription('');
    setType('personal');
    setIcon(getDefaultWorkspaceIcon('personal'));
    setColor(DEFAULT_WORKSPACE_COLOR);
    setIconCustomized(false);
    setProjectId('');
    setCreatedWorkspace(null);
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
    const trimmedDescription = description.trim();
    if (trimmedDescription.length > WORKSPACE_DESCRIPTION_MAX_LENGTH) {
      setError(t('errors.descriptionTooLong', { max: WORKSPACE_DESCRIPTION_MAX_LENGTH }));
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
        body: JSON.stringify({
          name: trimmedName,
          description: trimmedDescription,
          type,
          icon,
          color,
          projectId: type === 'project' ? projectId : undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success || !payload.workspace) {
        const key = payload.code === 'WORKSPACE_ORGANIZATION_ALREADY_EXISTS'
          ? 'errors.organizationAlreadyExists'
          : null;
        throw new Error(key ? t(key) : payload.error || t('errors.createFailed'));
      }
      const workspace = payload.workspace as ClientWorkspaceSummary;
      await onCreated(workspace);
      if (workspace.type === 'team' || workspace.type === 'project') {
        setCreatedWorkspace(workspace);
      } else {
        resetForm();
        onOpenChange(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errors.createFailed');
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={createdWorkspace ? "!flex max-h-[calc(100dvh-2rem)] !w-[min(100%_-_2rem,_48rem)] !max-w-none !flex-col !gap-0 !overflow-hidden !p-0 sm:!max-w-none" : undefined}>
        {createdWorkspace ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="border-b border-border px-5 py-5 pr-12 sm:px-6 sm:pr-14">
              <DialogTitle>{t('createDialog.accessTitle', { name: createdWorkspace.name })}</DialogTitle>
              <DialogDescription>{t('createDialog.accessDescription')}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <WorkspaceMembersEditor
                key={createdWorkspace.id}
                active={open}
                workspace={createdWorkspace}
                onChanged={() => onCreated(createdWorkspace)}
              />
            </div>
            <DialogFooter className="border-t border-border px-5 py-4 sm:px-6">
              <Button type="button" onClick={() => handleOpenChange(false)}>
                {t('createDialog.done')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
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
              <Label htmlFor={descriptionId}>{t('fields.description')}</Label>
              <Textarea
                id={descriptionId}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={WORKSPACE_DESCRIPTION_MAX_LENGTH}
                rows={3}
                disabled={isSubmitting}
                aria-describedby={`${descriptionId}-hint ${descriptionId}-count`}
                placeholder={t('fields.descriptionPlaceholder')}
              />
              <div className="flex items-start justify-between gap-4 text-xs text-muted-foreground">
                <p id={`${descriptionId}-hint`}>
                  {t('fields.descriptionHint')}
                </p>
                <span id={`${descriptionId}-count`} className="shrink-0 tabular-nums" aria-live="polite">
                  {t('fields.descriptionCount', {
                    count: description.length,
                    max: WORKSPACE_DESCRIPTION_MAX_LENGTH,
                  })}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={typeId}>{t('fields.type')}</Label>
              <select
                id={typeId}
                value={type}
                onChange={(event) => {
                  const nextType = event.target.value as CreateWorkspaceType;
                  setType(nextType);
                  if (!iconCustomized) setIcon(getDefaultWorkspaceIcon(nextType));
                }}
                className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {availableTypes.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {type === 'organization'
                  ? hasOrganizationWorkspace
                    ? t('hints.organizationAlreadyExists')
                    : t('hints.organizationAccess')
                  : type === 'team' || type === 'project'
                    ? t('hints.teamProjectAccess')
                    : t('hints.personalOnly')}
              </p>
            </div>

            <WorkspaceIconPicker
              value={icon}
              onChange={(nextIcon) => {
                setIcon(nextIcon);
                setIconCustomized(true);
              }}
              disabled={isSubmitting}
            />

            <WorkspaceColorPicker value={color} onChange={setColor} disabled={isSubmitting} />

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

            {canCreateSharedWorkspace && !teamFeaturesEnabled ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t('teamFeatureNotEnabled')}
              </p>
            ) : null}
            {canCreateSharedWorkspace && teamFeaturesEnabled && hasOrganizationWorkspace ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t('hints.organizationAlreadyExists')}
              </p>
            ) : null}
            {canCreateSharedWorkspace && !projectFeaturesEnabled ? (
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
        )}
      </DialogContent>
    </Dialog>
  );
}
