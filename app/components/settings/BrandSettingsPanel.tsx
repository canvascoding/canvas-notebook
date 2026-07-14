'use client';

import { startTransition, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, FileText, Loader2, Palette, RotateCcw, Save, ShieldCheck, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  WORKSPACE_BRAND_FONT_IDS,
  WORKSPACE_BRAND_HEADING_STYLES,
  WORKSPACE_BRAND_PAGE_SIZES,
  WORKSPACE_BRAND_PRESETS,
  cloneWorkspaceBrandProfile,
  type WorkspaceBrandFontId,
  type WorkspaceBrandHeadingStyle,
  type WorkspaceBrandPageSize,
  type WorkspaceBrandProfile,
  type WorkspaceBrandProfileState,
} from '@/app/lib/workspaces/brand-profile';
import { workspaceBrandFontStack } from '@/app/lib/pdf/markdown-brand';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { cn } from '@/lib/utils';

type BrandApiResponse = WorkspaceBrandProfileState & {
  success: boolean;
  canManage: boolean;
  error?: string;
};

type PresetId = keyof typeof WORKSPACE_BRAND_PRESETS;

const PRESET_IDS = Object.keys(WORKSPACE_BRAND_PRESETS) as PresetId[];

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ColorField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2 rounded-md border border-input bg-background p-1 shadow-xs focus-within:ring-[3px] focus-within:ring-ring/50">
        <input
          id={id}
          type="color"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-7 w-9 cursor-pointer rounded border-0 bg-transparent p-0 disabled:cursor-not-allowed"
        />
        <Input
          value={value}
          disabled={disabled}
          maxLength={7}
          onChange={(event) => onChange(event.target.value)}
          className="h-7 border-0 px-1 font-mono text-xs uppercase shadow-none focus-visible:ring-0"
          aria-label={label}
        />
      </div>
    </div>
  );
}

function NativeSelect({
  value,
  disabled,
  ariaLabel,
  onChange,
  children,
}: {
  value: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </select>
  );
}

function headingPreviewStyle(
  style: WorkspaceBrandHeadingStyle,
  profile: WorkspaceBrandProfile,
): CSSProperties {
  if (style === 'accent-bar') {
    return {
      borderLeft: `4px solid ${profile.colors.accent}`,
      paddingLeft: '0.55em',
    };
  }
  if (style === 'underline') {
    return {
      borderBottom: `${profile.enabled ? 2 : 1}px solid ${profile.enabled ? profile.colors.accent : profile.colors.border}`,
      paddingBottom: '0.3em',
    };
  }
  return {};
}

