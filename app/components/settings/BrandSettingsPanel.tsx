'use client';

import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlignLeft, AlignRight, Boxes, Building2, CheckCircle2, FileImage, FileText, Loader2, Monitor, Palette, RotateCcw, Save, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Upload } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SettingsAccordionCard } from '@/app/components/settings/SettingsAccordionCard';
import { WORKSPACE_APPEARANCE_UPDATED_EVENT } from '@/app/lib/workspaces/appearance-theme';
import {
  WORKSPACE_BRAND_CURATED_FONT_IDS,
  WORKSPACE_BRAND_HEADING_STYLES,
  WORKSPACE_BRAND_LOGO_POSITIONS,
  WORKSPACE_BRAND_PAGE_SIZES,
  WORKSPACE_BRAND_PRESETS,
  WORKSPACE_BRAND_STANDARD_FONT_IDS,
  cloneWorkspaceBrandProfile,
  type WorkspaceBrandFontId,
  type WorkspaceBrandHeadingStyle,
  type WorkspaceBrandLogoPosition,
  type WorkspaceBrandPageSize,
  type WorkspaceBrandProfile,
  type WorkspaceBrandProfileSource,
  type WorkspaceBrandProfileState,
} from '@/app/lib/workspaces/brand-profile';
import { workspaceBrandFontStack, workspaceBrandUiFontStack } from '@/app/lib/workspaces/brand-fonts';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { cn } from '@/lib/utils';

type BrandApiResponse = WorkspaceBrandProfileState & {
  success: boolean;
  canManage: boolean;
  error?: string;
  source?: WorkspaceBrandProfileSource;
  organizationId?: string | null;
  workspaceOverride?: WorkspaceBrandProfileState;
  organizationDefault?: WorkspaceBrandProfileState;
};

type BrandLogoApiResponse = BrandApiResponse & {
  asset?: {
    path: string;
    mimeType: string;
    size: number;
    width: number;
    height: number;
  };
};

type PresetId = keyof typeof WORKSPACE_BRAND_PRESETS;
type BrandScope = 'workspace' | 'organization';

const PRESET_IDS = Object.keys(WORKSPACE_BRAND_PRESETS) as PresetId[];

function brandPresetSignature(profile: WorkspaceBrandProfile): string {
  return JSON.stringify({
    radiusPx: profile.appearance.radiusPx,
    page: profile.page,
    typography: profile.typography,
    colors: profile.colors,
  });
}

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

