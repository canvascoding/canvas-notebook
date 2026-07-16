'use client';

import Image from 'next/image';
import type { ComponentProps } from 'react';
import { useState } from 'react';

import { useWorkspaceBranding } from '@/app/components/workspaces/WorkspaceBrandingContext';
import { cn } from '@/lib/utils';

type WorkspaceBrandLogoProps = Omit<ComponentProps<typeof Image>, 'src'> & {
  fallbackSrc?: string;
  fallbackClassName?: string;
  workspaceClassName?: string;
};

export function WorkspaceBrandLogo({
  alt,
  className,
  fallbackClassName,
  fallbackSrc = '/logo.jpg',
  workspaceClassName,
  ...imageProps
}: WorkspaceBrandLogoProps) {
  const { logoUrl } = useWorkspaceBranding();
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const usesWorkspaceLogo = Boolean(logoUrl && failedLogoUrl !== logoUrl);
  const src = usesWorkspaceLogo && logoUrl ? logoUrl : fallbackSrc;

  return (
    <Image
      {...imageProps}
      src={src}
      alt={alt}
      className={cn(
        className,
        usesWorkspaceLogo ? workspaceClassName : fallbackClassName,
      )}
      unoptimized={usesWorkspaceLogo || imageProps.unoptimized}
      onError={(event) => {
        imageProps.onError?.(event);
        if (usesWorkspaceLogo && logoUrl) setFailedLogoUrl(logoUrl);
      }}
      data-workspace-brand-logo={usesWorkspaceLogo ? 'custom' : 'canvas'}
    />
  );
}