function BrandDocumentPreview({ profile }: { profile: WorkspaceBrandProfile }) {
  const t = useTranslations('settings.brandDesign.preview');
  const pageRatio = profile.page.size === 'Letter' ? 'aspect-[8.5/11]' : 'aspect-[210/297]';
  const previewPadding = `${Math.max(18, profile.page.verticalMarginMm * 1.1)}px ${Math.max(16, profile.page.horizontalMarginMm * 1.1)}px`;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border/80 bg-[radial-gradient(circle_at_top_left,hsl(var(--muted))_0,transparent_52%)] p-3 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <FileText className="h-3.5 w-3.5" />
          {t('label')}
        </div>
        <Badge variant={profile.enabled ? 'default' : 'secondary'}>
          {profile.enabled ? t('active') : t('inactive')}
        </Badge>
      </div>

      <article
        className={cn('mx-auto w-full max-w-[430px] overflow-hidden rounded-sm shadow-[0_20px_55px_rgba(15,23,42,0.17)]', pageRatio)}
        style={{
          backgroundColor: profile.page.backgroundColor,
          color: profile.colors.text,
          fontFamily: workspaceBrandFontStack(profile.typography.bodyFont),
          fontSize: `${Math.max(8, profile.typography.bodySizePt * 0.72)}px`,
          lineHeight: profile.typography.lineHeight,
          padding: previewPadding,
        }}
      >
        {profile.brandName || profile.logoPath ? (
          <div
            className="mb-7 flex items-center gap-2 border-b pb-3"
            style={{ borderColor: profile.colors.border }}
          >
            {profile.logoPath ? (
              <div
                className="flex h-7 w-7 items-center justify-center rounded text-[7px] font-bold uppercase"
                style={{ backgroundColor: profile.colors.accent, color: profile.page.backgroundColor }}
              >
                Logo
              </div>
            ) : null}
            <span
              className="text-[8px] font-semibold uppercase tracking-[0.16em]"
              style={{
                color: profile.colors.heading,
                fontFamily: workspaceBrandFontStack(profile.typography.headingFont),
              }}
            >
              {profile.brandName || t('brandFallback')}
            </span>
          </div>
        ) : null}

        <p className="mb-2 text-[7px] font-semibold uppercase tracking-[0.18em]" style={{ color: profile.colors.accent }}>
          {t('eyebrow')}
        </p>
        <h1
          className="mb-4 leading-tight"
          style={{
            color: profile.colors.heading,
            fontFamily: workspaceBrandFontStack(profile.typography.headingFont),
            fontSize: `${profile.typography.h1SizePt * 0.72}px`,
            fontWeight: profile.typography.headingWeight,
            ...headingPreviewStyle(profile.typography.h1Style, profile),
          }}
        >
          {t('title')}
        </h1>
        <p className="mb-5" style={{ color: profile.colors.text }}>
          {t('intro')}
        </p>
        <h2
          className="mb-3 leading-tight"
          style={{
            color: profile.colors.heading,
            fontFamily: workspaceBrandFontStack(profile.typography.headingFont),
            fontSize: `${profile.typography.h2SizePt * 0.72}px`,
            fontWeight: profile.typography.headingWeight,
            ...headingPreviewStyle(profile.typography.h2Style, profile),
          }}
        >
          {t('section')}
        </h2>
        <div className="mb-5 grid grid-cols-2 overflow-hidden rounded border" style={{ borderColor: profile.colors.border }}>
          <div className="px-2 py-1.5 font-semibold" style={{ backgroundColor: profile.colors.tableHeaderBackground }}>
            {t('tableLabel')}
          </div>
          <div className="px-2 py-1.5 font-semibold" style={{ backgroundColor: profile.colors.tableHeaderBackground }}>
            {t('tableValue')}
          </div>
          <div className="px-2 py-1.5">{t('tableAudience')}</div>
          <div className="px-2 py-1.5" style={{ backgroundColor: profile.colors.tableStripeBackground }}>
            {profile.targetAudience || t('tableAudienceFallback')}
          </div>
        </div>
        <p
          className="rounded px-2.5 py-2 font-mono text-[7px]"
          style={{ backgroundColor: profile.colors.codeBackground, color: profile.colors.mutedText }}
        >
          {t('code')}
        </p>
        <a className="mt-4 inline-block font-semibold" style={{ color: profile.colors.link }}>
          {t('link')}
        </a>
      </article>
    </div>
  );
}