function SimpleColorField({
  id,
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-lg border border-border/80 bg-background/70 p-3 transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-primary/35 hover:bg-background',
      )}
    >
      <input
        id={id}
        type="color"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-11 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-1 disabled:cursor-not-allowed"
      />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function BrandFontOptions() {
  const t = useTranslations('settings.brandDesign');
  return (
    <>
      <optgroup label={t('fontGroups.curated')}>
        {WORKSPACE_BRAND_CURATED_FONT_IDS.map((font) => <option key={font} value={font}>{t(`fonts.${font}`)}</option>)}
      </optgroup>
      <optgroup label={t('fontGroups.standard')}>
        {WORKSPACE_BRAND_STANDARD_FONT_IDS.map((font) => <option key={font} value={font}>{t(`fonts.${font}`)}</option>)}
      </optgroup>
    </>
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

function BrandLogoControl({
  logoUrl,
  position,
  disabled,
  isUploading,
  onUpload,
  onRemove,
  onPositionChange,
}: {
  logoUrl: string | null;
  position: WorkspaceBrandLogoPosition;
  disabled: boolean;
  isUploading: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  onPositionChange: (position: WorkspaceBrandLogoPosition) => void;
}) {
  const t = useTranslations('settings.brandDesign.identity.logo');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragActive, setIsDragActive] = useState(false);

  const submitFile = (file: File | undefined) => {
    if (!file || disabled || isUploading) return;
    void onUpload(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    submitFile(event.dataTransfer.files[0]);
  };

  return (
    <div className="space-y-4">
      <div
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled && !isUploading) setIsDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !isUploading) setIsDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsDragActive(false);
          }
        }}
        onDrop={handleDrop}
        aria-disabled={disabled || isUploading}
        className={cn(
          'relative grid min-h-36 gap-4 overflow-hidden rounded-xl border border-dashed p-4 transition-colors sm:grid-cols-[148px_minmax(0,1fr)] sm:items-center',
          isDragActive ? 'border-primary bg-primary/5' : 'border-border bg-muted/20',
          disabled && 'opacity-60',
        )}
      >
        {isDragActive ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/95 text-primary backdrop-blur-sm">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <Upload className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold">{t('dropNow')}</span>
          </div>
        ) : null}
        <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg border bg-background p-3 shadow-sm">
          {logoUrl ? (
            <Image
              src={logoUrl}
              alt={t('previewAlt')}
              width={240}
              height={96}
              unoptimized
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <FileImage className="h-7 w-7" />
              <span className="text-xs font-medium">{t('empty')}</span>
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-sm font-semibold">{logoUrl ? t('ready') : t('uploadTitle')}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('uploadHint')}</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
            disabled={disabled || isUploading}
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              submitFile(file);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || isUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {isUploading ? t('uploading') : logoUrl ? t('replace') : t('upload')}
            </Button>
            {logoUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || isUploading}
                onClick={() => void onRemove()}
              >
                <Trash2 className="h-4 w-4" />
                {t('remove')}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div>
          <p className="text-sm font-medium">{t('position')}</p>
          <p className="text-xs leading-5 text-muted-foreground">{t('positionHint')}</p>
        </div>
        <div className="inline-flex w-fit rounded-lg border bg-muted/30 p-1">
          {WORKSPACE_BRAND_LOGO_POSITIONS.map((value) => {
            const Icon = value === 'left' ? AlignLeft : AlignRight;
            return (
              <Button
                key={value}
                type="button"
                variant={position === value ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={position === value}
                disabled={disabled || isUploading}
                className="h-8 px-3"
                onClick={() => onPositionChange(value)}
              >
                <Icon className="h-4 w-4" />
                {t(value)}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
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

function BrandDocumentPreview({
  profile,
  logoUrl,
  brandName,
}: {
  profile: WorkspaceBrandProfile;
  logoUrl: string | null;
  brandName: string;
}) {
  const t = useTranslations('settings.brandDesign.preview');
  const pageRatio = profile.page.size === 'Letter' ? 'aspect-[8.5/11]' : 'aspect-[210/297]';
  const previewPadding = `${Math.max(18, profile.page.verticalMarginMm * 1.1)}px ${Math.max(16, profile.page.horizontalMarginMm * 1.1)}px`;
  const hasBrandLogo = Boolean(profile.logoPath && logoUrl);

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
        {hasBrandLogo || brandName ? (
          <div
            className={cn(
              'mb-7 flex h-7 items-center justify-start gap-2 border-b pb-3',
              hasBrandLogo && profile.logoPosition === 'right' && 'flex-row-reverse',
            )}
            style={{ borderColor: profile.colors.border }}
          >
            {hasBrandLogo && logoUrl ? (
              <Image
                src={logoUrl}
                alt=""
                width={112}
                height={36}
                unoptimized
                className="h-full w-auto max-w-28 shrink-0 object-contain"
              />
            ) : null}
            {brandName ? (
              <span
                className="min-w-0 truncate text-[8px] font-semibold uppercase tracking-[0.16em]"
                style={{
                  color: profile.colors.heading,
                  fontFamily: workspaceBrandFontStack(profile.typography.headingFont),
                }}
              >
                {brandName}
              </span>
            ) : null}
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

function BrandInterfacePreview({ profile }: { profile: WorkspaceBrandProfile }) {
  const t = useTranslations('settings.brandDesign.appearance.preview');
  const radius = `${profile.appearance.radiusPx}px`;
  const background = profile.page.backgroundColor;
  const text = profile.colors.text;
  const accent = profile.colors.accent;
  const border = `color-mix(in oklab, ${background} 80%, ${text})`;
  const surface = `color-mix(in oklab, ${background} 94%, ${text})`;
  const accentSurface = `color-mix(in oklab, ${background} 86%, ${accent})`;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('label')}</p>
        <Badge variant={profile.appearance.enabled ? 'default' : 'secondary'}>
          {profile.appearance.enabled ? t('active') : t('inactive')}
        </Badge>
      </div>
      <div
        role="img"
        aria-label={t('ariaLabel')}
        className="overflow-hidden border shadow-[0_18px_45px_rgba(15,23,42,0.12)]"
        style={{
          backgroundColor: background,
          borderColor: border,
          borderRadius: radius,
          color: text,
          fontFamily: workspaceBrandUiFontStack(profile.typography.bodyFont),
        }}
      >
        <div className="flex h-11 items-center justify-between border-b px-3" style={{ borderColor: border }}>
          <div className="flex items-center gap-2">
            <span className="h-5 w-5" style={{ backgroundColor: accent, borderRadius: radius }} />
            <span className="text-[11px] font-semibold">{profile.brandName || t('brandFallback')}</span>
          </div>
          <span className="border px-2 py-1 text-[9px] font-semibold" style={{ borderColor: border, borderRadius: radius }}>
            {t('workspace')}
          </span>
        </div>
        <div className="grid min-h-52 grid-cols-[82px_minmax(0,1fr)]">
          <div className="space-y-2 border-r p-2" style={{ background: surface, borderColor: border }}>
            {[0, 1, 2, 3].map((item) => (
              <span
                key={item}
                className="block h-6"
                style={{
                  background: item === 0 ? accentSurface : 'transparent',
                  borderRadius: radius,
                }}
              />
            ))}
          </div>
          <div className="p-4">
            <p className="text-[9px] font-semibold uppercase tracking-[0.16em]" style={{ color: accent }}>{t('eyebrow')}</p>
            <p className="mt-1 text-base font-semibold">{t('title')}</p>
            <p className="mt-1 max-w-[240px] text-[10px] leading-4 opacity-70">{t('description')}</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {[t('cardOne'), t('cardTwo')].map((label) => (
                <div key={label} className="border p-2.5" style={{ background: surface, borderColor: border, borderRadius: radius }}>
                  <span className="block h-1.5 w-6" style={{ background: accent, borderRadius: radius }} />
                  <span className="mt-2 block text-[10px] font-semibold">{label}</span>
                  <span className="mt-1 block h-1 w-3/4 opacity-20" style={{ background: text, borderRadius: radius }} />
                </div>
              ))}
            </div>
            <span
              className="mt-3 inline-flex px-3 py-1.5 text-[10px] font-semibold"
              style={{ background: accent, borderRadius: radius, color: '#ffffff' }}
            >
              {t('action')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BrandSettingsPanel({
  canManageOrganizationBrand = false,
}: {
  canManageOrganizationBrand?: boolean;
}) {
  const t = useTranslations('settings.brandDesign');
  const searchParams = useSearchParams();
  const requestedScope = searchParams.get('scope');
  const requestedWorkspaceId = searchParams.get('workspaceId')?.trim() || null;
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const organizationId = useWorkspaceStore((state) => state.organizationId);
  const initialized = useWorkspaceStore((state) => state.initialized);
  const isWorkspaceLoading = useWorkspaceStore((state) => state.isLoading);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const [scope, setScope] = useState<BrandScope>(() => (
    requestedScope === 'workspace' || !canManageOrganizationBrand ? 'workspace' : 'organization'
  ));
  const [manualWorkspaceId, setManualWorkspaceId] = useState<string | null>(() => requestedWorkspaceId);
  const [profile, setProfile] = useState<WorkspaceBrandProfile>(() => cloneWorkspaceBrandProfile(WORKSPACE_BRAND_PRESETS.canvas));
  const [savedProfile, setSavedProfile] = useState<WorkspaceBrandProfile>(() => cloneWorkspaceBrandProfile(WORKSPACE_BRAND_PRESETS.canvas));
  const [configured, setConfigured] = useState(false);
  const [profileSource, setProfileSource] = useState<WorkspaceBrandProfileSource>('default');
  const [profileRevision, setProfileRevision] = useState(0);
  const [loadedLogoEntityKey, setLoadedLogoEntityKey] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [isCustomizationOpen, setIsCustomizationOpen] = useState(false);
  const [isDocumentDetailsOpen, setIsDocumentDetailsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const profileLoadIdRef = useRef(0);

  const selectedWorkspaceId = manualWorkspaceId
    || activeWorkspace?.id
    || workspaces[0]?.id
    || null;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) || null,
    [selectedWorkspaceId, workspaces],
  );
  const selectedOrganizationId = organizationId
    || activeWorkspace?.organizationId
    || selectedWorkspace?.organizationId
    || null;
  const scopeEntityKey = scope === 'organization'
    ? selectedOrganizationId ? `organization:${selectedOrganizationId}` : null
    : selectedWorkspaceId ? `workspace:${selectedWorkspaceId}` : null;
  const profileEndpoint = scope === 'organization'
    ? selectedOrganizationId
      ? `/api/organizations/${encodeURIComponent(selectedOrganizationId)}/brand`
      : null
    : selectedWorkspaceId
      ? `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/brand`
      : null;
  const logoEndpoint = profileEndpoint ? `${profileEndpoint}/logo` : null;
  const logoUrl = useMemo(() => {
    if (!logoEndpoint || !scopeEntityKey || loadedLogoEntityKey !== scopeEntityKey || !profile.logoPath) return null;
    return `${logoEndpoint}?v=${profileRevision}`;
  }, [loadedLogoEntityKey, logoEndpoint, profile.logoPath, profileRevision, scopeEntityKey]);

  useEffect(() => {
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  const applyResponseState = useCallback((
    payload: BrandApiResponse,
    targetScope: BrandScope,
    entityKey: string,
  ) => {
    const directlyConfigured = targetScope === 'workspace'
      ? payload.workspaceOverride?.configured ?? payload.source === 'workspace'
      : payload.configured;
    const nextProfile = cloneWorkspaceBrandProfile(payload.profile);
    setProfile(nextProfile);
    setSavedProfile(cloneWorkspaceBrandProfile(nextProfile));
    setConfigured(Boolean(directlyConfigured));
    setProfileSource(targetScope === 'workspace'
      ? payload.source || (directlyConfigured ? 'workspace' : 'default')
      : payload.configured ? 'organization' : 'default');
    setProfileRevision(payload.revision);
    setLoadedLogoEntityKey(entityKey);
    setCanManage(payload.canManage);
  }, []);

  const loadProfile = useCallback(async (
    endpoint: string,
    entityKey: string,
    targetScope: BrandScope,
  ) => {
    const loadId = profileLoadIdRef.current + 1;
    profileLoadIdRef.current = loadId;
    setIsLoading(true);
    setLoadedLogoEntityKey(null);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(endpoint, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json() as BrandApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.load'));
      }
      if (loadId !== profileLoadIdRef.current) return;
      applyResponseState(payload, targetScope, entityKey);
    } catch (loadError) {
      if (loadId !== profileLoadIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
      setCanManage(false);
    } finally {
      if (loadId === profileLoadIdRef.current) setIsLoading(false);
    }
  }, [applyResponseState, t]);

  useEffect(() => {
    if (!profileEndpoint || !scopeEntityKey) return;
    startTransition(() => { void loadProfile(profileEndpoint, scopeEntityKey, scope); });
  }, [loadProfile, profileEndpoint, scope, scopeEntityKey]);

  const updateProfile = (updater: (current: WorkspaceBrandProfile) => WorkspaceBrandProfile) => {
    setProfile((current) => updater(cloneWorkspaceBrandProfile(current)));
    setSuccess(null);
  };

  const applyPreset = (presetId: PresetId) => {
    const preset = cloneWorkspaceBrandProfile(WORKSPACE_BRAND_PRESETS[presetId]);
    updateProfile((current) => ({
      ...preset,
      enabled: current.enabled,
      appearance: {
        ...preset.appearance,
        enabled: current.appearance.enabled,
      },
      brandName: current.brandName,
      logoPath: current.logoPath,
      logoPosition: current.logoPosition,
      voice: current.voice,
      targetAudience: current.targetAudience,
      writingGuidelines: current.writingGuidelines,
    }));
  };

  const persistProfile = async (successMessage: string) => {
    if (!profileEndpoint || !scopeEntityKey || !canManage) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(profileEndpoint, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const payload = await response.json() as BrandApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.save'));
      }
      applyResponseState(payload, scope, scopeEntityKey);
      window.dispatchEvent(new Event(WORKSPACE_APPEARANCE_UPDATED_EVENT));
      setSuccess(successMessage);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  const saveProfile = () => persistProfile(t('saved'));

  const createWorkspaceOverride = () => persistProfile(t('inheritance.overrideCreated'));

  const uploadLogo = async (file: File) => {
    if (!logoEndpoint || !scopeEntityKey || !canManage) return;
    const hasAllowedMimeType = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
    const hasAllowedExtension = /\.(?:png|jpe?g|webp)$/iu.test(file.name);
    if (!hasAllowedMimeType && !hasAllowedExtension) {
      setError(t('identity.logo.errors.type'));
      setSuccess(null);
      return;
    }
    if (file.size > 1024 * 1024) {
      setError(t('identity.logo.errors.size'));
      setSuccess(null);
      return;
    }

    setIsUploadingLogo(true);
    setError(null);
    setSuccess(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(logoEndpoint, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const payload = await response.json() as BrandLogoApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('identity.logo.errors.upload'));
      }
      applyResponseState(payload, scope, scopeEntityKey);
      window.dispatchEvent(new Event(WORKSPACE_APPEARANCE_UPDATED_EVENT));
      setSuccess(t('identity.logo.uploaded'));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t('identity.logo.errors.upload'));
    } finally {
      setIsUploadingLogo(false);
    }
  };

  const removeLogo = async () => {
    if (!logoEndpoint || !scopeEntityKey || !canManage) return;
    setIsUploadingLogo(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(logoEndpoint, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json() as BrandApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('identity.logo.errors.remove'));
      }
      applyResponseState(payload, scope, scopeEntityKey);
      window.dispatchEvent(new Event(WORKSPACE_APPEARANCE_UPDATED_EVENT));
      setSuccess(t('identity.logo.removed'));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t('identity.logo.errors.remove'));
    } finally {
      setIsUploadingLogo(false);
    }
  };

  const resetProfile = async () => {
    if (!profileEndpoint || !scopeEntityKey || !canManage || !configured) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(profileEndpoint, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json() as BrandApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.reset'));
      }
      applyResponseState(payload, scope, scopeEntityKey);
      window.dispatchEvent(new Event(WORKSPACE_APPEARANCE_UPDATED_EVENT));
      setSuccess(scope === 'workspace' ? t('inheritance.inheritedAgain') : t('resetDone'));
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : t('errors.reset'));
    } finally {
      setIsSaving(false);
    }
  };

  const isInheritedWorkspace = scope === 'workspace' && !configured;
  const activePresetId = useMemo(
    () => PRESET_IDS.find((presetId) => (
      brandPresetSignature(profile) === brandPresetSignature(WORKSPACE_BRAND_PRESETS[presetId])
    )) || null,
    [profile],
  );
  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(profile) !== JSON.stringify(savedProfile),
    [profile, savedProfile],
  );
  const controlsDisabled = isLoading
    || isSaving
    || isUploadingLogo
    || !canManage
    || isInheritedWorkspace;

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
        <CardContent className="space-y-5 p-4 sm:p-6">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Palette className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">{t('scope.title')}</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('scope.description')}</p>
              </div>
            </div>
            {canManageOrganizationBrand && selectedOrganizationId ? (
              <div className="inline-flex w-full rounded-xl border bg-muted/30 p-1 lg:w-auto">
                <Button
                  type="button"
                  variant={scope === 'organization' ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={scope === 'organization'}
                  className="flex-1 lg:flex-none"
                  onClick={() => setScope('organization')}
                >
                  <Building2 className="h-4 w-4" />
                  {t('scope.organization')}
                </Button>
                <Button
                  type="button"
                  variant={scope === 'workspace' ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={scope === 'workspace'}
                  className="flex-1 lg:flex-none"
                  onClick={() => setScope('workspace')}
                >
                  <Boxes className="h-4 w-4" />
                  {t('scope.workspace')}
                </Button>
              </div>
            ) : null}
          </div>

          {scope === 'workspace' ? (
            <div className="grid gap-3 border-t border-border/70 pt-5 sm:grid-cols-[minmax(0,1fr)_minmax(240px,288px)] sm:items-center">
              <div>
                <p className="text-sm font-semibold">{t('workspace.title')}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('workspace.description')}</p>
              </div>
              <NativeSelect
                value={selectedWorkspaceId || ''}
                ariaLabel={t('workspace.select')}
                onChange={setManualWorkspaceId}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </NativeSelect>
            </div>
          ) : (
            <div className="flex items-start gap-3 border-t border-border/70 pt-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Building2 className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-semibold">{t('organizationDefault.title')}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('organizationDefault.description')}</p>
              </div>
            </div>
          )}
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

      {scope === 'workspace' ? (
        <Card className={cn(
          'overflow-hidden',
          configured ? 'border-primary/35 bg-primary/[0.025]' : 'border-border/80',
        )}>
          <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div className="flex min-w-0 items-start gap-3">
              <span className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                configured ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              )}>
                {configured ? <Boxes className="h-4 w-4" /> : <Building2 className="h-4 w-4" />}
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">
                    {configured ? t('inheritance.overrideTitle') : t('inheritance.inheritedTitle')}
                  </p>
                  <Badge variant={configured ? 'default' : 'secondary'}>
                    {configured
                      ? t('inheritance.overrideBadge')
                      : profileSource === 'organization'
                        ? t('inheritance.organizationBadge')
                        : t('inheritance.canvasBadge')}
                  </Badge>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {configured
                    ? t('inheritance.overrideDescription')
                    : profileSource === 'organization'
                      ? t('inheritance.organizationDescription')
                      : t('inheritance.canvasDescription')}
                </p>
              </div>
            </div>
            {canManage ? (
              <Button
                type="button"
                variant={configured ? 'outline' : 'default'}
                size="sm"
                disabled={isLoading || isSaving || isUploadingLogo}
                onClick={() => void (configured ? resetProfile() : createWorkspaceOverride())}
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : configured ? <RotateCcw className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                {configured ? t('inheritance.useOrganization') : t('inheritance.createOverride')}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="overflow-hidden border-border/80">
        <CardHeader className="border-b border-border/70 bg-muted/20">
          <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <CardTitle>{t('activation.title')}</CardTitle>
                <CardDescription className="mt-1 max-w-2xl leading-6">{t('activation.description')}</CardDescription>
              </div>
            </div>
            <Badge variant={activePresetId ? 'secondary' : 'outline'} className="shrink-0 sm:mt-0.5">
              {activePresetId ? t(`presets.${activePresetId}`) : t('activation.custom')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.88fr)] lg:items-start">
          <div className="space-y-5">
            <div>
              <p className="text-sm font-semibold">{t('activation.presetTitle')}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('activation.presetDescription')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {PRESET_IDS.map((presetId) => {
                const preset = WORKSPACE_BRAND_PRESETS[presetId];
                const selected = activePresetId === presetId;
                return (
                  <button
                    key={presetId}
                    type="button"
                    aria-pressed={selected}
                    disabled={controlsDisabled}
                    className={cn(
                      'group min-w-0 rounded-lg border bg-background p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      selected
                        ? 'border-primary ring-2 ring-primary/15'
                        : 'border-border/80 hover:border-primary/35 hover:bg-muted/20',
                    )}
                    onClick={() => applyPreset(presetId)}
                  >
                    <span
                      className="flex h-10 overflow-hidden rounded-md border border-black/10"
                      style={{ backgroundColor: preset.page.backgroundColor }}
                    >
                      <span className="h-full w-3" style={{ backgroundColor: preset.colors.accent }} />
                      <span className="flex flex-1 flex-col justify-center gap-1.5 px-2">
                        <span className="h-1 w-3/4" style={{ backgroundColor: preset.colors.heading }} />
                        <span className="h-1 w-1/2 opacity-45" style={{ backgroundColor: preset.colors.text }} />
                      </span>
                    </span>
                    <span className="mt-2 flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{t(`presets.${presetId}`)}</span>
                      {selected ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-3 border-t border-border/70 pt-5">
              <div>
                <p className="text-sm font-semibold">{t('activation.usageTitle')}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('activation.usageDescription')}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label
                  htmlFor="brand-appearance-enabled"
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border/80 bg-background p-3"
                >
                  <span className="flex min-w-0 items-start gap-2.5">
                    <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{t('activation.canvasTitle')}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{t('activation.canvasDescription')}</span>
                    </span>
                  </span>
                  <Switch
                    id="brand-appearance-enabled"
                    checked={profile.appearance.enabled}
                    disabled={controlsDisabled}
                    onCheckedChange={(enabled) => updateProfile((current) => ({
                      ...current,
                      appearance: { ...current.appearance, enabled },
                    }))}
                  />
                </label>
                <label
                  htmlFor="brand-enabled"
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border/80 bg-background p-3"
                >
                  <span className="flex min-w-0 items-start gap-2.5">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{t('activation.documentsTitle')}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{t('activation.documentsDescription')}</span>
                    </span>
                  </span>
                  <Switch
                    id="brand-enabled"
                    checked={profile.enabled}
                    disabled={controlsDisabled}
                    onCheckedChange={(enabled) => updateProfile((current) => ({ ...current, enabled }))}
                  />
                </label>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">{t('activation.sharedSettings')}</p>
            </div>
          </div>
          <div className="space-y-3">
            <BrandInterfacePreview profile={profile} />
            <Button
              type="button"
              className="w-full"
              disabled={controlsDisabled || !hasUnsavedChanges}
              onClick={() => void saveProfile()}
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isSaving
                ? t('saving')
                : scope === 'organization' ? t('saveOrganization') : t('saveWorkspace')}
            </Button>
            {scope === 'organization' && configured ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={isLoading || isSaving || isUploadingLogo}
                onClick={() => void resetProfile()}
              >
                <RotateCcw className="h-4 w-4" />
                {t('reset')}
              </Button>
            ) : null}
            <p className="text-center text-xs leading-5 text-muted-foreground">
              {hasUnsavedChanges ? t('appearance.unsaved') : t('appearance.savedState')}
            </p>
          </div>
        </CardContent>
      </Card>

      <SettingsAccordionCard
        title={t('customization.title')}
        description={t('customization.description')}
        icon={SlidersHorizontal}
        isOpen={isCustomizationOpen}
        onOpenChange={setIsCustomizationOpen}
        summaryItems={[
          t('customization.colorSummary', { color: profile.colors.accent.toUpperCase() }),
          t('customization.fontSummary', { font: t(`fonts.${profile.typography.bodyFont}`) }),
          t('customization.radiusSummary', { value: profile.appearance.radiusPx }),
        ]}
        contentClassName="space-y-6"
      >
        <section className="space-y-5 border-t border-border/70 pt-5">
          <div>
            <p className="text-sm font-semibold">{t('appearance.base.title')}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('appearance.base.description')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <SimpleColorField
              id="brand-base-accent"
              label={t('appearance.colors.accent')}
              hint={t('appearance.colors.accentHint')}
              value={profile.colors.accent}
              disabled={controlsDisabled}
              onChange={(accent) => updateProfile((current) => ({
                ...current,
                colors: { ...current.colors, accent },
              }))}
            />
            <SimpleColorField
              id="brand-base-background"
              label={t('appearance.colors.background')}
              hint={t('appearance.colors.backgroundHint')}
              value={profile.page.backgroundColor}
              disabled={controlsDisabled}
              onChange={(backgroundColor) => updateProfile((current) => ({
                ...current,
                page: { ...current.page, backgroundColor },
              }))}
            />
            <SimpleColorField
              id="brand-base-text"
              label={t('appearance.colors.text')}
              hint={t('appearance.colors.textHint')}
              value={profile.colors.text}
              disabled={controlsDisabled}
              onChange={(text) => updateProfile((current) => ({
                ...current,
                colors: { ...current.colors, text },
              }))}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldGroup label={t('appearance.font')} hint={t('appearance.fontHint')}>
              <NativeSelect
                value={profile.typography.bodyFont}
                disabled={controlsDisabled}
                ariaLabel={t('appearance.font')}
                onChange={(value) => updateProfile((current) => ({
                  ...current,
                  typography: { ...current.typography, bodyFont: value as WorkspaceBrandFontId },
                }))}
              >
                <BrandFontOptions />
              </NativeSelect>
            </FieldGroup>
            <FieldGroup label={t('appearance.radius')} hint={t('appearance.radiusHint')}>
              <div className="rounded-lg border border-border/80 bg-background/70 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
                  <span>{t('appearance.radiusSquare')}</span>
                  <output htmlFor="brand-appearance-radius" className="text-foreground">
                    {t('appearance.radiusValue', { value: profile.appearance.radiusPx })}
                  </output>
                  <span>{t('appearance.radiusSoft')}</span>
                </div>
                <input
                  id="brand-appearance-radius"
                  type="range"
                  min={0}
                  max={16}
                  step={2}
                  value={profile.appearance.radiusPx}
                  disabled={controlsDisabled}
                  aria-valuetext={t('appearance.radiusValue', { value: profile.appearance.radiusPx })}
                  onChange={(event) => updateProfile((current) => ({
                    ...current,
                    appearance: { ...current.appearance, radiusPx: Number(event.target.value) },
                  }))}
                  className="mt-2 h-7 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
                />
              </div>
            </FieldGroup>
          </div>
          <p className="rounded-lg border border-primary/15 bg-primary/[0.04] px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t('appearance.modeHint')}
          </p>
        </section>

        <div className="grid items-start gap-4 border-t border-border/70 pt-6 xl:grid-cols-[minmax(0,1.08fr)_minmax(340px,0.92fr)]">
          <div className="space-y-4">

          <Card>
            <CardHeader>
              <CardTitle>{t('identity.title')}</CardTitle>
              <CardDescription>{t('identity.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <FieldGroup label={t('identity.brandName')}>
                <Input
                  value={profile.brandName}
                  disabled={controlsDisabled}
                  maxLength={120}
                  placeholder={t('identity.brandNamePlaceholder')}
                  onChange={(event) => updateProfile((current) => ({ ...current, brandName: event.target.value }))}
                />
              </FieldGroup>
              <BrandLogoControl
                logoUrl={logoUrl}
                position={profile.logoPosition}
                disabled={controlsDisabled}
                isUploading={isUploadingLogo}
                onUpload={uploadLogo}
                onRemove={removeLogo}
                onPositionChange={(logoPosition) => updateProfile((current) => ({ ...current, logoPosition }))}
              />
            </CardContent>
          </Card>

          <SettingsAccordionCard
            title={t('documentDetails.title')}
            description={t('documentDetails.description')}
            icon={SlidersHorizontal}
            isOpen={isDocumentDetailsOpen}
            onOpenChange={setIsDocumentDetailsOpen}
            summaryItems={[
              t('documentDetails.formatSummary', { format: profile.page.size }),
              t('documentDetails.fontSummary', { font: t(`fonts.${profile.typography.headingFont}`) }),
            ]}
            contentClassName="space-y-7"
          >
            <section className="space-y-4 border-t border-border/70 pt-5">
              <div>
                <p className="text-sm font-semibold">{t('colors.title')}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('colors.description')}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {([
                  ['heading', 'heading'],
                  ['link', 'link'],
                  ['border', 'border'],
                  ['surface', 'surface'],
                  ['codeBackground', 'codeBackground'],
                  ['tableHeader', 'tableHeaderBackground'],
                ] as const).map(([labelKey, field]) => (
                  <ColorField
                    key={labelKey}
                    id={`brand-color-${labelKey}`}
                    label={t(`colors.fields.${labelKey}`)}
                    value={profile.colors[field]}
                    disabled={controlsDisabled}
                    onChange={(color) => updateProfile((current) => ({
                      ...current,
                      colors: { ...current.colors, [field]: color },
                    }))}
                  />
                ))}
              </div>
            </section>

            <section className="space-y-4 border-t border-border/70 pt-5">
              <div>
                <p className="text-sm font-semibold">{t('typography.title')}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('typography.description')}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
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
                    <BrandFontOptions />
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
              </div>
            </section>

            <section className="space-y-4 border-t border-border/70 pt-5">
              <div>
                <p className="text-sm font-semibold">{t('page.title')}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('page.description')}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
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
              </div>
            </section>
          </SettingsAccordionCard>

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

        </div>

        <div className="xl:sticky xl:top-6">
          <BrandDocumentPreview
            profile={profile}
            logoUrl={logoUrl}
            brandName={profile.brandName.trim() || selectedWorkspace.name}
          />
        </div>
      </div>
      </SettingsAccordionCard>
    </div>
  );
}
