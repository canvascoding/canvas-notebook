'use client';

import {
  BrandLogoImage,
  type BrandLogoImageProps,
} from '@/app/components/branding/BrandLogoImage';
import { useWorkspaceBranding } from '@/app/components/workspaces/WorkspaceBrandingContext';

type WorkspaceBrandLogoProps = Omit<BrandLogoImageProps, 'brandClassName' | 'logoUrl'> & {
  workspaceClassName?: string;
};

export function WorkspaceBrandLogo({
  workspaceClassName,
  ...props
}: WorkspaceBrandLogoProps) {
  const { logoUrl } = useWorkspaceBranding();

  return (
    <BrandLogoImage
      {...props}
      logoUrl={logoUrl}
      brandClassName={workspaceClassName}
    />
  );
}
