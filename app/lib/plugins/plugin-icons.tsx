'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';

export type CanvasPluginIconSource = {
  name: string;
  version?: string;
  description?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    brandColor?: string;
    icon?: string;
    logo?: string;
  };
};

function normalizeAssetPath(assetPath?: string): string | null {
  const normalized = assetPath?.trim();
  if (!normalized) return null;
  return normalized.replace(/^\.\//, '').replace(/^\/+/, '');
}

function resolvePluginAssetUrl(plugin: CanvasPluginIconSource, assetPath?: string): string | null {
  const normalized = normalizeAssetPath(assetPath);
  if (!normalized) return null;

  if (/^https?:\/\//i.test(normalized) || normalized.startsWith('data:')) {
    return normalized;
  }

  return `/api/plugins/asset?plugin=${encodeURIComponent(plugin.name)}&path=${encodeURIComponent(normalized)}`;
}

function getPluginInitials(plugin: CanvasPluginIconSource): string {
  const label = plugin.interface?.displayName || plugin.name;
  const words = label
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return '?';
  }

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function isSafeHexColor(value?: string): value is string {
  return Boolean(value && /^#[0-9a-f]{6}$/i.test(value));
}

function CanvasPluginInitialsIcon({
  className,
  plugin,
}: {
  className?: string;
  plugin: CanvasPluginIconSource;
}) {
  const brandColor = plugin.interface?.brandColor;
  const colorStyle = isSafeHexColor(brandColor)
    ? { backgroundColor: brandColor, color: '#fff', borderColor: brandColor }
    : undefined;

  return (
    <span
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-primary/10 text-xs font-semibold uppercase text-primary',
        'leading-none',
        className,
      )}
      style={colorStyle}
      aria-hidden="true"
    >
      {getPluginInitials(plugin)}
    </span>
  );
}

export function CanvasPluginIcon({
  className,
  imageClassName,
  plugin,
}: {
  className?: string;
  imageClassName?: string;
  plugin: CanvasPluginIconSource;
}) {
  const [failed, setFailed] = useState(false);
  const iconPath = plugin.interface?.icon || plugin.interface?.logo;
  const iconUrl = failed ? null : resolvePluginAssetUrl(plugin, iconPath);

  if (iconUrl) {
    return (
      <span
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-background',
          className,
        )}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- Plugin assets are local runtime files served through an authenticated API route. */}
        <img
          src={iconUrl}
          alt=""
          className={cn('h-full w-full object-cover', imageClassName)}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return <CanvasPluginInitialsIcon plugin={plugin} className={className} />;
}
