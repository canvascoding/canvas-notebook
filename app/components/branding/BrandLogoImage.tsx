'use client';

import Image from 'next/image';
import type { ComponentProps } from 'react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

export type BrandLogoImageProps = Omit<ComponentProps<typeof Image>, 'src'> & {
  logoUrl: string | null;
  fallbackSrc?: string;
  fallbackClassName?: string;
  brandClassName?: string;
};

export function BrandLogoImage({
  alt,
  brandClassName,
  className,
  fallbackClassName,
  fallbackSrc = '/images/bradley/bradley-icon.svg',
  logoUrl,
  ...imageProps
}: BrandLogoImageProps) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const usesBrandLogo = Boolean(logoUrl && failedLogoUrl !== logoUrl);
  const src = usesBrandLogo && logoUrl ? logoUrl : fallbackSrc;

  return (
    <Image
      {...imageProps}
      src={src}
      alt={alt}
      className={cn(
        className,
        usesBrandLogo ? brandClassName : fallbackClassName,
      )}
      unoptimized={usesBrandLogo || imageProps.unoptimized}
      onError={(event) => {
        imageProps.onError?.(event);
        if (usesBrandLogo && logoUrl) setFailedLogoUrl(logoUrl);
      }}
      data-brand-logo={usesBrandLogo ? 'custom' : 'canvas'}
    />
  );
}