export function BrandSettingsPanel() {
  const t = useTranslations('settings.brandDesign');
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const initialized = useWorkspaceStore((state) => state.initialized);
  const isWorkspaceLoading = useWorkspaceStore((state) => state.isLoading);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const [manualWorkspaceId, setManualWorkspaceId] = useState<string | null>(null);
  const [profile, setProfile] = useState<WorkspaceBrandProfile>(() => cloneWorkspaceBrandProfile(WORKSPACE_BRAND_PRESETS.canvas));
  const [configured, setConfigured] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectedWorkspaceId = manualWorkspaceId
    || activeWorkspace?.id
    || workspaces[0]?.id
    || null;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) || null,
    [selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  const loadProfile = useCallback(async (workspaceId: string) => {
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/brand`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json() as BrandApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.load'));
      }
      setProfile(cloneWorkspaceBrandProfile(payload.profile));
      setConfigured(payload.configured);
      setCanManage(payload.canManage);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
      setCanManage(false);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    startTransition(() => { void loadProfile(selectedWorkspaceId); });
  }, [loadProfile, selectedWorkspaceId]);

  const updateProfile = (updater: (current: WorkspaceBrandProfile) => WorkspaceBrandProfile) => {
    setProfile((current) => updater(cloneWorkspaceBrandProfile(current)));
    setSuccess(null);
  };

  const applyPreset = (presetId: PresetId) => {
    const preset = cloneWorkspaceBrandProfile(WORKSPACE_BRAND_PRESETS[presetId]);
    updateProfile((current) => ({
      ...preset,
      enabled: current.enabled || preset.enabled,
      brandName: current.brandName,
      logoPath: current.logoPath,
      voice: current.voice,
      targetAudience: current.targetAudience,
      writingGuidelines: current.writingGuidelines,
    }));
  };

  const saveProfile = async () => {
    if (!selectedWorkspaceId || !canManage) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/brand`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const payload = await response.json() as BrandApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.save'));
      }
      setProfile(cloneWorkspaceBrandProfile(payload.profile));
      setConfigured(true);
      setSuccess(t('saved'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  const resetProfile = async () => {
    if (!selectedWorkspaceId || !canManage || !configured) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/brand`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json() as BrandApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.reset'));
      }
      setProfile(cloneWorkspaceBrandProfile(payload.profile));
      setConfigured(false);
      setSuccess(t('resetDone'));
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : t('errors.reset'));
    } finally {
      setIsSaving(false);
    }
  };

  const controlsDisabled = isLoading || isSaving || !canManage;

  if (isWorkspaceLoading && !initialized) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (!selectedWorkspace) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('empty.title')}</CardTitle>
          <CardDescription>{t('empty.description')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-border/80">
        <CardContent className="grid gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Palette className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold">{t('workspace.title')}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('workspace.description')}</p>
            </div>
          </div>
          <div className="w-full lg:w-72">
            <NativeSelect
              value={selectedWorkspaceId || ''}
              ariaLabel={t('workspace.select')}
              onChange={(value) => setManualWorkspaceId(value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </NativeSelect>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : null}
      {success ? (
        <p className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" />
          {success}
        </p>
      ) : null}
      {!canManage && !isLoading ? (
        <p className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          {t('readOnly')}
        </p>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(340px,0.92fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary" />
                    {t('activation.title')}
                  </CardTitle>
                  <CardDescription>{t('activation.description')}</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="brand-enabled" className="text-sm">{profile.enabled ? t('activation.on') : t('activation.off')}</Label>
                  <Switch
                    id="brand-enabled"
                    checked={profile.enabled}
                    disabled={controlsDisabled}
                    onCheckedChange={(enabled) => updateProfile((current) => ({ ...current, enabled }))}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {PRESET_IDS.map((presetId) => (
                  <Button
                    key={presetId}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={controlsDisabled}
                    onClick={() => applyPreset(presetId)}
                  >
                    {t(`presets.${presetId}`)}
                  </Button>
                ))}
              </div>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('identity.title')}</CardTitle>
              <CardDescription>{t('identity.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FieldGroup label={t('identity.brandName')}>
                <Input
                  value={profile.brandName}
                  disabled={controlsDisabled}
                  maxLength={120}
                  placeholder={t('identity.brandNamePlaceholder')}
                  onChange={(event) => updateProfile((current) => ({ ...current, brandName: event.target.value }))}
                />
              </FieldGroup>
              <FieldGroup label={t('identity.logoPath')} hint={t('identity.logoPathHint')}>
                <Input
                  value={profile.logoPath}
                  disabled={controlsDisabled}
                  maxLength={500}
                  placeholder="assets/brand/logo.png"
                  onChange={(event) => updateProfile((current) => ({ ...current, logoPath: event.target.value }))}
                />
              </FieldGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('colors.title')}</CardTitle>
              <CardDescription>{t('colors.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {([
                ['pageBackground', 'page', 'backgroundColor'],
                ['text', 'colors', 'text'],
                ['heading', 'colors', 'heading'],
                ['accent', 'colors', 'accent'],
                ['link', 'colors', 'link'],
                ['border', 'colors', 'border'],
                ['surface', 'colors', 'surface'],
                ['codeBackground', 'colors', 'codeBackground'],
                ['tableHeader', 'colors', 'tableHeaderBackground'],
              ] as const).map(([labelKey, group, field]) => {
                const value = group === 'page' ? profile.page.backgroundColor : profile.colors[field];
                return (
                  <ColorField
                    key={labelKey}
                    id={`brand-color-${labelKey}`}
                    label={t(`colors.fields.${labelKey}`)}
                    value={value}
                    disabled={controlsDisabled}
                    onChange={(color) => updateProfile((current) => {
                      if (group === 'page') {
                        return { ...current, page: { ...current.page, backgroundColor: color } };
                      }
                      return { ...current, colors: { ...current.colors, [field]: color } };
                    })}
                  />
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('typography.title')}</CardTitle>
              <CardDescription>{t('typography.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FieldGroup label={t('typography.bodyFont')}>
                <NativeSelect
                  value={profile.typography.bodyFont}
                  disabled={controlsDisabled}
                  ariaLabel={t('typography.bodyFont')}
                  onChange={(value) => updateProfile((current) => ({
                    ...current,
                    typography: { ...current.typography, bodyFont: value as WorkspaceBrandFontId },
                  }))}
                >
                  {WORKSPACE_BRAND_FONT_IDS.map((font) => <option key={font} value={font}>{t(`fonts.${font}`)}</option>)}
                </NativeSelect>
              </FieldGroup>
              <FieldGroup label={t('typography.headingFont')}>
                <NativeSelect
                  value={profile.typography.headingFont}
                  disabled={controlsDisabled}
                  ariaLabel={t('typography.headingFont')}
                  onChange={(value) => updateProfile((current) => ({
                    ...current,
                    typography: { ...current.typography, headingFont: value as WorkspaceBrandFontId },
                  }))}
                >
                  {WORKSPACE_BRAND_FONT_IDS.map((font) => <option key={font} value={font}>{t(`fonts.${font}`)}</option>)}
                </NativeSelect>
              </FieldGroup>
              {([
                ['bodySizePt', 'bodySize', 8, 16, 0.5],
                ['lineHeight', 'lineHeight', 1.2, 2, 0.05],
                ['h1SizePt', 'h1Size', 16, 36, 0.5],
                ['h2SizePt', 'h2Size', 12, 28, 0.5],
                ['headingWeight', 'headingWeight', 400, 800, 100],
              ] as const).map(([field, labelKey, min, max, step]) => (
                <FieldGroup key={field} label={t(`typography.${labelKey}`)}>
                  <Input
                    type="number"
                    value={profile.typography[field]}
                    disabled={controlsDisabled}
                    min={min}
                    max={max}
                    step={step}
                    onChange={(event) => updateProfile((current) => ({
                      ...current,
                      typography: { ...current.typography, [field]: Number(event.target.value) },
                    }))}
                  />
                </FieldGroup>
              ))}
              {(['h1Style', 'h2Style'] as const).map((field) => (
                <FieldGroup key={field} label={t(`typography.${field}`)}>
                  <NativeSelect
                    value={profile.typography[field]}
                    disabled={controlsDisabled}
                    ariaLabel={t(`typography.${field}`)}
                    onChange={(value) => updateProfile((current) => ({
                      ...current,
                      typography: { ...current.typography, [field]: value as WorkspaceBrandHeadingStyle },
                    }))}
                  >
                    {WORKSPACE_BRAND_HEADING_STYLES.map((style) => <option key={style} value={style}>{t(`headingStyles.${style}`)}</option>)}
                  </NativeSelect>
                </FieldGroup>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('page.title')}</CardTitle>
              <CardDescription>{t('page.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <FieldGroup label={t('page.size')}>
                <NativeSelect
                  value={profile.page.size}
                  disabled={controlsDisabled}
                  ariaLabel={t('page.size')}
                  onChange={(value) => updateProfile((current) => ({
                    ...current,
                    page: { ...current.page, size: value as WorkspaceBrandPageSize },
                  }))}
                >
                  {WORKSPACE_BRAND_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </NativeSelect>
              </FieldGroup>
              <FieldGroup label={t('page.verticalMargin')}>
                <Input
                  type="number"
                  value={profile.page.verticalMarginMm}
                  disabled={controlsDisabled}
                  min={10}
                  max={35}
                  step={1}
                  onChange={(event) => updateProfile((current) => ({
                    ...current,
                    page: { ...current.page, verticalMarginMm: Number(event.target.value) },
                  }))}
                />
              </FieldGroup>
              <FieldGroup label={t('page.horizontalMargin')}>
                <Input
                  type="number"
                  value={profile.page.horizontalMarginMm}
                  disabled={controlsDisabled}
                  min={10}
                  max={35}
                  step={1}
                  onChange={(event) => updateProfile((current) => ({
                    ...current,
                    page: { ...current.page, horizontalMarginMm: Number(event.target.value) },
                  }))}
                />
              </FieldGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('agent.title')}</CardTitle>
              <CardDescription>{t('agent.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldGroup label={t('agent.targetAudience')}>
                <Input
                  value={profile.targetAudience}
                  disabled={controlsDisabled}
                  maxLength={500}
                  placeholder={t('agent.targetAudiencePlaceholder')}
                  onChange={(event) => updateProfile((current) => ({ ...current, targetAudience: event.target.value }))}
                />
              </FieldGroup>
              <FieldGroup label={t('agent.voice')}>
                <Textarea
                  value={profile.voice}
                  disabled={controlsDisabled}
                  maxLength={500}
                  placeholder={t('agent.voicePlaceholder')}
                  onChange={(event) => updateProfile((current) => ({ ...current, voice: event.target.value }))}
                />
              </FieldGroup>
              <FieldGroup label={t('agent.guidelines')} hint={t('agent.guidelinesHint')}>
                <Textarea
                  value={profile.writingGuidelines}
                  disabled={controlsDisabled}
                  maxLength={2000}
                  className="min-h-28"
                  placeholder={t('agent.guidelinesPlaceholder')}
                  onChange={(event) => updateProfile((current) => ({ ...current, writingGuidelines: event.target.value }))}
                />
              </FieldGroup>
            </CardContent>
          </Card>

          <div className="flex flex-col-reverse gap-2 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              disabled={controlsDisabled || !configured}
              onClick={() => void resetProfile()}
            >
              <RotateCcw className="h-4 w-4" />
              {t('reset')}
            </Button>
            <Button
              type="button"
              disabled={controlsDisabled}
              onClick={() => void saveProfile()}
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isSaving ? t('saving') : t('save')}
            </Button>
          </div>
        </div>

        <div className="xl:sticky xl:top-6">
          <BrandDocumentPreview profile={profile} />
        </div>
      </div>
    </div>
  );
}
