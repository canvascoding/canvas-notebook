'use client';

import {
  BrandLogoImage,
  type BrandLogoImageProps,
} from '@/app/components/branding/BrandLogoImage';

type PublicBrandLogoProps = Omit<BrandLogoImageProps, 'logoUrl'>;

export function PublicBrandLogo(props: PublicBrandLogoProps) {
  return (
    <BrandLogoImage
      {...props}
      logoUrl="/api/public/brand/logo"
    />
  );
}
