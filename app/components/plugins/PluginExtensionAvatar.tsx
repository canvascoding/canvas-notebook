'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

export type PluginExtensionAvatarIcon = { url: string; sourceKey: string };
export type PluginExtensionAvatarProps = {
  name: string;
  /** Exact resource/selection and workspace; never the displayed name. */
  identity: string;
  icon?: PluginExtensionAvatarIcon;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
};

function safeIconUrl(value: string): string | null {
  if (!value || value.length > 4096 || value.trim() !== value || /[\u0000-\u001f\u007f\\]/u.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//')) {
    const url = new URL(value, 'https://canvas.invalid');
    if (url.hash || url.origin !== 'https://canvas.invalid') return null;
    return /^\/api\/capabilities\/packages\/[^/]+\/icon$/u.test(url.pathname)
      || /^\/api\/capabilities\/packages\/drafts\/[^/]+\/image$/u.test(url.pathname)
      || /^\/api\/plugins\/store\/icon$/u.test(url.pathname)
      || /^\/api\/skills\/store\/icon$/u.test(url.pathname)
      || /^\/api\/integrations\/mcp-icon\/[^/]+$/u.test(url.pathname)
      || /^\/api\/plugins\/mcp-icons\/[^/]+$/u.test(url.pathname)
      || url.pathname === '/api/agents/extension-options/icon'
      || /^\/images\/agents\/origami\/[a-z0-9-]+\.svg$/u.test(url.pathname) ? value : null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : null;
  } catch { return null; }
}

function nameInitials(name: string): string {
  const words = name.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  const graphemes = (value: string) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), part => part.segment);
  const letters = words.length > 1 ? [graphemes(words[0] ?? '')[0], graphemes(words[1] ?? '')[0]] : graphemes(words[0] ?? '').slice(0, 2);
  return letters.join('').toLocaleUpperCase() || '?';
}

function AvatarImage({ url, initials }: { url: string; initials: string }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  return <>
    {state !== 'loaded' ? <span data-testid="plugin-extension-avatar-initials">{initials}</span> : null}
    {state !== 'failed' ?
      // Provider and package assets need their authenticated/source-bound URLs, without Next's public optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
        className={cn('absolute inset-0 size-full object-contain p-1', state !== 'loaded' && 'opacity-0')}
        data-testid="plugin-extension-avatar-image" onLoad={() => setState('loaded')} onError={() => setState('failed')} /> : null}
  </>;
}

/** Adjacent visible names provide the accessible label; the avatar is decorative. */
export function PluginExtensionAvatar({ name, identity, icon, size = 'md', className }: PluginExtensionAvatarProps) {
  const url = icon ? safeIconUrl(icon.url) : null;
  const initials = nameInitials(name);
  const binding = JSON.stringify([identity, icon?.sourceKey ?? '', url]);
  return <span aria-hidden="true" data-testid="plugin-extension-avatar" data-identity={identity} data-source-key={icon?.sourceKey}
    className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/50 font-medium text-muted-foreground select-none',
      size === 'sm' ? 'size-8 text-xs' : size === 'lg' ? 'size-12 rounded-xl text-base' : 'size-10 text-sm', className)}>
    {url ? <AvatarImage key={binding} url={url} initials={initials} /> : <span data-testid="plugin-extension-avatar-initials">{initials}</span>}
  </span>;
}
